const express = require('express');
const { db, addLog } = require('../db');
const { call } = require('../esClient');
const { makeDocument } = require('../ragDocGenerator');

const router = express.Router();

// Dylan님이 주신 rag-vectors 인덱스 스펙을 기본값으로 사용 (dims/similarity만 파라미터화)
function buildDefaultIndexBody(dims, similarity) {
  return {
    settings: {
      number_of_shards: 5,
      number_of_replicas: 1,
      index: {
        soft_deletes: { enabled: true },
        refresh_interval: '30s',
        codec: 'best_compression',
      },
      analysis: {
        analyzer: {
          content_analyzer: {
            type: 'custom',
            tokenizer: 'standard',
            filter: ['lowercase', 'stop', 'snowball'],
          },
        },
      },
    },
    mappings: {
      properties: {
        doc_id: { type: 'keyword', doc_values: true },
        chunk_id: { type: 'keyword', doc_values: true },
        source: { type: 'keyword', doc_values: true },
        category: { type: 'keyword', doc_values: true },
        title: {
          type: 'text',
          analyzer: 'content_analyzer',
          fields: { keyword: { type: 'keyword', ignore_above: 512 } },
        },
        content: { type: 'text', analyzer: 'content_analyzer' },
        embedding: {
          type: 'dense_vector',
          dims,
          index: true,
          similarity,
          index_options: { type: 'hnsw', m: 16, ef_construction: 200 },
        },
        metadata: {
          type: 'object',
          properties: {
            doc_title: { type: 'text', fields: { keyword: { type: 'keyword' } } },
            section: { type: 'keyword' },
            subsection: { type: 'keyword' },
            page_num: { type: 'integer' },
            chunk_index: { type: 'integer' },
            total_chunks: { type: 'integer' },
            char_count: { type: 'integer' },
            token_estimate: { type: 'integer' },
            language: { type: 'keyword' },
            version: { type: 'keyword' },
            url: { type: 'keyword', index: false },
          },
        },
        tags: { type: 'keyword' },
        created_at: { type: 'date', format: 'strict_date_optional_time||epoch_millis' },
      },
    },
  };
}

/**
 * 샘플 벡터(rag-vectors) 인덱스 생성 + 시드 문서 삽입
 * body: {
 *   clusterId, indexName(기본 rag-vectors), dims(기본 768), similarity(기본 cosine),
 *   seedDocs(기본 0), batchSize(기본 200), offset(기본 0),
 *   insertMode('bulk'(기본)|'individual' - 사내 보안 게이트웨이가 _bulk 경로를 차단하는 경우 individual 선택),
 *   customBody (선택: 직접 붙여넣은 settings/mappings JSON 문자열 - 있으면 이걸 그대로 사용)
 * }
 */
router.post('/sample-index', async (req, res) => {
  const {
    clusterId, indexName, dims, similarity,
    seedDocs, batchSize, offset, customBody, insertMode,
  } = req.body;

  const cluster = db.get('clusters').find({ id: clusterId }).value();
  if (!cluster) return res.status(404).json({ error: 'cluster not found' });

  const dimsNum = Number(dims) || 768;
  const idxName = indexName || 'rag-vectors';
  const log = [];

  let indexBody;
  if (customBody) {
    try {
      indexBody = JSON.parse(customBody);
    } catch (e) {
      return res.status(400).json({ error: `customBody JSON 파싱 실패: ${e.message}` });
    }
  } else {
    indexBody = buildDefaultIndexBody(dimsNum, similarity || 'cosine');
  }

  const createResult = await call(cluster, 'PUT', `/${idxName}`, indexBody, {
    label: `벡터 인덱스 생성 (${idxName}, dims=${dimsNum})`,
  });
  log.push({ step: 'create_index', ...createResult });

  const seedCount = Number(seedDocs) || 0;
  const batch = Math.max(Number(batchSize) || 200, 1);
  const startOffset = Number(offset) || 0;
  const mode = insertMode === 'individual' ? 'individual' : 'bulk';

  if (createResult.ok && seedCount > 0 && mode === 'individual') {
    // _bulk 경로 자체를 차단하는 사내 보안 게이트웨이(예: Skyhigh/McAfee Web Gateway)를 우회하기 위해
    // 문서를 한 건씩 PUT /{index}/_doc/{id}로 삽입합니다. 느리지만 _bulk를 아예 안 씀.
    const CONCURRENCY = 10;
    let inserted = 0;
    let failedCount = 0;
    let firstFailure = null;
    for (let start = 0; start < seedCount; start += CONCURRENCY) {
      const chunkSize = Math.min(CONCURRENCY, seedCount - start);
      const results = await Promise.all(
        Array.from({ length: chunkSize }, (_, i) => {
          const idx = start + i;
          const { chunkId, doc } = makeDocument(idx, startOffset, dimsNum);
          return call(cluster, 'PUT', `/${idxName}/_doc/${encodeURIComponent(chunkId)}`, doc, {
            label: `개별 문서 삽입 (${idx + 1}/${seedCount})`,
          });
        }),
      );
      results.forEach((r) => {
        if (r.ok) inserted += 1;
        else { failedCount += 1; if (!firstFailure) firstFailure = r; }
      });
      if (start === 0) {
        // 개별 요청 200건을 로그에 다 남기면 너무 커지므로, 첫 배치의 대표 결과 1건만 예시로 남김
        log.push({ step: 'seed_individual_sample', ...results[0], note: `개별 삽입 모드 — 대표로 첫 요청 1건만 표시 (총 ${seedCount}건 진행)` });
      }
    }
    log.push({
      step: 'seed_summary', mode: 'individual', totalRequested: seedCount,
      totalInserted: inserted, totalFailed: failedCount,
      firstFailure: firstFailure ? { status: firstFailure.status, response: firstFailure.response } : null,
    });
  } else if (createResult.ok && seedCount > 0) {
    let inserted = 0;
    let batchNum = 0;
    while (inserted < seedCount) {
      const thisBatchSize = Math.min(batch, seedCount - inserted);
      const lines = [];
      for (let i = 0; i < thisBatchSize; i++) {
        const { chunkId, doc } = makeDocument(inserted + i, startOffset, dimsNum);
        lines.push(JSON.stringify({ index: { _index: idxName, _id: chunkId } }));
        lines.push(JSON.stringify(doc));
      }
      batchNum += 1;
      const bulkBody = lines.join('\n') + '\n';
      const bulkResult = await call(cluster, 'POST', '/_bulk', bulkBody, {
        label: `rag-vectors 시드 데이터 삽입 배치 #${batchNum} (${thisBatchSize}건)`,
      });
      log.push({ step: `seed_bulk_batch_${batchNum}`, ...bulkResult, batchSize: thisBatchSize });
      if (!bulkResult.ok) break;
      inserted += thisBatchSize;
    }
    log.push({ step: 'seed_summary', mode: 'bulk', totalRequested: seedCount, totalInserted: inserted });
  }

  addLog({ action: 'create_sample_index', clusterId, detail: { indexName: idxName, dims: dimsNum, seedCount, mode } });

  res.json({ log });
});

// 문서 수 조회 (검증용)
router.get('/:clusterId/:indexName/count', async (req, res) => {
  const cluster = db.get('clusters').find({ id: req.params.clusterId }).value();
  if (!cluster) return res.status(404).json({ error: 'cluster not found' });
  const result = await call(cluster, 'GET', `/${req.params.indexName}/_count`, undefined, { label: '문서 수 조회' });
  res.json(result);
});

/**
 * "완성된 API 보기" 다이얼로그용 - 실제 실행 없이, 지금 입력값 기준으로
 * 나갈 요청(인덱스 생성 body / 시드 삽입 _bulk 예시)을 그대로 만들어서 보여줍니다.
 * 실제 sample-index 라우트와 완전히 같은 로직(buildDefaultIndexBody, makeDocument)을 써서
 * 미리보기와 실제 실행 결과가 어긋나지 않게 합니다.
 */
router.post('/preview', (req, res) => {
  const { indexName, dims, similarity, seedDocs, batchSize, offset, customBody } = req.body;
  const dimsNum = Number(dims) || 768;
  const idxName = indexName || 'rag-vectors';

  let indexBody = null;
  let indexBodyError = null;
  if (customBody) {
    try { indexBody = JSON.parse(customBody); } catch (e) { indexBodyError = e.message; }
  } else {
    indexBody = buildDefaultIndexBody(dimsNum, similarity || 'cosine');
  }

  const seedCount = Number(seedDocs) || 0;
  const batch = Math.max(Number(batchSize) || 200, 1);
  const startOffset = Number(offset) || 0;
  const totalBatches = seedCount > 0 ? Math.ceil(seedCount / batch) : 0;

  let sampleBody = '';
  if (seedCount > 0) {
    const sampleSize = Math.min(2, batch, seedCount);
    const lines = [];
    for (let i = 0; i < sampleSize; i++) {
      const { chunkId, doc } = makeDocument(i, startOffset, dimsNum);
      lines.push(JSON.stringify({ index: { _index: idxName, _id: chunkId } }));
      lines.push(JSON.stringify(doc));
    }
    sampleBody = lines.join('\n') + '\n';
  }

  res.json({
    indexRequest: { method: 'PUT', path: `/${idxName}`, body: indexBody, error: indexBodyError },
    bulkRequest: {
      method: 'POST',
      path: '/_bulk',
      totalDocs: seedCount,
      batchSize: batch,
      totalBatches,
      sampleBody,
      note: seedCount > 0
        ? `총 ${seedCount}건을 배치당 ${batch}건씩, ${totalBatches}번의 _bulk 요청으로 나눠 보냅니다. 아래는 그 중 첫 배치의 앞부분(최대 2건) 예시입니다.`
        : '시드 문서 수가 0이라 _bulk 요청은 실행되지 않습니다 (인덱스만 생성됩니다).',
    },
  });
});

module.exports = router;

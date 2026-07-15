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
 *   customBody (선택: 직접 붙여넣은 settings/mappings JSON 문자열 - 있으면 이걸 그대로 사용)
 * }
 */
router.post('/sample-index', async (req, res) => {
  const {
    clusterId, indexName, dims, similarity,
    seedDocs, batchSize, offset, customBody,
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

  if (createResult.ok && seedCount > 0) {
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
    log.push({ step: 'seed_summary', totalRequested: seedCount, totalInserted: inserted });
  }

  addLog({ action: 'create_sample_index', clusterId, detail: { indexName: idxName, dims: dimsNum, seedCount } });

  res.json({ log });
});

// 문서 수 조회 (검증용)
router.get('/:clusterId/:indexName/count', async (req, res) => {
  const cluster = db.get('clusters').find({ id: req.params.clusterId }).value();
  if (!cluster) return res.status(404).json({ error: 'cluster not found' });
  const result = await call(cluster, 'GET', `/${req.params.indexName}/_count`, undefined, { label: '문서 수 조회' });
  res.json(result);
});

module.exports = router;

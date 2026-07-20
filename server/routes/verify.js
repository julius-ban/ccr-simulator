const express = require('express');
const { db } = require('../db');
const { call } = require('../esClient');

const router = express.Router();

function getCluster(id) {
  return db.get('clusters').find({ id }).value();
}

/**
 * 인덱스 상태 확인: 헬스, 문서 수, 매핑(주요 필드) 조회
 */
router.get('/index-check/:clusterId/:indexName', async (req, res) => {
  const cluster = getCluster(req.params.clusterId);
  if (!cluster) return res.status(404).json({ error: 'cluster not found' });
  const indexName = req.params.indexName;

  const health = await call(cluster, 'GET', `/_cluster/health/${indexName}`, undefined, { label: `인덱스 헬스 확인 (${indexName})` });
  const count = await call(cluster, 'GET', `/${indexName}/_count`, undefined, { label: `문서 수 확인 (${indexName})` });
  const mapping = await call(cluster, 'GET', `/${indexName}/_mapping`, undefined, { label: `매핑 확인 (${indexName})` });

  res.json({ health, count, mapping });
});

/**
 * 리더/팔로워(또는 임의의 두 클러스터+인덱스) 쿼리 결과 비교.
 * body: { clusterAId, indexA, clusterBId, indexB, vectorField(기본 'embedding'), k(기본 5) }
 *
 * 절차:
 *  1) 양쪽 문서 수(_count) 비교
 *  2) A에서 실제 문서 1건을 가져와 그 벡터 값을 쿼리 벡터로 사용 (임의 벡터보다 훨씬 신뢰도 높음)
 *  3) 동일한 kNN 쿼리를 A/B 양쪽에 실행해서 상위 K개 문서 ID/점수를 비교
 */
router.post('/compare-query', async (req, res) => {
  const { clusterAId, indexA, clusterBId, indexB, vectorField, k } = req.body;
  const clusterA = getCluster(clusterAId);
  const clusterB = getCluster(clusterBId);
  if (!clusterA || !clusterB) return res.status(404).json({ error: 'cluster not found' });

  const field = vectorField || 'embedding';
  const topK = Number(k) || 5;

  const countA = await call(clusterA, 'GET', `/${indexA}/_count`, undefined, { label: `문서 수 확인 (A: ${indexA})` });
  const countB = await call(clusterB, 'GET', `/${indexB}/_count`, undefined, { label: `문서 수 확인 (B: ${indexB})` });
  const countMatch = countA.ok && countB.ok && countA.response?.count === countB.response?.count;

  // A에서 실제 문서 1건을 가져와 쿼리 벡터로 사용
  const sampleDoc = await call(clusterA, 'POST', `/${indexA}/_search`, {
    size: 1,
    _source: [field],
  }, { label: `쿼리용 샘플 문서 조회 (A: ${indexA})` });

  const sampleHit = sampleDoc.response?.hits?.hits?.[0];
  const queryVector = sampleHit?._source?.[field];

  if (!queryVector) {
    return res.json({
      countA, countB, countMatch,
      knnComparable: false,
      reason: `A(${indexA})에서 "${field}" 필드를 가진 문서를 찾지 못했습니다. 인덱스가 비어있거나 필드명이 다를 수 있습니다.`,
    });
  }

  const knnBody = {
    knn: { field, query_vector: queryVector, k: topK, num_candidates: Math.max(topK * 10, 50) },
    _source: false,
  };

  const searchA = await call(clusterA, 'POST', `/${indexA}/_search`, knnBody, { label: `kNN 쿼리 실행 (A: ${indexA})` });
  const searchB = await call(clusterB, 'POST', `/${indexB}/_search`, knnBody, { label: `kNN 쿼리 실행 (B: ${indexB})` });

  const hitsA = (searchA.response?.hits?.hits || []).map((h) => ({ id: h._id, score: h._score }));
  const hitsB = (searchB.response?.hits?.hits || []).map((h) => ({ id: h._id, score: h._score }));

  const idsA = hitsA.map((h) => h.id).join(',');
  const idsB = hitsB.map((h) => h.id).join(',');
  const idsMatch = idsA === idsB && hitsA.length > 0;

  const maxScoreDiff = hitsA.reduce((max, h, i) => {
    const other = hitsB[i];
    if (!other) return max;
    return Math.max(max, Math.abs(h.score - other.score));
  }, 0);

  res.json({
    countA, countB, countMatch,
    knnComparable: true,
    sampleDocId: sampleHit?._id,
    hitsA, hitsB,
    idsMatch,
    maxScoreDiff,
    overallMatch: countMatch && idsMatch,
  });
});

module.exports = router;

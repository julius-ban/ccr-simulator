// Dylan님이 주신 insert-rag-vectors-stream.py의 메타데이터 풀/스키마를 그대로 참고해서
// Node에서도 동일한 느낌의 rag-vectors 문서를 생성합니다 (교육/시연용이라 완전 동일할 필요는 없음).

const SOURCES = [
  'elasticsearch', 'kibana', 'logstash', 'beats', 'apm',
  'postgresql', 'redis', 'kafka', 'kubernetes', 'prometheus',
];

const CATEGORIES = [
  'search-engine', 'observability', 'data-pipeline',
  'database', 'messaging', 'container-orchestration',
  'monitoring', 'security', 'backup', 'networking',
];

const SECTIONS = [
  'Installation and Setup', 'Configuration Reference', 'API Reference',
  'Security', 'Monitoring', 'Cluster Management', 'Index Management',
  'Query DSL', 'Aggregations', 'Cross-Cluster Replication',
  'Snapshot and Restore', 'Ingest Pipelines', 'Machine Learning',
  'Data Streams', 'ILM Policies',
];

const SUBSECTIONS = [
  'Overview', 'Getting Started', 'Configuration', 'Examples',
  'Best Practices', 'Troubleshooting', 'Performance Tuning',
  'Authentication', 'Authorization', 'Backup and Recovery',
  'High Availability', 'Failover', 'Load Balancing', 'TLS/SSL',
  'Metrics and Logging',
];

const TAGS_POOL = [
  'elasticsearch', 'kibana', 'cluster', 'shard', 'indexing',
  'search', 'aggregation', 'ccr', 'ilm', 'snapshot',
  'security', 'tls', 'monitoring', 'alerting', 'ingest',
  'pipeline', 'vector', 'knn', 'embedding', 'lucene',
];

const CHUNK_CONTENTS = [
  '{subsec} in {source} {version} provides a foundation for understanding the {sec} module. ' +
  'Configuration is managed through {source}.yml and cluster settings API.',
  'Cross-cluster replication (CCR) allows you to replicate indices from a leader cluster to one or ' +
  'more follower clusters. The {subsec} configuration in {source} {version} covers proxy mode and sniff mode connectivity.',
  'The {sec} section of {source} {version} documentation describes {subsec}. Dense vector fields support ' +
  'approximate nearest neighbor (ANN) search using HNSW graphs.',
  '{subsec} is a critical aspect of operating {source} {version} in production. Monitoring includes cluster ' +
  'health (green/yellow/red), node statistics, index statistics, and JVM metrics.',
  'Security hardening for {source} {version} involves configuring TLS/SSL for both HTTP and transport layers. ' +
  'The {subsec} guide covers certificate generation and role-based access control (RBAC).',
];

const VERSIONS = ['8.15.0', '8.16.0', '8.17.0', '8.17.1', '9.0.0'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickN(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function makeEmbedding(dims) {
  // 표준정규분포 근사(Box-Muller) 후 단위벡터로 정규화 -> cosine 유사도 계산에 적합
  const vec = Array.from({ length: dims }, () => {
    const u1 = Math.random() || 1e-9;
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * 0.05;
  });
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => Number((v / norm).toFixed(6)));
}

function randTimestamp() {
  const base = new Date('2026-01-01T00:00:00Z').getTime();
  const delta = randInt(0, 85) * 86400000 + randInt(0, 23) * 3600000 + randInt(0, 59) * 60000;
  return new Date(base + delta).toISOString().replace(/\.\d+Z$/, 'Z');
}

/**
 * doc + docId 반환. offset은 python 스크립트의 --offset과 동일한 개념 (doc_id 시작 번호).
 */
function makeDocument(docNum, offset, dims) {
  const source = pick(SOURCES);
  const category = pick(CATEGORIES);
  const sec = pick(SECTIONS);
  const subsec = pick(SUBSECTIONS);
  const version = pick(VERSIONS);
  const nChunks = randInt(2, 6);
  const chunkI = randInt(0, nChunks - 1);

  const docId = `doc-${String(offset + docNum).padStart(8, '0')}`;
  const chunkId = `${docId}-chunk-${String(chunkI).padStart(3, '0')}`;
  const title = `${source[0].toUpperCase()}${source.slice(1)} - ${sec} - ${subsec}`;

  const template = pick(CHUNK_CONTENTS);
  const content = `[Chunk ${chunkI + 1}/${nChunks}] ` +
    template.replace(/{source}/g, source).replace(/{sec}/g, sec).replace(/{subsec}/g, subsec).replace(/{version}/g, version);

  const tags = pickN(TAGS_POOL, randInt(2, 5));

  const doc = {
    doc_id: docId,
    chunk_id: chunkId,
    source,
    category,
    title,
    content,
    embedding: makeEmbedding(dims),
    metadata: {
      doc_title: `${source[0].toUpperCase()}${source.slice(1)} Official Documentation ${version}`,
      section: sec,
      subsection: subsec,
      page_num: randInt(1, 800),
      chunk_index: chunkI,
      total_chunks: nChunks,
      char_count: content.length,
      token_estimate: Math.floor(content.length / 4),
      language: 'en',
      version,
      url: `https://www.elastic.co/guide/en/${source}/reference/${version}/${sec.toLowerCase().replace(/ /g, '-')}.html`,
    },
    tags,
    created_at: randTimestamp(),
  };

  return { docId, chunkId, doc };
}

module.exports = { makeDocument };

const { db } = require('./db');
const { bus } = require('./eventBus');

function maskCluster(c) {
  const { encPassword, encApiKey, ...safe } = c;
  return safe;
}

function snapshot() {
  return {
    clusters: db.get('clusters').value().map(maskCluster),
    links: db.get('ccrLinks').value() || [],
  };
}

/** 클러스터/CCR 상태가 바뀔 때마다 호출 -> SSE 'state' 이벤트로 전체 스냅샷을 흘려보냄 */
function broadcastState() {
  bus.emit('state', snapshot());
}

module.exports = { snapshot, broadcastState };

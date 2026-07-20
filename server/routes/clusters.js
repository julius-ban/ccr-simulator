const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, addLog } = require('../db');
const { encrypt } = require('../crypto');
const { call } = require('../esClient');
const { broadcastState } = require('../stateBroadcast');

const router = express.Router();

function maskCluster(c) {
  // 자격증명은 절대 프론트로 내려보내지 않음
  const { encPassword, encApiKey, ...safe } = c;
  return { ...safe, hasPassword: !!encPassword, hasApiKey: !!encApiKey };
}

// 목록 조회
router.get('/', (req, res) => {
  const clusters = db.get('clusters').value().map(maskCluster);
  res.json(clusters);
});

// 등록 (주센터/DR센터 공통 - role 필드로 구분: 'primary' | 'dr')
router.post('/', (req, res) => {
  const {
    name, role, host, restPort, proxyPort, transportPort, protocol,
    authType, username, password, apiKey, insecureTLS, kibanaUrl,
  } = req.body;

  if (!name || !role || !host || !restPort) {
    return res.status(400).json({ error: 'name, role, host, restPort는 필수입니다.' });
  }
  if (!['primary', 'dr'].includes(role)) {
    return res.status(400).json({ error: "role은 'primary' 또는 'dr'이어야 합니다." });
  }

  const cluster = {
    id: uuidv4(),
    name,
    role,
    host,
    restPort: Number(restPort),
    proxyPort: Number(proxyPort) || 9443,
    transportPort: Number(transportPort) || 9300,
    protocol: protocol === 'http' ? 'http' : 'https',
    authType: authType === 'apikey' ? 'apikey' : 'basic',
    username: authType === 'apikey' ? null : username,
    encPassword: authType === 'apikey' ? null : encrypt(password),
    encApiKey: authType === 'apikey' ? encrypt(apiKey) : null,
    insecureTLS: !!insecureTLS,
    kibanaUrl: kibanaUrl || null,
    lastHealthOk: null,
    lastHealthAt: null,
    createdAt: new Date().toISOString(),
  };

  db.get('clusters').push(cluster).write();
  addLog({ action: 'register_cluster', clusterId: cluster.id, detail: { name, role, host } });
  broadcastState();

  res.status(201).json(maskCluster(cluster));
});

router.delete('/:id', (req, res) => {
  db.get('clusters').remove({ id: req.params.id }).write();
  // 이 클러스터가 관련된 CCR 링크도 같이 정리 (다이어그램에 죽은 링크가 남지 않도록)
  db.get('ccrLinks').remove((l) => l.leaderClusterId === req.params.id || l.followerClusterId === req.params.id).write();
  addLog({ action: 'delete_cluster', clusterId: req.params.id });
  broadcastState();
  res.json({ ok: true });
});

// 연결 테스트: 헬스체크 + 라이선스 확인
router.post('/:id/test', async (req, res) => {
  const cluster = db.get('clusters').find({ id: req.params.id }).value();
  if (!cluster) return res.status(404).json({ error: 'cluster not found' });

  const health = await call(cluster, 'GET', '/_cluster/health', undefined, { label: '클러스터 헬스체크' });
  const license = await call(cluster, 'GET', '/_license', undefined, { label: '라이선스 확인' });

  db.get('clusters').find({ id: cluster.id }).assign({
    lastHealthOk: health.ok,
    lastHealthAt: new Date().toISOString(),
  }).write();

  addLog({ action: 'test_cluster', clusterId: cluster.id, detail: { healthOk: health.ok, licenseOk: license.ok } });
  broadcastState();

  res.json({ health, license });
});

module.exports = router;

const express = require('express');
const { db, addLog } = require('../db');
const { call } = require('../esClient');
const { markUnfollowed } = require('../ccrState');

const router = express.Router();

function getCluster(id) {
  return db.get('clusters').find({ id }).value();
}

/**
 * Failover 실행: pause_follow -> close -> unfollow -> open
 * body: { clusterId, indexName }
 * (해당 클러스터가 지금 follower index를 들고 있는 쪽, 즉 DR 클러스터에서 호출)
 */
router.post('/failover', async (req, res) => {
  const { clusterId, indexName } = req.body;
  const cluster = getCluster(clusterId);
  if (!cluster) return res.status(404).json({ error: 'cluster not found' });

  const log = [];
  const pause = await call(cluster, 'POST', `/${indexName}/_ccr/pause_follow`, undefined, { label: 'Failover ① pause_follow' });
  log.push({ step: 'pause_follow', ...pause });
  if (!pause.ok) return res.json({ log, aborted: true });

  const close = await call(cluster, 'POST', `/${indexName}/_close`, undefined, { label: 'Failover ② close' });
  log.push({ step: 'close', ...close });
  if (!close.ok) return res.json({ log, aborted: true });

  const unfollow = await call(cluster, 'POST', `/${indexName}/_ccr/unfollow`, undefined, { label: 'Failover ③ unfollow (독립 인덱스 전환)' });
  log.push({ step: 'unfollow', ...unfollow });
  if (unfollow.ok) markUnfollowed(clusterId, indexName);
  if (!unfollow.ok) return res.json({ log, aborted: true });

  const open = await call(cluster, 'POST', `/${indexName}/_open`, undefined, { label: 'Failover ④ open (쓰기 가능 상태로 복구)' });
  log.push({ step: 'open', ...open });

  addLog({ action: 'failover', clusterId, detail: { indexName, success: open.ok } });
  res.json({ log, aborted: !open.ok });
});

/**
 * Failback 준비: 원래 리더였던 클러스터의 기존 인덱스를 삭제
 * (역방향 follower index로 다시 받기 위한 사전 작업)
 * body: { clusterId, indexName }
 */
router.post('/prepare-failback', async (req, res) => {
  const { clusterId, indexName } = req.body;
  const cluster = getCluster(clusterId);
  if (!cluster) return res.status(404).json({ error: 'cluster not found' });

  const result = await call(cluster, 'DELETE', `/${indexName}`, undefined, { label: 'Failback 준비: 기존 인덱스 삭제' });
  addLog({ action: 'prepare_failback_delete_index', clusterId, detail: { indexName, ok: result.ok } });
  res.json({ result });
});

module.exports = router;

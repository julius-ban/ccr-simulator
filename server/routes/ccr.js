const express = require('express');
const { db, addLog } = require('../db');
const { call } = require('../esClient');
const { decrypt } = require('../crypto');
const { upsertLink, removeLink } = require('../ccrState');

const router = express.Router();

function getCluster(id) {
  return db.get('clusters').find({ id }).value();
}

/**
 * 1단계: 리더 클러스터에서 Cross-Cluster API Key 발급
 * body: { leaderClusterId, remoteAlias, leaderIndex }
 */
router.post('/generate-api-key', async (req, res) => {
  const { leaderClusterId, remoteAlias, leaderIndex } = req.body;
  const leader = getCluster(leaderClusterId);
  if (!leader) return res.status(404).json({ error: 'leader cluster not found' });

  const result = await call(leader, 'POST', '/_security/cross_cluster/api_key', {
    name: `ccr-${remoteAlias}-key`,
    access: {
      search: [{ names: [leaderIndex] }],
      replication: [{ names: [leaderIndex] }],
    },
  }, { label: 'Cross-Cluster API Key 발급' });

  addLog({ action: 'generate_api_key', clusterId: leaderClusterId, detail: { remoteAlias, leaderIndex, ok: result.ok } });

  // encoded 값과, 팔로워 노드에서 실행해야 할 keystore 명령어를 같이 내려줌 (수동 실행 안내용)
  const encoded = result.response?.encoded;
  const keystoreCommand = encoded
    ? `sudo /usr/share/elasticsearch/bin/elasticsearch-keystore add cluster.remote.${remoteAlias}.credentials --stdin <<< "${encoded}"\n` +
      `curl -k -X POST -u <FOLLOWER_USER>:<FOLLOWER_PW> https://<FOLLOWER_HOST>:9200/_nodes/reload_secure_settings`
    : null;

  res.json({ result, keystoreCommand });
});

/**
 * 2단계: 팔로워 클러스터에 remote cluster 등록 (proxy 모드)
 * body: { followerClusterId, remoteAlias, leaderProxyHost, leaderProxyPort }
 * -> keystore 등록이 이미 완료되었다는 전제로 호출 (프론트에서 체크박스로 확인받음)
 */
router.post('/register-remote', async (req, res) => {
  const { followerClusterId, remoteAlias, leaderProxyHost, leaderProxyPort, serverName } = req.body;
  const follower = getCluster(followerClusterId);
  if (!follower) return res.status(404).json({ error: 'follower cluster not found' });

  const settingsResult = await call(follower, 'PUT', '/_cluster/settings', {
    persistent: {
      cluster: {
        remote: {
          [remoteAlias]: {
            mode: 'proxy',
            proxy_address: `${leaderProxyHost}:${leaderProxyPort}`,
            server_name: serverName || leaderProxyHost,
          },
        },
      },
    },
  }, { label: `Remote Cluster 등록 (proxy → ${leaderProxyHost}:${leaderProxyPort})` });

  const remoteInfoResult = await call(follower, 'GET', '/_remote/info', undefined, { label: 'Remote 연결 상태 확인' });

  addLog({
    action: 'register_remote_cluster',
    clusterId: followerClusterId,
    detail: { remoteAlias, ok: settingsResult.ok, connected: remoteInfoResult.response?.[remoteAlias]?.connected },
  });

  res.json({ settingsResult, remoteInfoResult });
});

/**
 * 3단계: follower index 생성 (_ccr/follow)
 * body: { followerClusterId, followerIndex, remoteAlias, leaderIndex }
 */
router.post('/follow', async (req, res) => {
  const { followerClusterId, followerIndex, remoteAlias, leaderIndex, leaderClusterId, direction } = req.body;
  const follower = getCluster(followerClusterId);
  if (!follower) return res.status(404).json({ error: 'follower cluster not found' });

  const result = await call(follower, 'PUT', `/${followerIndex}/_ccr/follow`, {
    remote_cluster: remoteAlias,
    leader_index: leaderIndex,
  }, { label: `Follower Index 생성 (${leaderIndex} → ${followerIndex})` });

  addLog({ action: 'ccr_follow', clusterId: followerClusterId, detail: { followerIndex, remoteAlias, leaderIndex, ok: result.ok } });

  if (result.ok && leaderClusterId) {
    upsertLink({
      leaderClusterId,
      followerClusterId,
      remoteAlias,
      leaderIndex,
      followerIndex,
      direction: direction || 'primary-to-dr',
    });
  }

  res.json({ result });
});

/**
 * CCR 복제 상태 조회 (모니터링용, 프론트에서 주기적으로 polling)
 */
router.get('/stats/:clusterId/:indexName', async (req, res) => {
  const cluster = getCluster(req.params.clusterId);
  if (!cluster) return res.status(404).json({ error: 'cluster not found' });
  const result = await call(cluster, 'GET', `/${req.params.indexName}/_ccr/stats`, undefined, { label: 'CCR 복제 상태 조회' });
  res.json(result);
});

/**
 * remote cluster 설정 제거 (역방향 정리 시 사용)
 * body: { clusterId, remoteAlias }
 */
router.post('/remove-remote', async (req, res) => {
  const { clusterId, remoteAlias, followerIndex } = req.body;
  const cluster = getCluster(clusterId);
  if (!cluster) return res.status(404).json({ error: 'cluster not found' });

  const result = await call(cluster, 'PUT', '/_cluster/settings', {
    persistent: { cluster: { remote: { [remoteAlias]: null } } },
  }, { label: `Remote Cluster 설정 제거 (${remoteAlias})` });

  addLog({ action: 'remove_remote_cluster', clusterId, detail: { remoteAlias, ok: result.ok } });
  if (result.ok && followerIndex) {
    removeLink(clusterId, followerIndex);
  }
  res.json({ result });
});

module.exports = router;

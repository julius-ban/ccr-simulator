const express = require('express');
const { db, addLog } = require('../db');
const { call, probeRemotePort } = require('../esClient');
const { decrypt } = require('../crypto');
const { upsertLink, removeLink } = require('../ccrState');

const router = express.Router();

function getCluster(id) {
  return db.get('clusters').find({ id }).value();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 1단계: 리더 클러스터에서 Cross-Cluster API Key 발급
 * body: { leaderClusterId, remoteAlias, leaderIndex, followerClusterId }
 * followerClusterId가 있으면 keystore 등록/재로드 명령어에 실제 팔로워 접속 정보를 채워줍니다.
 */
router.post('/generate-api-key', async (req, res) => {
  const { leaderClusterId, remoteAlias, leaderIndex, followerClusterId } = req.body;
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
  let keystoreCommand = null;

  if (encoded) {
    const addKeyCmd = `sudo /usr/share/elasticsearch/bin/elasticsearch-keystore add cluster.remote.${remoteAlias}.credentials --stdin <<< "${encoded}"`;

    const follower = followerClusterId ? getCluster(followerClusterId) : null;
    let reloadCmd;
    if (follower) {
      const proto = follower.protocol === 'http' ? 'http' : 'https';
      const insecureFlag = proto === 'https' ? '-k ' : '';
      if (follower.authType === 'apikey') {
        const apiKey = decrypt(follower.encApiKey);
        reloadCmd = `curl ${insecureFlag}-X POST -H "Authorization: ApiKey ${apiKey}" ${proto}://${follower.host}:${follower.restPort}/_nodes/reload_secure_settings`;
      } else {
        const pw = decrypt(follower.encPassword);
        reloadCmd = `curl ${insecureFlag}-X POST -u ${follower.username}:${pw} ${proto}://${follower.host}:${follower.restPort}/_nodes/reload_secure_settings`;
      }
    } else {
      // 팔로워를 특정할 수 없는 경우에만 플레이스홀더로 폴백
      reloadCmd = `curl -k -X POST -u <FOLLOWER_USER>:<FOLLOWER_PW> https://<FOLLOWER_HOST>:9200/_nodes/reload_secure_settings`;
    }

    keystoreCommand = `${addKeyCmd}\n${reloadCmd}`;
  }

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

  // 0단계(진단): ES REST 호출과 별개로, 리더의 remote cluster server 포트가
  // 실제로 TLS로 응답하는지 먼저 원시 소켓으로 확인합니다. 여기서 막히면
  // 리더의 remote_cluster_server.enabled/포트/방화벽 문제일 가능성이 매우 높습니다.
  const portProbe = await probeRemotePort(leaderProxyHost, Number(leaderProxyPort));

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

  // ES 레벨 연결은 설정 등록 직후 바로 안 맺어질 수 있어서, 몇 초간 재시도하며 실제로
  // connected: true로 넘어가는지 확인합니다 (한 번만 보고 끝내면 오탐이 잦음).
  let remoteInfoResult = null;
  let connected = false;
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    remoteInfoResult = await call(follower, 'GET', '/_remote/info', undefined, {
      label: `Remote 연결 상태 확인 (${attempt}/${maxAttempts})`,
    });
    connected = remoteInfoResult.response?.[remoteAlias]?.connected === true;
    if (connected || attempt === maxAttempts) break;
    await sleep(1500);
  }

  // 진단 메시지 조합: 포트 자체가 안 열려있는지, 아니면 열려있는데 ES 레벨에서만 실패하는지 구분
  let diagnosis = null;
  if (connected) {
    diagnosis = { level: 'ok', message: '정상적으로 연결되었습니다.' };
  } else if (!portProbe.reachable) {
    diagnosis = {
      level: 'error',
      message:
        `리더(${leaderProxyHost}:${leaderProxyPort})의 remote cluster server 포트 자체가 응답하지 않습니다 (${portProbe.error}). ` +
        `리더 노드의 elasticsearch.yml에 remote_cluster_server.enabled: true 및 remote_cluster.port 설정이 되어있는지, ` +
        `방화벽에 이 포트가 열려있는지, 설정 후 노드가 재시작됐는지 확인하세요.`,
    };
  } else {
    diagnosis = {
      level: 'warning',
      message:
        `포트(${leaderProxyHost}:${leaderProxyPort})는 TLS로 응답하지만(정상), ES 레벨 원격 연결은 ` +
        `${maxAttempts}번 재시도 후에도 connected: true가 되지 않았습니다. keystore에 cross-cluster API ` +
        `Key가 실제로 등록됐는지(② 단계), 인증서 신뢰 관계, server_name이 인증서와 일치하는지 확인하세요.`,
    };
  }

  addLog({
    action: 'register_remote_cluster',
    clusterId: followerClusterId,
    detail: { remoteAlias, ok: settingsResult.ok, connected, portReachable: portProbe.reachable },
  });

  res.json({ settingsResult, remoteInfoResult, portProbe, diagnosis });
});

/**
 * 3단계: follower index 생성 (_ccr/follow)
 * body: { followerClusterId, followerIndex, remoteAlias, leaderIndex }
 */
router.post('/follow', async (req, res) => {
  const { followerClusterId, followerIndex, remoteAlias, leaderIndex, leaderClusterId, direction } = req.body;
  const follower = getCluster(followerClusterId);
  if (!follower) return res.status(404).json({ error: 'follower cluster not found' });

  // follow는 내부적으로 팔로워 노드 -> 리더의 remote cluster server 포트(보통 9443) 연결이
  // 실제로 맺어져 있어야 완료됩니다. 여기서 미리 확인해서, 안 맺어져 있으면 15초 타임아웃을
  // 기다리지 않고 바로 원인을 알려줍니다.
  const remoteInfo = await call(follower, 'GET', '/_remote/info', undefined, { label: 'Follow 전 원격 연결 상태 사전 확인' });
  const connected = remoteInfo.response?.[remoteAlias]?.connected;

  if (remoteInfo.ok && connected === false) {
    const diagMsg =
      `Remote cluster '${remoteAlias}'가 아직 연결되지 않았습니다 (connected: false). ` +
      `이 경우 follow는 리더의 remote cluster server 포트(보통 9443)를 기다리다 타임아웃 납니다. ` +
      `확인해보세요: (1) 리더에 remote_cluster_server.enabled=true, remote_cluster.port 설정이 되어있는지 ` +
      `(2) 팔로워→리더 방향으로 9443(REST 9200과 별개) 포트가 열려있는지 (3) keystore에 credential이 실제로 등록됐는지.`;
    addLog({ action: 'ccr_follow', clusterId: followerClusterId, detail: { followerIndex, remoteAlias, leaderIndex, ok: false, reason: 'remote_not_connected' } });
    return res.json({
      result: { ok: false, status: 0, path: `/${followerIndex}/_ccr/follow`, method: 'PUT', response: { error: diagMsg } },
      remoteInfo,
    });
  }

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

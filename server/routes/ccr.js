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
 * authMode/connectionMode 조합에 따라 실제 _cluster/settings에 들어갈 remote 설정과
 * 포트 프로브에 쓸 host:port를 계산합니다.
 *  - apikey 인증: 항상 proxy 모드, remote_cluster_server 포트(보통 9443) 사용
 *  - cert 인증 + sniff: transport 포트(보통 9300)로 seeds 배열 구성 (여러 노드 필요)
 *  - cert 인증 + proxy: transport 포트로 단일 proxy_address 구성
 */
function buildRemoteSettings({ authMode, connectionMode, leaderHost, leaderProxyPort, leaderTransportPort, extraSeeds, serverName }) {
  if (authMode !== 'cert') {
    return {
      settings: { mode: 'proxy', proxy_address: `${leaderHost}:${leaderProxyPort}`, server_name: serverName || leaderHost },
      probeHost: leaderHost,
      probePort: Number(leaderProxyPort) || 9443,
      resolvedMode: 'proxy',
    };
  }
  if (connectionMode === 'sniff') {
    const extra = String(extraSeeds || '').split(',').map((s) => s.trim()).filter(Boolean);
    const primarySeed = `${leaderHost}:${leaderTransportPort || 9300}`;
    return {
      settings: { seeds: [primarySeed, ...extra] },
      probeHost: leaderHost,
      probePort: Number(leaderTransportPort) || 9300,
      resolvedMode: 'sniff',
    };
  }
  return {
    settings: { mode: 'proxy', proxy_address: `${leaderHost}:${leaderTransportPort || 9300}`, server_name: serverName || leaderHost },
    probeHost: leaderHost,
    probePort: Number(leaderTransportPort) || 9300,
    resolvedMode: 'proxy',
  };
}

/**
 * 2단계: 팔로워 클러스터에 remote cluster 등록
 * body: {
 *   followerClusterId, remoteAlias, authMode('apikey'|'cert'), connectionMode('proxy'|'sniff'),
 *   leaderHost, leaderProxyPort, leaderTransportPort, extraSeeds(콤마구분 문자열), serverName
 * }
 * authMode='apikey'면 keystore 등록이 이미 완료되었다는 전제로 호출합니다.
 * authMode='cert'면 양쪽 클러스터 transport 계층에 CA 신뢰 관계가 미리 구성되어 있다는 전제입니다.
 */
router.post('/register-remote', async (req, res) => {
  const {
    followerClusterId, remoteAlias, authMode, connectionMode,
    leaderHost, leaderProxyPort, leaderTransportPort, extraSeeds, serverName,
  } = req.body;
  const follower = getCluster(followerClusterId);
  if (!follower) return res.status(404).json({ error: 'follower cluster not found' });

  const mode = authMode === 'cert' ? 'cert' : 'apikey';
  const { settings, probeHost, probePort, resolvedMode } = buildRemoteSettings({
    authMode: mode, connectionMode, leaderHost, leaderProxyPort, leaderTransportPort, extraSeeds, serverName,
  });

  // 0단계(진단): ES REST 호출과 별개로, 실제 연결 대상 포트가 TLS로 응답하는지 원시 소켓으로 먼저 확인합니다.
  const portProbe = await probeRemotePort(probeHost, probePort);

  const settingsResult = await call(follower, 'PUT', '/_cluster/settings', {
    persistent: { cluster: { remote: { [remoteAlias]: settings } } },
  }, { label: `Remote Cluster 등록 (${resolvedMode}, ${mode === 'cert' ? 'TLS 인증서' : 'API Key'} 인증 → ${probeHost}:${probePort})` });

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
    diagnosis = {
      level: 'ok',
      message: `정상적으로 연결되었습니다. (${resolvedMode === 'sniff' ? 'Sniff' : 'Proxy'} 모드, ${mode === 'cert' ? 'TLS 인증서' : 'API Key'} 인증)`,
    };
  } else if (!portProbe.reachable) {
    diagnosis = {
      level: 'error',
      message: mode === 'apikey'
        ? `리더(${probeHost}:${probePort})의 remote cluster server 포트 자체가 응답하지 않습니다 (${portProbe.error}). ` +
          `리더 노드의 elasticsearch.yml에 remote_cluster_server.enabled: true 및 remote_cluster.port 설정이 되어있는지, ` +
          `방화벽에 이 포트가 열려있는지, 설정 후 노드가 재시작됐는지 확인하세요.`
        : `리더(${probeHost}:${probePort})의 transport 포트가 응답하지 않습니다 (${portProbe.error}). ` +
          `방화벽에 이 포트(보통 9300)가 열려있는지, 노드가 정상 기동 중인지 확인하세요.` +
          (resolvedMode === 'sniff' ? ' Sniff 모드는 팔로워의 모든 노드가 리더의 모든 노드에 도달할 수 있어야 합니다(풀 메쉬).' : ''),
    };
  } else {
    diagnosis = {
      level: 'warning',
      message: mode === 'apikey'
        ? `포트(${probeHost}:${probePort})는 TLS로 응답하지만(정상), ES 레벨 원격 연결은 ` +
          `${maxAttempts}번 재시도 후에도 connected: true가 되지 않았습니다. keystore에 cross-cluster API ` +
          `Key가 실제로 등록됐는지(② 단계), 인증서 신뢰 관계, server_name이 인증서와 일치하는지 확인하세요.`
        : `포트(${probeHost}:${probePort})는 응답하지만 ES 레벨 연결이 안 됩니다. 양쪽 클러스터가 같은 CA를 ` +
          `신뢰하도록 인증서가 구성되어 있는지, server_name이 인증서 SAN과 일치하는지 확인하세요.` +
          (resolvedMode === 'sniff' ? ' Sniff 모드는 방화벽에서 노드 간 풀 메쉬 연결이 필요합니다.' : ''),
    };
  }

  addLog({
    action: 'register_remote_cluster',
    clusterId: followerClusterId,
    detail: { remoteAlias, authMode: mode, connectionMode: resolvedMode, ok: settingsResult.ok, connected, portReachable: portProbe.reachable },
  });

  res.json({ settingsResult, remoteInfoResult, portProbe, diagnosis, resolvedMode, authMode: mode });
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
      `이 경우 follow는 리더 쪽 연결 포트(API Key 인증이면 remote cluster server 포트, TLS 인증서 인증이면 ` +
      `transport 포트)를 기다리다 타임아웃 납니다. ③번 "Remote Cluster 등록" 결과의 진단 메시지를 다시 확인해보세요.`;
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

/**
 * Auto-follow 패턴 생성: 리더에 이 패턴에 맞는 인덱스가 새로 생기면 자동으로 팔로워를 만듭니다.
 * (지금 이미 존재하는 인덱스는 대상이 아니고, 앞으로 생성되는 것만 해당됩니다.)
 * body: { followerClusterId, patternName, remoteAlias, leaderIndexPatterns(콤마 문자열 또는 배열), followIndexPattern }
 */
router.post('/auto-follow', async (req, res) => {
  const { followerClusterId, patternName, remoteAlias, leaderIndexPatterns, followIndexPattern } = req.body;
  const follower = getCluster(followerClusterId);
  if (!follower) return res.status(404).json({ error: 'follower cluster not found' });
  if (!patternName) return res.status(400).json({ error: 'patternName은 필수입니다.' });

  const patterns = Array.isArray(leaderIndexPatterns)
    ? leaderIndexPatterns
    : String(leaderIndexPatterns || '').split(',').map((s) => s.trim()).filter(Boolean);

  const result = await call(follower, 'PUT', `/_ccr/auto_follow/${patternName}`, {
    remote_cluster: remoteAlias,
    leader_index_patterns: patterns,
    follow_index_pattern: followIndexPattern || '{{leader_index}}-follower',
  }, { label: `Auto-follow 패턴 생성 (${patternName})` });

  addLog({ action: 'auto_follow_create', clusterId: followerClusterId, detail: { patternName, patterns, ok: result.ok } });
  res.json({ result });
});

/** Auto-follow 패턴 상태 조회 */
router.get('/auto-follow/:clusterId/:patternName', async (req, res) => {
  const cluster = getCluster(req.params.clusterId);
  if (!cluster) return res.status(404).json({ error: 'cluster not found' });
  const result = await call(cluster, 'GET', `/_ccr/auto_follow/${req.params.patternName}`, undefined, {
    label: `Auto-follow 상태 조회 (${req.params.patternName})`,
  });
  res.json({ result });
});

/** Auto-follow 패턴 삭제 (이미 생성된 팔로워 인덱스 자체는 유지됨) */
router.delete('/auto-follow/:clusterId/:patternName', async (req, res) => {
  const cluster = getCluster(req.params.clusterId);
  if (!cluster) return res.status(404).json({ error: 'cluster not found' });
  const result = await call(cluster, 'DELETE', `/_ccr/auto_follow/${req.params.patternName}`, undefined, {
    label: `Auto-follow 패턴 삭제 (${req.params.patternName})`,
  });
  addLog({ action: 'auto_follow_delete', clusterId: req.params.clusterId, detail: { patternName: req.params.patternName, ok: result.ok } });
  res.json({ result });
});

module.exports = router;

const $ = (sel) => document.querySelector(sel);

let clusters = [];
let ccrLinks = [];
let monitorTimer = null;
let GUIDE_MODE = false;

// ---------- 🧪 시뮬레이션 모드 ----------
const SIM = { enabled: false, stats: {} };

function shouldSimulate(method, path) {
  return (
    /^\/api\/clusters\/.+\/test$/.test(path) ||
    path.startsWith('/api/ccr/') ||
    path.startsWith('/api/dr/') ||
    path === '/api/index-mgmt/sample-index'
  );
}

function simDelay(ms = 450) {
  return new Promise((r) => setTimeout(r, ms + Math.random() * 350));
}

async function mockApi(method, path, body = {}) {
  await simDelay();

  if (/^\/api\/clusters\/.+\/test$/.test(path)) {
    return {
      health: { ok: true, status: 200, path: '/_cluster/health', method: 'GET', response: { status: 'green', cluster_name: 'sim-cluster' } },
      license: { ok: true, status: 200, path: '/_license', method: 'GET', response: { license: { type: 'trial', status: 'active' } } },
    };
  }

  if (path === '/api/ccr/generate-api-key') {
    return {
      result: {
        ok: true, status: 200, path: '/_security/cross_cluster/api_key', method: 'POST',
        response: { id: 'sim-key-id', name: `ccr-${body.remoteAlias}-key`, encoded: btoa(`sim:${Date.now()}`) },
      },
      keystoreCommand: '(시뮬레이션 모드) 실제 keystore 명령 실행은 필요 없습니다. 실전 모드에서는 여기에 실제 명령어가 표시됩니다.',
    };
  }

  if (path === '/api/ccr/register-remote') {
    return {
      settingsResult: { ok: true, status: 200, path: '/_cluster/settings', method: 'PUT', response: { acknowledged: true } },
      remoteInfoResult: { ok: true, status: 200, path: '/_remote/info', method: 'GET', response: { [body.remoteAlias]: { connected: true, mode: 'proxy' } } },
      portProbe: { reachable: true, tlsHandshake: true },
      diagnosis: { level: 'ok', message: '(시뮬레이션) 정상적으로 연결되었습니다.' },
    };
  }

  if (path === '/api/ccr/follow') {
    const key = `${body.followerClusterId}:${body.followerIndex}`;
    SIM.stats[key] = { opsWritten: 0, leaderCp: 0 };
    upsertLocalLink({
      leaderClusterId: body.leaderClusterId, followerClusterId: body.followerClusterId,
      remoteAlias: body.remoteAlias, leaderIndex: body.leaderIndex, followerIndex: body.followerIndex,
      direction: body.direction || 'primary-to-dr',
    });
    return {
      result: {
        ok: true, status: 200, path: `/${body.followerIndex}/_ccr/follow`, method: 'PUT',
        response: { follow_index_created: true, follow_index_shards_acked: true, index_following_started: true },
      },
    };
  }

  if (/^\/api\/ccr\/stats\//.test(path)) {
    const parts = path.split('/'); // /api/ccr/stats/:clusterId/:indexName
    const clusterId = parts[4];
    const indexName = parts[5];
    const key = `${clusterId}:${indexName}`;
    if (!SIM.stats[key]) SIM.stats[key] = { opsWritten: 0, leaderCp: 0 };
    const s = SIM.stats[key];
    // 리더가 계속 앞서가고, 팔로워가 서서히 따라잡는 모양을 흉내
    s.leaderCp += Math.floor(Math.random() * 40) + 10;
    const catchUp = Math.max(Math.floor((s.leaderCp - s.opsWritten) * 0.6), 5);
    s.opsWritten = Math.min(s.opsWritten + catchUp, s.leaderCp);
    return {
      ok: true, status: 200, path, method: 'GET',
      response: {
        indices: [{
          index: indexName,
          shards: [{
            leader_global_checkpoint: s.leaderCp,
            follower_global_checkpoint: s.opsWritten,
            operations_written: s.opsWritten,
            fatal_exception: null,
          }],
        }],
      },
    };
  }

  if (path === '/api/dr/failover') {
    markLocalUnfollowed(body.clusterId, body.indexName);
    return {
      log: [
        { step: 'pause_follow', ok: true, status: 200, path: `/${body.indexName}/_ccr/pause_follow`, method: 'POST', response: {} },
        { step: 'close', ok: true, status: 200, path: `/${body.indexName}/_close`, method: 'POST', response: { acknowledged: true } },
        { step: 'unfollow', ok: true, status: 200, path: `/${body.indexName}/_ccr/unfollow`, method: 'POST', response: { acknowledged: true } },
        { step: 'open', ok: true, status: 200, path: `/${body.indexName}/_open`, method: 'POST', response: { acknowledged: true } },
      ],
      aborted: false,
    };
  }

  if (path === '/api/dr/prepare-failback') {
    return { result: { ok: true, status: 200, path: `/${body.indexName}`, method: 'DELETE', response: { acknowledged: true } } };
  }

  if (path === '/api/ccr/remove-remote') {
    removeLocalLink(body.clusterId, body.followerIndex);
    return { result: { ok: true, status: 200, path: '/_cluster/settings', method: 'PUT', response: { acknowledged: true } } };
  }

  if (path === '/api/index-mgmt/sample-index') {
    return {
      log: [
        { step: 'create_index', ok: true, status: 200, path: `/${body.indexName}`, method: 'PUT', response: { acknowledged: true, shards_acknowledged: true, index: body.indexName } },
        { step: 'seed_summary', totalRequested: Number(body.seedDocs) || 0, totalInserted: Number(body.seedDocs) || 0 },
      ],
    };
  }

  if (path.startsWith('/api/verify/')) {
    return { error: '시뮬레이션 모드에서는 검증(쿼리 비교) 기능은 지원하지 않습니다. 상단의 시뮬레이션 모드를 끄고 실제 클러스터로 확인해주세요.' };
  }

  return { ok: true, simulated: true };
}

// ---------- 공통 유틸 ----------
async function api(method, path, body) {
  if (SIM.enabled && shouldSimulate(method, path)) {
    return mockApi(method, path, body);
  }
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}

function fillSelect(selectEl, list, placeholder) {
  selectEl.innerHTML = '';
  if (placeholder) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = placeholder;
    selectEl.appendChild(opt);
  }
  list.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.name} (${c.role === 'primary' ? '주센터' : 'DR센터'} · ${c.host})`;
    selectEl.appendChild(opt);
  });
}

// ---------- 🧭 가이드 모드 ----------
const GUIDE_STEPS = [
  'btnCreateSampleIndex',
  'btnGenKey', 'btnShowKeystore', 'btnRegisterRemote', 'btnFollow',
  'btnStartMonitor',
  'btnFailover',
  'btnPrepareFailback', 'btnFailbackGenKey', 'btnFailbackShowKeystore',
  'btnFailbackRegisterRemote', 'btnFailbackFollow', 'btnFailbackUnfollow',
];
const guideCompleted = new Set();

function markGuideStep(id) {
  guideCompleted.add(id);
  updateGuideHighlights();
}

function updateGuideHighlights() {
  document.querySelectorAll('.guide-next, .guide-dimmed').forEach((el) => el.classList.remove('guide-next', 'guide-dimmed'));
  if (!GUIDE_MODE) return;

  if (clusters.length < 2) {
    document.querySelector('#clusterForm button[type="submit"]')?.classList.add('guide-next');
    GUIDE_STEPS.forEach((id) => $('#' + id)?.classList.add('guide-dimmed'));
    return;
  }
  const nextIdx = GUIDE_STEPS.findIndex((id) => !guideCompleted.has(id));
  GUIDE_STEPS.forEach((id, i) => {
    const btn = $('#' + id);
    if (!btn) return;
    if (i === nextIdx) btn.classList.add('guide-next');
    else if (nextIdx !== -1 && i > nextIdx) btn.classList.add('guide-dimmed');
  });
}

$('#guideModeToggle').addEventListener('change', (e) => {
  GUIDE_MODE = e.target.checked;
  updateGuideHighlights();
});

$('#simModeToggle').addEventListener('change', (e) => {
  SIM.enabled = e.target.checked;
  $('#simModeBanner').style.display = SIM.enabled ? 'block' : 'none';
});

// ---------- 📖 용어집 ----------
const GLOSSARY = [
  ['CCR (Cross-Cluster Replication)', '한 클러스터(리더)의 인덱스를 다른 클러스터(팔로워)로 실시간에 가깝게 복제하는 Elasticsearch 기능입니다.'],
  ['Leader / Follower', '리더는 원본 데이터를 가진 인덱스, 팔로워는 그걸 그대로 복제해서 따라가는 인덱스입니다. 팔로워는 follow 상태인 동안 직접 쓰기가 불가능합니다.'],
  ['Remote Cluster', '내 클러스터가 아닌, CCR/CCS로 연결해서 데이터를 가져오는 다른 클러스터를 가리키는 용어입니다.'],
  ['Proxy 모드', '팔로워의 모든 노드가 리더의 대표 진입점(프록시 주소) 하나로만 연결하는 방식입니다. Sniff 모드보다 방화벽 설정이 단순합니다.'],
  ['API Key 인증', 'CCR 연결 시 인증서 기반 상호 신뢰 대신, 발급된 API Key로 권한을 제한해서 인증하는 최신 방식입니다.'],
  ['Remote Cluster Server', 'API Key 인증 방식에서 원격 요청을 받아주는 전용 인터페이스로, 기본 포트는 9443입니다. 기본적으로 꺼져 있어서 켜야 합니다.'],
  ['Checkpoint', '지금까지 안전하게 커밋된 마지막 오퍼레이션의 위치를 가리키는 지표로, 복제 진행 상황을 추적하는 데 씁니다.'],
  ['복제 지연 (Lag)', '리더의 checkpoint와 팔로워의 checkpoint 차이로, 팔로워가 리더를 얼마나 따라가지 못하고 있는지를 나타냅니다.'],
  ['Failover', '주센터 장애 시, DR센터를 독립적으로 쓰기 가능한 상태로 전환해서 서비스를 이어가는 것입니다.'],
  ['Failback', '장애 복구 후 DR센터의 데이터를 다시 주센터로 되돌리고 원래 운영 형태로 복귀하는 것입니다.'],
  ['Soft Delete', '문서를 즉시 지우지 않고 삭제 표시만 해서, CCR이 그 삭제 이력까지 팔로워에 정확히 복제할 수 있게 하는 기능입니다.'],
  ['HNSW', '벡터 검색(kNN)을 빠르게 하기 위한 그래프 기반 근사 최근접 이웃 탐색 알고리즘입니다.'],
  ['kNN (k-최근접 이웃)', '주어진 벡터와 가장 가까운 상위 K개의 벡터(문서)를 찾는 검색 방식입니다.'],
];

$('#btnOpenGlossary').addEventListener('click', () => {
  $('#glossaryList').innerHTML = GLOSSARY.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join('');
  $('#glossaryModal').style.display = 'flex';
});
$('#btnCloseGlossary').addEventListener('click', () => { $('#glossaryModal').style.display = 'none'; });
$('#glossaryModal').addEventListener('click', (e) => {
  if (e.target.id === 'glossaryModal') $('#glossaryModal').style.display = 'none';
});

// ---------- 1. 클러스터 등록 ----------
async function loadClusters() {
  clusters = await api('GET', '/api/clusters');
  renderClusterList();
  const allSelects = [
    '#leaderSelect', '#followerSelect', '#sampleIndexCluster',
    '#monitorCluster', '#drCluster', '#failbackFollowerSelect',
    '#verifyClusterA', '#verifyClusterB',
  ];
  allSelects.forEach((sel) => fillSelect($(sel), clusters, '선택하세요'));
  updateGuideHighlights();
}

function healthDotHtml(c) {
  if (c.lastHealthOk === true) return '<span class="dot dot-green"></span>정상';
  if (c.lastHealthOk === false) return '<span class="dot dot-red"></span>실패';
  return '<span class="dot dot-gray"></span>미확인';
}

function renderClusterList() {
  const box = $('#clusterList');
  box.innerHTML = '';
  clusters.forEach((c) => {
    const div = document.createElement('div');
    div.className = 'cluster-chip';
    div.innerHTML = `
      <span class="role-${c.role}">${c.role === 'primary' ? '주센터' : 'DR센터'}</span>
      <strong>${c.name}</strong>
      <span>${c.host}:${c.restPort} (proxy ${c.proxyPort}) · ${(c.protocol || 'https').toUpperCase()}</span>
      <span>${healthDotHtml(c)}</span>
      <div class="chip-actions">
        <button data-test="${c.id}">연결 테스트</button>
        <button data-del="${c.id}" style="background:#dc2626">삭제</button>
        ${c.kibanaUrl ? `<a class="kibana-link" href="${c.kibanaUrl}" target="_blank" rel="noopener">Kibana 열기 ↗</a>` : ''}
      </div>
    `;
    box.appendChild(div);
  });

  box.querySelectorAll('[data-test]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const result = await api('POST', `/api/clusters/${btn.dataset.test}/test`);
      appendLog('연결 테스트 결과', result);
    });
  });
  box.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api('DELETE', `/api/clusters/${btn.dataset.del}`);
      await loadClusters();
      // 아키텍처 다이어그램(우측 패널)도 즉시 반영 - SSE 도착을 기다리지 않고 바로 상태 재조회
      const state = await api('GET', '/api/state');
      applyState(state);
    });
  });
}

$('#authType').addEventListener('change', (e) => {
  const isApiKey = e.target.value === 'apikey';
  $('#userField').style.display = isApiKey ? 'none' : 'flex';
  $('#pwField').style.display = isApiKey ? 'none' : 'flex';
  $('#apiKeyField').style.display = isApiKey ? 'flex' : 'none';
});

$('#protocolSelect').addEventListener('change', (e) => {
  // http는 TLS 자체가 없으니 인증서 검증 옵션이 의미가 없어서 숨김
  $('#insecureTLSField').style.display = e.target.value === 'http' ? 'none' : 'flex';
});

// 샘플 인덱스를 만든 클러스터 = 보통 CCR의 Leader 클러스터와 같으므로, 아직 서로 선택 안 된 쪽을 자동으로 맞춰줍니다.
$('#sampleIndexCluster').addEventListener('change', (e) => {
  if (!$('#leaderSelect').value && e.target.value) $('#leaderSelect').value = e.target.value;
});
$('#leaderSelect').addEventListener('change', (e) => {
  if (!$('#sampleIndexCluster').value && e.target.value) $('#sampleIndexCluster').value = e.target.value;
});

$('#clusterForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  body.insecureTLS = fd.get('insecureTLS') === 'on';
  const result = await api('POST', '/api/clusters', body);
  appendLog('클러스터 등록', result);
  e.target.reset();
  await loadClusters();
});

// ---------- 2. CCR 연동 ----------
let ccrState = {};

$('#btnGenKey').addEventListener('click', async () => {
  const leaderClusterId = $('#leaderSelect').value;
  const followerClusterId = $('#followerSelect').value;
  const remoteAlias = $('#remoteAlias').value;
  const leaderIndex = $('#leaderIndex').value;
  if (!leaderClusterId) return alert('Leader 클러스터를 선택하세요.');

  const { result, keystoreCommand } = await api('POST', '/api/ccr/generate-api-key', {
    leaderClusterId, remoteAlias, leaderIndex, followerClusterId,
  });
  appendLog('① API Key 발급', result);
  if (result.ok) {
    ccrState.keystoreCommand = keystoreCommand;
    $('#btnShowKeystore').disabled = false;
  }
  markGuideStep('btnGenKey');
});

$('#btnShowKeystore').addEventListener('click', () => {
  const box = $('#keystoreBox');
  box.style.display = 'block';
  box.textContent =
    '아래 명령어를 Follower 클러스터의 각 노드에서 실행한 뒤, ③ 버튼을 누르세요.\n\n' +
    (ccrState.keystoreCommand || '(발급된 명령어 없음)');
  $('#btnRegisterRemote').disabled = false;
  markGuideStep('btnShowKeystore');
});

function renderDiag(elId, diag, portProbe) {
  const box = $(elId);
  if (!diag) { box.style.display = 'none'; return; }
  box.className = `diag-box diag-${diag.level}`;
  const probeLine = portProbe
    ? `<div class="diag-sub">포트 TLS 응답: ${portProbe.reachable ? '✅ 정상' : `❌ ${portProbe.error || '응답 없음'}`}</div>`
    : '';
  box.innerHTML = `<div class="diag-msg">${diag.level === 'ok' ? '✅' : diag.level === 'warning' ? '⚠️' : '❌'} ${diag.message}</div>${probeLine}`;
  box.style.display = 'block';
}

$('#btnRegisterRemote').addEventListener('click', async () => {
  const followerClusterId = $('#followerSelect').value;
  const leaderClusterId = $('#leaderSelect').value;
  const remoteAlias = $('#remoteAlias').value;
  const leader = clusters.find((c) => c.id === leaderClusterId);
  if (!followerClusterId || !leader) return alert('Leader/Follower 클러스터를 확인하세요.');

  const btn = $('#btnRegisterRemote');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '확인 중... (포트/연결 진단, 최대 10초)';

  const result = await api('POST', '/api/ccr/register-remote', {
    followerClusterId,
    remoteAlias,
    leaderProxyHost: leader.host,
    leaderProxyPort: leader.proxyPort,
    serverName: leader.host,
  });
  appendLog('③ Remote Cluster 등록', result);
  renderDiag('#registerRemoteDiag', result.diagnosis, result.portProbe);

  btn.disabled = false;
  btn.textContent = originalText;
  if (result.settingsResult?.ok) {
    $('#btnFollow').disabled = false;
  }
  markGuideStep('btnRegisterRemote');
});

$('#btnFollow').addEventListener('click', async () => {
  const followerClusterId = $('#followerSelect').value;
  const leaderClusterId = $('#leaderSelect').value;
  const followerIndex = $('#followerIndex').value;
  const remoteAlias = $('#remoteAlias').value;
  const leaderIndex = $('#leaderIndex').value;

  const result = await api('POST', '/api/ccr/follow', {
    followerClusterId, followerIndex, remoteAlias, leaderIndex,
    leaderClusterId, direction: 'primary-to-dr',
  });
  appendLog('④ Follower Index 생성', result);
  markGuideStep('btnFollow');
});

// ---------- 3. 샘플 벡터 인덱스 ----------
$('#btnCreateSampleIndex').addEventListener('click', async () => {
  const clusterId = $('#sampleIndexCluster').value;
  if (!clusterId) return alert('클러스터를 선택하세요.');
  const result = await api('POST', '/api/index-mgmt/sample-index', {
    clusterId,
    indexName: $('#sampleIndexName').value,
    dims: $('#sampleDims').value,
    similarity: $('#sampleSimilarity').value,
    seedDocs: $('#sampleSeedDocs').value,
    batchSize: $('#sampleBatchSize').value,
    offset: $('#sampleOffset').value,
    customBody: $('#sampleCustomBody').value.trim() || undefined,
  });
  appendLog('샘플 벡터 인덱스 생성', result);
  markGuideStep('btnCreateSampleIndex');
});

function updateLagGauge(result) {
  const box = $('#lagGaugeBox');
  const shard = result?.response?.indices?.[0]?.shards?.[0];
  if (!shard) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  const leaderCp = shard.leader_global_checkpoint ?? 0;
  const followerCp = shard.follower_global_checkpoint ?? 0;
  const lag = Math.max(leaderCp - followerCp, 0);
  $('#lagValue').textContent = lag;
  $('#lagOpsWritten').textContent = shard.operations_written ?? 0;
  $('#lagLeaderCp').textContent = leaderCp;
  $('#lagFollowerCp').textContent = followerCp;
  $('#lagBarFill').style.width = `${Math.min((lag / 50) * 100, 100)}%`;
}

// ---------- 4. 모니터링 ----------
$('#btnStartMonitor').addEventListener('click', () => {
  const clusterId = $('#monitorCluster').value;
  const indexName = $('#monitorIndex').value;
  if (!clusterId) return alert('클러스터를 선택하세요.');
  if (monitorTimer) clearInterval(monitorTimer);

  const tick = async () => {
    const result = await api('GET', `/api/ccr/stats/${clusterId}/${indexName}`);
    $('#monitorOutput').textContent = pretty(result);
    updateLagGauge(result);
  };
  tick();
  monitorTimer = setInterval(tick, 5000);
  markGuideStep('btnStartMonitor');
});

$('#btnStopMonitor').addEventListener('click', () => {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
});

// ---------- 5. Failover / Failback ----------
$('#btnFailover').addEventListener('click', async () => {
  if (!confirm('정말 Failover를 실행하시겠습니까? (unfollow 이후 되돌릴 수 없습니다)')) return;
  const clusterId = $('#drCluster').value;
  const indexName = $('#drIndex').value;
  const result = await api('POST', '/api/dr/failover', { clusterId, indexName });
  appendLog('Failover 실행', result);
  markGuideStep('btnFailover');
});

$('#btnPrepareFailback').addEventListener('click', async () => {
  if (!confirm('원 Primary의 기존 인덱스를 삭제합니다. 계속할까요?')) return;
  const clusterId = $('#failbackFollowerSelect').value;
  const indexName = $('#failbackFollowerIndex').value;
  const result = await api('POST', '/api/dr/prepare-failback', { clusterId, indexName });
  appendLog('① Failback 준비 (인덱스 삭제)', result);
  markGuideStep('btnPrepareFailback');
});

let failbackState = {};

$('#btnFailbackGenKey').addEventListener('click', async () => {
  const drClusterId = $('#drCluster').value; // 이제 leader 역할
  const followerClusterId = $('#failbackFollowerSelect').value; // 원 Primary, 이제 follower 역할
  const remoteAlias = $('#failbackAlias').value;
  const drIndex = $('#drIndex').value;
  if (!drClusterId) return alert('DR 클러스터(이제 leader)를 선택하세요.');

  const { result, keystoreCommand } = await api('POST', '/api/ccr/generate-api-key', {
    leaderClusterId: drClusterId, remoteAlias, leaderIndex: drIndex, followerClusterId,
  });
  appendLog('② 역방향 API Key 발급', result);
  if (result.ok) {
    failbackState.keystoreCommand = keystoreCommand;
    $('#btnFailbackShowKeystore').disabled = false;
  }
  markGuideStep('btnFailbackGenKey');
});

$('#btnFailbackShowKeystore').addEventListener('click', () => {
  alert('아래 명령어를 원 Primary(이제 follower)의 각 노드에서 실행하세요:\n\n' + (failbackState.keystoreCommand || '(없음)'));
  $('#btnFailbackRegisterRemote').disabled = false;
  markGuideStep('btnFailbackShowKeystore');
});

$('#btnFailbackRegisterRemote').addEventListener('click', async () => {
  const followerClusterId = $('#failbackFollowerSelect').value;
  const drClusterId = $('#drCluster').value;
  const remoteAlias = $('#failbackAlias').value;
  const dr = clusters.find((c) => c.id === drClusterId);
  if (!followerClusterId || !dr) return alert('클러스터 선택을 확인하세요.');

  const btn = $('#btnFailbackRegisterRemote');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '확인 중... (포트/연결 진단, 최대 10초)';

  const result = await api('POST', '/api/ccr/register-remote', {
    followerClusterId,
    remoteAlias,
    leaderProxyHost: dr.host,
    leaderProxyPort: dr.proxyPort,
    serverName: dr.host,
  });
  appendLog('④ 역방향 Remote 등록', result);
  renderDiag('#failbackRegisterDiag', result.diagnosis, result.portProbe);

  btn.disabled = false;
  btn.textContent = originalText;
  if (result.settingsResult?.ok) $('#btnFailbackFollow').disabled = false;
  markGuideStep('btnFailbackRegisterRemote');
});

$('#btnFailbackFollow').addEventListener('click', async () => {
  const followerClusterId = $('#failbackFollowerSelect').value;
  const drClusterId = $('#drCluster').value;
  const followerIndex = $('#failbackFollowerIndex').value;
  const remoteAlias = $('#failbackAlias').value;
  const leaderIndex = $('#drIndex').value;

  const result = await api('POST', '/api/ccr/follow', {
    followerClusterId, followerIndex, remoteAlias, leaderIndex,
    leaderClusterId: drClusterId, direction: 'dr-to-primary',
  });
  appendLog('⑤ 역방향 Follower 생성', result);
  markGuideStep('btnFailbackFollow');
});

$('#btnFailbackUnfollow').addEventListener('click', async () => {
  if (!confirm('문서 수가 양쪽 일치하는지 확인하셨나요? 역방향 CCR을 해제합니다.')) return;
  const clusterId = $('#failbackFollowerSelect').value;
  const indexName = $('#failbackFollowerIndex').value;
  const remoteAlias = $('#failbackAlias').value;

  const result = await api('POST', '/api/dr/failover', { clusterId, indexName });
  appendLog('⑥-1 역방향 pause/close/unfollow/open', result);
  const removeResult = await api('POST', '/api/ccr/remove-remote', { clusterId, remoteAlias, followerIndex: indexName });
  appendLog('⑥-2 역방향 remote 설정 제거', removeResult);
  markGuideStep('btnFailbackUnfollow');
});

// ---------- 6. 검증 ----------
$('#btnIndexCheck').addEventListener('click', async () => {
  const aId = $('#verifyClusterA').value, aIdx = $('#verifyIndexA').value;
  const bId = $('#verifyClusterB').value, bIdx = $('#verifyIndexB').value;
  if (!aId || !bId) return alert('A/B 클러스터를 선택하세요.');

  const [a, b] = await Promise.all([
    api('GET', `/api/verify/index-check/${aId}/${aIdx}`),
    api('GET', `/api/verify/index-check/${bId}/${bIdx}`),
  ]);
  appendLog('인덱스 상태 확인', { a, b });
  renderIndexCheck(a, b, aIdx, bIdx);
});

function renderIndexCheck(a, b, aIdx, bIdx) {
  const box = $('#verifyResult');
  box.style.display = 'block';
  const rows = [
    ['헬스', a.health?.response?.status || a.health?.response?.error || '-', b.health?.response?.status || b.health?.response?.error || '-'],
    ['문서 수', a.count?.response?.count ?? '-', b.count?.response?.count ?? '-'],
  ];
  box.innerHTML = `
    <table class="verify-table">
      <tr><th></th><th>A (${aIdx})</th><th>B (${bIdx})</th></tr>
      ${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')}
    </table>`;
}

$('#btnCompareQuery').addEventListener('click', async () => {
  const clusterAId = $('#verifyClusterA').value, indexA = $('#verifyIndexA').value;
  const clusterBId = $('#verifyClusterB').value, indexB = $('#verifyIndexB').value;
  const vectorField = $('#verifyVectorField').value;
  const k = $('#verifyK').value;
  if (!clusterAId || !clusterBId) return alert('A/B 클러스터를 선택하세요.');

  const result = await api('POST', '/api/verify/compare-query', { clusterAId, indexA, clusterBId, indexB, vectorField, k });
  appendLog('쿼리 결과 비교', result);
  renderCompareResult(result, indexA, indexB);
});

function fmtScore(s) {
  return typeof s === 'number' ? s.toFixed(4) : s;
}

function renderCompareResult(r, indexA, indexB) {
  const box = $('#verifyResult');
  box.style.display = 'block';

  if (r.error) {
    box.innerHTML = `<div class="verify-summary mismatch">${r.error}</div>`;
    return;
  }
  if (!r.knnComparable) {
    box.innerHTML = `
      <div class="verify-summary ${r.countMatch ? 'match' : 'mismatch'}">
        문서 수: A=${r.countA?.response?.count ?? '-'} / B=${r.countB?.response?.count ?? '-'} ${r.countMatch ? '✅ 일치' : '❌ 불일치'}<br/>
        kNN 비교 불가: ${r.reason}
      </div>`;
    return;
  }

  box.innerHTML = `
    <div class="verify-summary ${r.overallMatch ? 'match' : 'mismatch'}">
      ${r.overallMatch ? '✅ 리더/팔로워 쿼리 결과가 완전히 일치합니다.' : '⚠️ 차이가 있습니다.'}<br/>
      문서 수: A=${r.countA?.response?.count ?? '-'} / B=${r.countB?.response?.count ?? '-'} (${r.countMatch ? '일치' : '불일치'}) ·
      상위 ID 순서: ${r.idsMatch ? '일치' : '불일치'} · 최대 점수 차이: ${fmtScore(r.maxScoreDiff)}
    </div>
    <table class="verify-table">
      <tr><th>#</th><th>A(${indexA}) _id (score)</th><th>B(${indexB}) _id (score)</th></tr>
      ${r.hitsA.map((h, i) => `<tr><td>${i + 1}</td><td>${h.id} (${fmtScore(h.score)})</td><td>${r.hitsB[i] ? `${r.hitsB[i].id} (${fmtScore(r.hitsB[i].score)})` : '-'}</td></tr>`).join('')}
    </table>`;
}

// ---------- 로그 ----------
function appendLog(title, data) {
  const box = $('#logOutput');
  box.textContent = `[${new Date().toLocaleTimeString()}] ${title}\n${pretty(data)}\n\n` + box.textContent;
  box.scrollTop = 0; // 새 로그는 맨 위에 쌓이므로, 발생 시 스크롤도 맨 위로 이동
}

$('#btnRefreshLog').addEventListener('click', async () => {
  const logs = await api('GET', '/api/logs');
  $('#logOutput').textContent = pretty(logs);
  $('#logOutput').scrollTop = 0;
});

$('#btnCopyLog').addEventListener('click', async () => {
  const text = $('#logOutput').textContent;
  try {
    await navigator.clipboard.writeText(text);
    const btn = $('#btnCopyLog');
    const original = btn.textContent;
    btn.textContent = '복사됨!';
    setTimeout(() => { btn.textContent = original; }, 1200);
  } catch {
    alert('클립보드 복사에 실패했습니다. 브라우저 권한을 확인해주세요.');
  }
});

// ---------- 우측 아키텍처 다이어그램 ----------
let currentPrimary = null;
let currentDr = null;

function findLink(primaryId, drId) {
  return ccrLinks.find((l) =>
    (l.leaderClusterId === primaryId && l.followerClusterId === drId) ||
    (l.leaderClusterId === drId && l.followerClusterId === primaryId)
  );
}

function roleBadge(clusterId, link, cluster) {
  if (!link) {
    // 아직 CCR 연동 전이면 등록 시 지정한 역할을 그대로 보여줍니다 (실제 CCR 상태가 아니라 "설정값"이라는 의미로 대기중 표기)
    if (cluster?.role === 'primary') return { text: '주센터 (대기 중)', cls: 'arch-role-unknown' };
    if (cluster?.role === 'dr') return { text: 'DR센터 (대기 중)', cls: 'arch-role-unknown' };
    return { text: '역할 미지정', cls: 'arch-role-unknown' };
  }
  if (link.status === 'linked') {
    if (link.leaderClusterId === clusterId) return { text: '리더 (Leader)', cls: 'arch-role-leader' };
    return { text: '팔로워 (Follower)', cls: 'arch-role-follower' };
  }
  // unfollowed
  if (link.followerClusterId === clusterId) return { text: '독립 인덱스 (Failover 상태)', cls: 'arch-role-independent' };
  return { text: '리더였음 (연결 끊김)', cls: 'arch-role-unknown' };
}

function boxSvg(y, cluster, badge, boxClass) {
  if (!cluster) {
    return `
      <g class="arch-box-empty">
        <rect x="20" y="${y}" width="280" height="70" rx="6"/>
        <text x="160" y="${y + 40}" text-anchor="middle" font-size="12" fill="#94a3b8">클러스터를 등록하세요</text>
      </g>`;
  }
  const health = cluster.lastHealthOk === true ? '#22c55e' : cluster.lastHealthOk === false ? '#ef4444' : '#cbd5e1';
  const kibana = cluster.kibanaUrl
    ? `<a href="${cluster.kibanaUrl}" target="_blank" rel="noopener"><text x="270" y="${y + 58}" text-anchor="end" font-size="10" fill="#ea580c" text-decoration="underline">Kibana ↗</text></a>`
    : '';
  return `
    <g class="${boxClass}">
      <rect x="20" y="${y}" width="280" height="70" rx="6" stroke-width="1.6"/>
      <circle cx="34" cy="${y + 16}" r="5" fill="${health}"/>
      <text x="46" y="${y + 20}" font-size="12.5" font-weight="700" fill="#1f2937">${cluster.name}</text>
      <text x="46" y="${y + 36}" font-size="10.5" fill="#475569">${(cluster.protocol || 'https')}://${cluster.host}:${cluster.restPort}</text>
      <text x="46" y="${y + 58}" class="arch-role-badge ${badge.cls}">${badge.text}</text>
      ${kibana}
    </g>`;
}

function renderArchDiagram() {
  currentPrimary = clusters.find((c) => c.role === 'primary') || null;
  currentDr = clusters.find((c) => c.role === 'dr') || null;
  const link = currentPrimary && currentDr ? findLink(currentPrimary.id, currentDr.id) : null;

  const primaryBadge = currentPrimary ? roleBadge(currentPrimary.id, link, currentPrimary) : { text: '', cls: '' };
  const drBadge = currentDr ? roleBadge(currentDr.id, link, currentDr) : { text: '', cls: '' };

  let arrowClass = 'arch-arrow-none';
  let arrowLabel = '연동 안 됨';
  let arrowFrom = 90, arrowTo = 170; // 기본: 위(주센터)->아래(DR)
  let markerId = 'archArrowNone';

  if (link) {
    if (link.status === 'linked') {
      arrowClass = 'arch-arrow-linked';
      arrowLabel = `CCR 복제 중 (${link.remoteAlias})`;
      if (link.direction === 'dr-to-primary') { arrowFrom = 170; arrowTo = 90; }
    } else {
      arrowClass = 'arch-arrow-broken';
      arrowLabel = 'Failover로 연결 끊김';
    }
  }

  const svg = `
    <svg id="archSvg" viewBox="0 0 320 260" class="arch-diagram">
      <defs>
        <marker id="archArrowHead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.6"/>
        </marker>
      </defs>
      ${boxSvg(20, currentPrimary, primaryBadge, currentPrimary ? 'arch-box-primary' : 'arch-box-empty')}
      <line id="archArrowLine" x1="160" y1="${arrowFrom + 5}" x2="160" y2="${arrowTo - 5}" class="${arrowClass}" marker-end="url(#archArrowHead)"/>
      <text x="170" y="${(arrowFrom + arrowTo) / 2 + 4}" font-size="10" fill="#475569">${arrowLabel}</text>
      ${boxSvg(170, currentDr, drBadge, currentDr ? 'arch-box-dr' : 'arch-box-empty')}
    </svg>`;

  $('#archContainer').innerHTML = svg;
}

function applyState(state) {
  // 서버가 준 스냅샷을 그대로 신뢰합니다 (클러스터가 0개로 줄어든 경우도 정확히 반영되어야 함)
  if (Array.isArray(state.clusters)) clusters = state.clusters;
  if (Array.isArray(state.links)) ccrLinks = state.links;
  renderArchDiagram();
  renderClusterList();
  updateGuideHighlights();
}

// ---- 시뮬레이션 모드 전용: 백엔드 SSE 없이 프론트에서 직접 CCR 링크 상태를 바꿔서 다이어그램에 반영 ----
function upsertLocalLink({ leaderClusterId, followerClusterId, remoteAlias, leaderIndex, followerIndex, direction }) {
  const idx = ccrLinks.findIndex((l) => l.followerClusterId === followerClusterId && l.followerIndex === followerIndex);
  const rec = {
    id: `sim-${Date.now()}`, leaderClusterId, followerClusterId, remoteAlias, leaderIndex, followerIndex,
    direction, status: 'linked', updatedAt: new Date().toISOString(),
  };
  if (idx >= 0) ccrLinks[idx] = rec; else ccrLinks.push(rec);
  renderArchDiagram();
}

function markLocalUnfollowed(followerClusterId, followerIndex) {
  const link = ccrLinks.find((l) => l.followerClusterId === followerClusterId && l.followerIndex === followerIndex);
  if (link) { link.status = 'unfollowed'; renderArchDiagram(); }
}

function removeLocalLink(followerClusterId, followerIndex) {
  ccrLinks = ccrLinks.filter((l) => !(l.followerClusterId === followerClusterId && l.followerIndex === followerIndex));
  renderArchDiagram();
}

function pulseArch(clusterId) {
  if (!currentPrimary || !currentDr) return;
  if (clusterId !== currentPrimary.id && clusterId !== currentDr.id) return;
  const line = document.getElementById('archArrowLine');
  if (!line) return;
  line.classList.remove('arch-pulse');
  // 강제 리플로우로 애니메이션 재시작
  void line.offsetWidth;
  line.classList.add('arch-pulse');
}

// ---------- 실시간 이벤트 피드 ----------
const feedItems = [];

function renderFeed() {
  const box = $('#eventFeed');
  box.innerHTML = feedItems.slice(0, 40).map((it) => `
    <div class="event-item ${it.ok === false ? 'ev-fail' : it.ok === true ? 'ev-ok' : ''}">
      <div class="ev-top"><span>${new Date(it.ts).toLocaleTimeString()}</span><span class="ev-badge">${it.ok === false ? '실패' : it.ok === true ? '성공' : '진행중'}</span></div>
      <div class="ev-label">${it.clusterName ? `[${it.clusterName}] ` : ''}${it.label}</div>
    </div>
  `).join('');
}

// ---------- SSE 연결 (실시간 트래픽 + 상태) ----------
function connectEventStream() {
  const es = new EventSource('/api/events/stream');
  es.onopen = () => $('#liveDot').classList.add('live-on');
  es.onerror = () => $('#liveDot').classList.remove('live-on');

  es.addEventListener('state', (msg) => {
    try {
      const state = JSON.parse(msg.data);
      applyState(state);
    } catch { /* ignore */ }
  });

  es.addEventListener('traffic', (msg) => {
    let evt;
    try { evt = JSON.parse(msg.data); } catch { return; }

    if (evt.phase === 'start') {
      pulseArch(evt.clusterId);
      feedItems.unshift({ ts: evt.timestamp, clusterName: evt.clusterName, label: evt.label, ok: null });
      renderFeed();
    } else if (evt.phase === 'end') {
      pulseArch(evt.clusterId);
      feedItems.unshift({ ts: evt.timestamp, clusterName: evt.clusterName, label: `${evt.label} (${evt.durationMs}ms)`, ok: evt.ok });
      renderFeed();
    }
  });
}

// ---------- 초기화 ----------
async function init() {
  await loadClusters();
  const state = await api('GET', '/api/state');
  applyState(state);
  connectEventStream();
}

init();

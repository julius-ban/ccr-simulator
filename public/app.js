const $ = (sel) => document.querySelector(sel);

let clusters = [];
let ccrLinks = [];
let monitorTimer = null;

// ---------- 공통 유틸 ----------
async function api(method, path, body) {
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

// ---------- 1. 클러스터 등록 ----------
async function loadClusters() {
  clusters = await api('GET', '/api/clusters');
  renderClusterList();
  const allSelects = [
    '#leaderSelect', '#followerSelect', '#sampleIndexCluster',
    '#monitorCluster', '#drCluster', '#failbackFollowerSelect',
  ];
  allSelects.forEach((sel) => fillSelect($(sel), clusters, '선택하세요'));
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
  const remoteAlias = $('#remoteAlias').value;
  const leaderIndex = $('#leaderIndex').value;
  if (!leaderClusterId) return alert('Leader 클러스터를 선택하세요.');

  const { result, keystoreCommand } = await api('POST', '/api/ccr/generate-api-key', {
    leaderClusterId, remoteAlias, leaderIndex,
  });
  appendLog('① API Key 발급', result);
  if (result.ok) {
    ccrState.keystoreCommand = keystoreCommand;
    $('#btnShowKeystore').disabled = false;
  }
});

$('#btnShowKeystore').addEventListener('click', () => {
  const box = $('#keystoreBox');
  box.style.display = 'block';
  box.textContent =
    '아래 명령어를 Follower 클러스터의 각 노드에서 실행한 뒤, ③ 버튼을 누르세요.\n\n' +
    (ccrState.keystoreCommand || '(발급된 명령어 없음)');
  $('#btnRegisterRemote').disabled = false;
});

$('#btnRegisterRemote').addEventListener('click', async () => {
  const followerClusterId = $('#followerSelect').value;
  const leaderClusterId = $('#leaderSelect').value;
  const remoteAlias = $('#remoteAlias').value;
  const leader = clusters.find((c) => c.id === leaderClusterId);
  if (!followerClusterId || !leader) return alert('Leader/Follower 클러스터를 확인하세요.');

  const result = await api('POST', '/api/ccr/register-remote', {
    followerClusterId,
    remoteAlias,
    leaderProxyHost: leader.host,
    leaderProxyPort: leader.proxyPort,
    serverName: leader.host,
  });
  appendLog('③ Remote Cluster 등록', result);
  if (result.settingsResult?.ok) {
    $('#btnFollow').disabled = false;
  }
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
});

// ---------- 4. 모니터링 ----------
$('#btnStartMonitor').addEventListener('click', () => {
  const clusterId = $('#monitorCluster').value;
  const indexName = $('#monitorIndex').value;
  if (!clusterId) return alert('클러스터를 선택하세요.');
  if (monitorTimer) clearInterval(monitorTimer);

  const tick = async () => {
    const result = await api('GET', `/api/ccr/stats/${clusterId}/${indexName}`);
    $('#monitorOutput').textContent = pretty(result);
  };
  tick();
  monitorTimer = setInterval(tick, 5000);
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
});

$('#btnPrepareFailback').addEventListener('click', async () => {
  if (!confirm('원 Primary의 기존 인덱스를 삭제합니다. 계속할까요?')) return;
  const clusterId = $('#failbackFollowerSelect').value;
  const indexName = $('#failbackFollowerIndex').value;
  const result = await api('POST', '/api/dr/prepare-failback', { clusterId, indexName });
  appendLog('① Failback 준비 (인덱스 삭제)', result);
});

let failbackState = {};

$('#btnFailbackGenKey').addEventListener('click', async () => {
  const drClusterId = $('#drCluster').value; // 이제 leader 역할
  const remoteAlias = $('#failbackAlias').value;
  const drIndex = $('#drIndex').value;
  if (!drClusterId) return alert('DR 클러스터(이제 leader)를 선택하세요.');

  const { result, keystoreCommand } = await api('POST', '/api/ccr/generate-api-key', {
    leaderClusterId: drClusterId, remoteAlias, leaderIndex: drIndex,
  });
  appendLog('② 역방향 API Key 발급', result);
  if (result.ok) {
    failbackState.keystoreCommand = keystoreCommand;
    $('#btnFailbackShowKeystore').disabled = false;
  }
});

$('#btnFailbackShowKeystore').addEventListener('click', () => {
  alert('아래 명령어를 원 Primary(이제 follower)의 각 노드에서 실행하세요:\n\n' + (failbackState.keystoreCommand || '(없음)'));
  $('#btnFailbackRegisterRemote').disabled = false;
});

$('#btnFailbackRegisterRemote').addEventListener('click', async () => {
  const followerClusterId = $('#failbackFollowerSelect').value;
  const drClusterId = $('#drCluster').value;
  const remoteAlias = $('#failbackAlias').value;
  const dr = clusters.find((c) => c.id === drClusterId);
  if (!followerClusterId || !dr) return alert('클러스터 선택을 확인하세요.');

  const result = await api('POST', '/api/ccr/register-remote', {
    followerClusterId,
    remoteAlias,
    leaderProxyHost: dr.host,
    leaderProxyPort: dr.proxyPort,
    serverName: dr.host,
  });
  appendLog('④ 역방향 Remote 등록', result);
  if (result.settingsResult?.ok) $('#btnFailbackFollow').disabled = false;
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
});

// ---------- 로그 ----------
function appendLog(title, data) {
  const box = $('#logOutput');
  box.textContent = `[${new Date().toLocaleTimeString()}] ${title}\n${pretty(data)}\n\n` + box.textContent;
}

$('#btnRefreshLog').addEventListener('click', async () => {
  const logs = await api('GET', '/api/logs');
  $('#logOutput').textContent = pretty(logs);
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

function roleBadge(clusterId, link) {
  if (!link) return { text: '역할 미지정', cls: 'arch-role-unknown' };
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

  const primaryBadge = currentPrimary ? roleBadge(currentPrimary.id, link) : { text: '', cls: '' };
  const drBadge = currentDr ? roleBadge(currentDr.id, link) : { text: '', cls: '' };

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

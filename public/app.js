const $ = (sel) => document.querySelector(sel);

let clusters = [];
let ccrLinks = [];
let monitorTimer = null;
const GUIDE_MODE = true; // 가이드 모드는 항상 켜져 있음 (토글 없음)

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

function isVisible(el) {
  // display:none인 조상이 있으면 offsetParent가 null이 됨 (표준적인 "화면에 안 보임" 판별법)
  return !!(el && el.offsetParent !== null);
}

function updateGuideHighlights() {
  document.querySelectorAll('.guide-next, .guide-dimmed').forEach((el) => el.classList.remove('guide-next', 'guide-dimmed'));
  if (!GUIDE_MODE) return;

  if (clusters.length < 2) {
    document.querySelector('#clusterForm button[type="submit"]')?.classList.add('guide-next');
    GUIDE_STEPS.forEach((id) => $('#' + id)?.classList.add('guide-dimmed'));
    return;
  }

  // 지금 화면에 안 보이는 단계(예: TLS 인증서 모드일 때 숨겨진 API Key 발급 버튼)는
  // 순서 계산에서 아예 제외합니다 - 안 그러면 그 뒤의 실제로 보이는 버튼들이 계속 흐리게 남습니다.
  const effectiveSteps = GUIDE_STEPS.filter((id) => isVisible($('#' + id)));
  const nextIdx = effectiveSteps.findIndex((id) => !guideCompleted.has(id));
  effectiveSteps.forEach((id, i) => {
    const btn = $('#' + id);
    if (!btn) return;
    if (i === nextIdx) btn.classList.add('guide-next');
    else if (nextIdx !== -1 && i > nextIdx) btn.classList.add('guide-dimmed');
  });
}

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

$('#btnResetAll').addEventListener('click', async () => {
  if (!confirm('정말 모든 클러스터 등록/CCR 상태/실행 로그를 초기화하시겠습니까?\n되돌릴 수 없습니다.')) return;
  await api('POST', '/api/reset');
  location.reload();
});

// ---------- 💾 시나리오 프리셋 ----------
const PRESET_CLUSTER_FIELDS = [
  'leaderSelect', 'followerSelect', 'drCluster', 'failbackFollowerSelect',
  'sampleIndexCluster', 'verifyClusterA', 'verifyClusterB', 'monitorCluster',
];
const PRESET_PLAIN_FIELDS = [
  'remoteAlias', 'leaderIndex', 'followerIndex', 'ccrAuthMode', 'ccrConnectionMode', 'extraSeeds',
  'sampleIndexName', 'sampleDims', 'sampleSimilarity', 'sampleSeedDocs', 'sampleBatchSize', 'sampleOffset',
  'monitorIndex', 'drIndex', 'failbackFollowerIndex', 'failbackAlias', 'failbackAuthMode', 'failbackConnectionMode', 'failbackExtraSeeds',
  'autoFollowName', 'autoFollowLeaderPattern', 'autoFollowFollowPattern',
  'bulkFollowIndexList', 'bulkFollowPattern',
  'verifyIndexA', 'verifyIndexB', 'verifyVectorField', 'verifyK',
];

function captureCurrentSettingsSnapshot() {
  const clusterFields = {};
  PRESET_CLUSTER_FIELDS.forEach((id) => {
    const el = $('#' + id);
    if (!el || !el.value) return;
    const c = clusters.find((cl) => cl.id === el.value);
    if (c) clusterFields[id] = c.name; // ID가 아니라 이름으로 저장 (재등록 후에도 매칭되게)
  });
  const plainFields = {};
  PRESET_PLAIN_FIELDS.forEach((id) => {
    const el = $('#' + id);
    if (el) plainFields[id] = el.value;
  });
  return { clusterFields, plainFields };
}

function applySettingsSnapshot(data) {
  const notFound = [];
  Object.entries(data.clusterFields || {}).forEach(([id, name]) => {
    const el = $('#' + id);
    if (!el) return;
    const c = clusters.find((cl) => cl.name === name);
    if (c) {
      el.value = c.id;
      el.dispatchEvent(new Event('change'));
    } else {
      notFound.push(`${id} → "${name}"`);
    }
  });
  Object.entries(data.plainFields || {}).forEach(([id, value]) => {
    const el = $('#' + id);
    if (el) {
      el.value = value;
      el.dispatchEvent(new Event('change'));
    }
  });
  if (notFound.length) {
    alert('아래 클러스터를 현재 등록된 목록에서 찾지 못했습니다 (이름이 같은 클러스터를 다시 등록해주세요):\n' + notFound.join('\n'));
  }
}

async function renderPresetsList() {
  const presets = await api('GET', '/api/presets');
  const box = $('#presetsList');
  if (!presets.length) {
    box.innerHTML = '<p class="hint">저장된 프리셋이 없습니다.</p>';
    return;
  }
  box.innerHTML = presets.map((p) => `
    <dt>${p.name}</dt>
    <dd>
      ${new Date(p.createdAt).toLocaleString()}
      <div class="step-buttons" style="margin-top:6px">
        <button type="button" data-load="${p.id}">불러오기</button>
        <button type="button" data-del="${p.id}" class="danger">삭제</button>
      </div>
    </dd>
  `).join('');

  box.querySelectorAll('[data-load]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = presets.find((p) => p.id === btn.dataset.load);
      if (preset) applySettingsSnapshot(preset.data);
      $('#presetsModal').style.display = 'none';
    });
  });
  box.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('이 프리셋을 삭제하시겠습니까?')) return;
      await api('DELETE', `/api/presets/${btn.dataset.del}`);
      renderPresetsList();
    });
  });
}

$('#btnOpenPresets').addEventListener('click', () => {
  $('#presetsModal').style.display = 'flex';
  renderPresetsList();
});
$('#btnClosePresets').addEventListener('click', () => { $('#presetsModal').style.display = 'none'; });
$('#presetsModal').addEventListener('click', (e) => {
  if (e.target.id === 'presetsModal') $('#presetsModal').style.display = 'none';
});

$('#btnSavePreset').addEventListener('click', async () => {
  const name = $('#presetNameInput').value.trim();
  if (!name) return alert('프리셋 이름을 입력하세요.');
  const data = captureCurrentSettingsSnapshot();
  await api('POST', '/api/presets', { name, data });
  $('#presetNameInput').value = '';
  renderPresetsList();
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
      <span>${c.host}:${c.restPort} (proxy ${c.proxyPort} / transport ${c.transportPort || 9300}) · ${(c.protocol || 'https').toUpperCase()}</span>
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

// ---- CCR 인증 방식(API Key/TLS 인증서) & 연결 모드(Sniff/Proxy) 토글 ----
// API Key 인증은 항상 Proxy 모드만 지원 (원격 클러스터 서버 인터페이스 자체가 proxy 전용).
// TLS 인증서 인증은 Sniff(기본)/Proxy 둘 다 선택 가능.
function wireAuthModeControls(authModeId, connModeId, extraSeedsFieldId, apiKeyStepsGroupId, certInfoId) {
  const authSel = $('#' + authModeId);
  const connSel = $('#' + connModeId);
  const extraSeedsField = $('#' + extraSeedsFieldId);
  const apiKeyGroup = apiKeyStepsGroupId ? $('#' + apiKeyStepsGroupId) : null;
  const certInfo = $('#' + certInfoId);

  function apply() {
    const isCert = authSel.value === 'cert';
    if (apiKeyGroup) apiKeyGroup.style.display = isCert ? 'none' : 'flex';
    certInfo.style.display = isCert ? 'block' : 'none';
    connSel.disabled = !isCert;
    if (!isCert) {
      connSel.value = 'proxy'; // API Key 인증은 Proxy 고정
    } else if (!connSel.dataset.userSet) {
      connSel.value = 'sniff'; // 인증서 인증 기본값은 Sniff
    }
    extraSeedsField.style.display = isCert && connSel.value === 'sniff' ? 'flex' : 'none';
    updateGuideHighlights();
  }

  authSel.addEventListener('change', apply);
  connSel.addEventListener('change', () => {
    connSel.dataset.userSet = '1';
    extraSeedsField.style.display = authSel.value === 'cert' && connSel.value === 'sniff' ? 'flex' : 'none';
    updateGuideHighlights();
  });
  apply();
}

wireAuthModeControls('ccrAuthMode', 'ccrConnectionMode', 'extraSeedsField', 'apiKeyStepsGroup', 'certAuthInfo');
wireAuthModeControls('failbackAuthMode', 'failbackConnectionMode', 'failbackExtraSeedsField', 'failbackApiKeyStepsGroup', 'failbackCertAuthInfo');

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

// ---------- 📤 설정 내보내기 (실제 요청 이력 기반) ----------
function triggerDownload(filename, text) {
  const blob = new Blob([text], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * 내보내기에 포함할 "의미있는" 요청만 고릅니다 (읽기 전용 헬스체크/폴링/사전점검 조회는 제외).
 * 인덱스 생성, remote 등록, follow, auto-follow, bulk, failover/failback 각 단계, 인덱스 삭제 등
 * "실제로 클러스터 상태를 바꾼(또는 바꾸려고 시도한) 요청"만 남깁니다.
 */
function isExportableCall(method, path) {
  const p = (path || '').toLowerCase();
  if (p.includes('cross_cluster/api_key')) return true;
  if (p.includes('_cluster/settings')) return true;
  if (p.includes('_ccr/follow')) return true;
  if (p.includes('_ccr/auto_follow')) return true;
  if (p.includes('_ccr/pause_follow')) return true;
  if (p.includes('_ccr/unfollow')) return true;
  if (p.endsWith('/_close') || p.endsWith('/_open')) return true;
  if (p.includes('_bulk')) return true;
  if (method === 'PUT' && /^\/[^/]+$/.test(path)) return true; // 인덱스 생성 (PUT /인덱스명)
  if (method === 'DELETE' && /^\/[^/]+$/.test(path)) return true; // 인덱스 삭제
  return false;
}

function formatBodyForExport(body) {
  if (body === undefined || body === null || body === '') return null;
  let text;
  if (typeof body === 'string') {
    text = body.trim(); // _bulk의 NDJSON은 이미 문자열
  } else {
    text = JSON.stringify(body, null, 2);
  }
  const MAX = 3000;
  if (text.length > MAX) {
    text = text.slice(0, MAX) + `\n... (생략됨, 전체 ${text.length.toLocaleString()}자 중 앞부분만 표시)`;
  }
  return text;
}

function buildSessionExportMarkdown() {
  const relevant = apiCallHistory.filter((c) => isExportableCall(c.method, c.path));
  if (relevant.length === 0) return null;

  const lines = [
    '# CCR 세션 실행 이력 내보내기',
    '',
    `생성 시각: ${new Date().toLocaleString()}`,
    '',
    '이 문서는 폼 값을 추측해서 재구성한 게 아니라, **이번 세션에서 실제로 클러스터에 전송된 요청**을',
    '실행 순서 그대로 캡처한 것입니다. 읽기 전용 조회(헬스체크/라이선스/모니터링 폴링/사전점검)는',
    '제외하고, 실제로 상태를 바꾼 요청만 담았습니다.',
    '',
    '---',
    '',
  ];

  relevant.forEach((c, i) => {
    const bodyText = formatBodyForExport(c.body);
    const baseUrl = c.host ? `${c.protocol || 'https'}://${c.host}:${c.restPort || '?'}` : null;
    const fullUrl = baseUrl ? `${baseUrl}${c.path}` : c.path;
    lines.push(`## ${i + 1}. ${c.label}`);
    lines.push('');
    lines.push(`- 시각: ${new Date(c.ts).toLocaleString()}`);
    lines.push(`- 대상 클러스터: ${c.clusterName || '-'}${c.clusterRole ? ` (${c.clusterRole === 'primary' ? '주센터' : c.clusterRole === 'dr' ? 'DR센터' : c.clusterRole})` : ''}`);
    if (baseUrl) lines.push(`- 요청 주소: ${baseUrl}`);
    lines.push(`- 결과: ${c.ok ? `✅ 성공 (HTTP ${c.status})` : `❌ 실패 (HTTP ${c.status})`}`);
    lines.push('');
    lines.push('```http');
    lines.push(`${c.method} ${fullUrl}`);
    lines.push('```');
    if (bodyText) {
      lines.push('');
      lines.push('```json');
      lines.push(bodyText);
      lines.push('```');
    }
    lines.push('');
  });

  lines.push('---');
  lines.push('이 파일은 ES CCR Failover/Failback 가이드 콘솔에서 자동 생성되었습니다.');
  return lines.join('\n');
}

$('#btnExportConfig').addEventListener('click', () => {
  const md = buildSessionExportMarkdown();
  if (!md) {
    alert('아직 내보낼 실행 이력이 없습니다. CCR 연동/샘플 인덱스 등 단계를 먼저 몇 개 진행한 뒤 다시 눌러주세요.');
    return;
  }
  triggerDownload(`ccr-session-export-${Date.now()}.md`, md);
});

// ---------- 🩺 사전 점검 (닥터) ----------
function renderPrecheckResult(elId, data) {
  const box = $(elId);
  box.style.display = 'block';
  if (data.error) {
    box.innerHTML = `<div class="verify-summary mismatch">${data.error}</div>`;
    return;
  }
  const icon = { pass: '✅', warn: '⚠️', fail: '❌' };
  const overallClass = data.overall === 'pass' ? 'match' : 'mismatch';
  box.innerHTML = `
    <div class="verify-summary ${overallClass}">
      ${icon[data.overall] || ''} 종합 결과: ${data.overall === 'pass' ? '모두 통과' : data.overall === 'warn' ? '주의 필요' : '문제 발견'}
    </div>
    <table class="verify-table">
      <tr><th>항목</th><th>결과</th><th>내용</th></tr>
      ${data.checks.map((c) => `<tr><td>${c.name}</td><td>${icon[c.status] || c.status}</td><td>${c.message}</td></tr>`).join('')}
    </table>`;
}

$('#btnPrecheck').addEventListener('click', async () => {
  const leaderClusterId = $('#leaderSelect').value;
  const followerClusterId = $('#followerSelect').value;
  if (!leaderClusterId || !followerClusterId) return alert('Leader/Follower 클러스터를 선택하세요.');

  const btn = $('#btnPrecheck');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '점검 중...';

  const result = await api('POST', '/api/ccr/precheck', {
    leaderClusterId, followerClusterId,
    leaderIndex: $('#leaderIndex').value,
    remoteAlias: $('#remoteAlias').value,
    authMode: $('#ccrAuthMode').value,
  });
  appendLog('🩺 사전 점검', result);
  renderPrecheckResult('#precheckResult', result);

  btn.disabled = false;
  btn.textContent = originalText;
});

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
    authMode: $('#ccrAuthMode').value,
    connectionMode: $('#ccrConnectionMode').value,
    leaderHost: leader.host,
    leaderProxyPort: leader.proxyPort,
    leaderTransportPort: leader.transportPort || 9300,
    extraSeeds: $('#extraSeeds').value,
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

// ---------- 다중 인덱스 일괄 Follow ----------
$('#btnBulkFollow').addEventListener('click', async () => {
  const followerClusterId = $('#followerSelect').value;
  const leaderClusterId = $('#leaderSelect').value;
  const remoteAlias = $('#remoteAlias').value;
  if (!followerClusterId || !leaderClusterId) return alert('Leader/Follower 클러스터를 선택하세요.');

  const raw = $('#bulkFollowIndexList').value;
  const indexNames = raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  if (indexNames.length === 0) return alert('Leader 인덱스 목록을 입력하세요.');

  const pattern = $('#bulkFollowPattern').value || '{{leader_index}}-follower';
  const btn = $('#btnBulkFollow');
  const originalText = btn.textContent;
  btn.disabled = true;

  const box = $('#bulkFollowResult');
  box.style.display = 'block';
  const rows = indexNames.map((name) => ({ leaderIndex: name, followerIndex: pattern.replace('{{leader_index}}', name), status: '대기중' }));

  const renderRows = () => {
    box.innerHTML = `<table class="verify-table">
      <tr><th>Leader 인덱스</th><th>Follower 인덱스</th><th>결과</th></tr>
      ${rows.map((r) => `<tr><td>${r.leaderIndex}</td><td>${r.followerIndex}</td><td>${r.status}</td></tr>`).join('')}
    </table>`;
  };
  renderRows();

  for (let i = 0; i < rows.length; i++) {
    btn.textContent = `실행 중... (${i + 1}/${rows.length})`;
    rows[i].status = '⏳ 진행중';
    renderRows();

    const result = await api('POST', '/api/ccr/follow', {
      followerClusterId, leaderClusterId, remoteAlias,
      leaderIndex: rows[i].leaderIndex, followerIndex: rows[i].followerIndex,
      direction: 'primary-to-dr',
    });
    rows[i].status = result.result?.ok ? '✅ 성공' : `❌ 실패: ${result.result?.response?.error?.reason || result.result?.response?.error || '알 수 없는 오류'}`;
    appendLog(`일괄 Follow: ${rows[i].leaderIndex}`, result);
    renderRows();
  }

  btn.disabled = false;
  btn.textContent = originalText;
});

// ---------- Auto-follow 패턴 ----------
$('#btnAutoFollowCreate').addEventListener('click', async () => {
  const followerClusterId = $('#followerSelect').value;
  if (!followerClusterId) return alert('Follower 클러스터(DR센터)를 선택하세요.');

  const result = await api('POST', '/api/ccr/auto-follow', {
    followerClusterId,
    patternName: $('#autoFollowName').value,
    remoteAlias: $('#remoteAlias').value,
    leaderIndexPatterns: $('#autoFollowLeaderPattern').value,
    followIndexPattern: $('#autoFollowFollowPattern').value,
  });
  appendLog('Auto-follow 패턴 생성', result);
  $('#autoFollowResult').style.display = 'block';
  $('#autoFollowResult').textContent = pretty(result);
});

$('#btnAutoFollowStatus').addEventListener('click', async () => {
  const followerClusterId = $('#followerSelect').value;
  const patternName = $('#autoFollowName').value;
  if (!followerClusterId) return alert('Follower 클러스터(DR센터)를 선택하세요.');

  const result = await api('GET', `/api/ccr/auto-follow/${followerClusterId}/${patternName}`);
  appendLog('Auto-follow 상태 조회', result);
  $('#autoFollowResult').style.display = 'block';
  $('#autoFollowResult').textContent = pretty(result);
});

$('#btnAutoFollowDelete').addEventListener('click', async () => {
  const followerClusterId = $('#followerSelect').value;
  const patternName = $('#autoFollowName').value;
  if (!followerClusterId) return alert('Follower 클러스터(DR센터)를 선택하세요.');
  if (!confirm(`Auto-follow 패턴 '${patternName}'을 삭제하시겠습니까? (이미 생성된 팔로워 인덱스는 유지됩니다)`)) return;

  const result = await api('DELETE', `/api/ccr/auto-follow/${followerClusterId}/${patternName}`);
  appendLog('Auto-follow 패턴 삭제', result);
  $('#autoFollowResult').style.display = 'block';
  $('#autoFollowResult').textContent = pretty(result);
});

// ---------- 3. 샘플 벡터 인덱스 ----------
$('#btnCreateSampleIndex').addEventListener('click', async () => {
  const clusterId = $('#sampleIndexCluster').value;
  if (!clusterId) return alert('클러스터를 선택하세요.');
  const result = await api('POST', '/api/index-mgmt/sample-index', { clusterId, ...sampleIndexFormValues() });
  appendLog('샘플 벡터 인덱스 생성', result);
  markGuideStep('btnCreateSampleIndex');
});

function sampleIndexFormValues() {
  return {
    indexName: $('#sampleIndexName').value,
    dims: $('#sampleDims').value,
    similarity: $('#sampleSimilarity').value,
    seedDocs: $('#sampleSeedDocs').value,
    batchSize: $('#sampleBatchSize').value,
    offset: $('#sampleOffset').value,
    insertMode: $('#sampleInsertMode').value,
    customBody: $('#sampleCustomBody').value.trim() || undefined,
  };
}

$('#btnPreviewSampleApi').addEventListener('click', async () => {
  const preview = await api('POST', '/api/index-mgmt/preview', sampleIndexFormValues());

  const idx = preview.indexRequest;
  $('#indexApiTab').innerHTML = `<pre class="api-body-example">${idx.method} ${idx.path}

${idx.error ? `❌ JSON 파싱 오류: ${idx.error}` : JSON.stringify(idx.body, null, 2)}</pre>`;

  const bulk = preview.bulkRequest;
  $('#bulkApiTab').innerHTML = `<pre class="api-body-example">${bulk.method} ${bulk.path}

${bulk.note}

${bulk.sampleBody || '(없음)'}</pre>`;

  $('#apiPreviewModal').style.display = 'flex';
});

document.querySelectorAll('#apiPreviewModal .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#apiPreviewModal .tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    $('#indexApiTab').style.display = btn.dataset.tab === 'indexApiTab' ? 'block' : 'none';
    $('#bulkApiTab').style.display = btn.dataset.tab === 'bulkApiTab' ? 'block' : 'none';
  });
});
$('#btnCloseApiPreview').addEventListener('click', () => { $('#apiPreviewModal').style.display = 'none'; });
$('#apiPreviewModal').addEventListener('click', (e) => {
  if (e.target.id === 'apiPreviewModal') $('#apiPreviewModal').style.display = 'none';
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
    authMode: $('#failbackAuthMode').value,
    connectionMode: $('#failbackConnectionMode').value,
    leaderHost: dr.host,
    leaderProxyPort: dr.proxyPort,
    leaderTransportPort: dr.transportPort || 9300,
    extraSeeds: $('#failbackExtraSeeds').value,
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
  $('#logOutput').textContent = ''; // 완전히 비우고 나서 새로 채움 (이전 내용 잔존 방지)
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

// ---------- 실제 API 요청 이력 (설정 내보내기가 이걸 그대로 사용) ----------
const apiCallHistory = [];
const API_CALL_HISTORY_MAX = 300;

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

      // 실제로 완료된 요청만 이력에 담음 (성공/실패 다 포함 - 실패도 "실제로 이렇게 요청했다"는 기록)
      apiCallHistory.push({
        ts: evt.timestamp,
        clusterName: evt.clusterName,
        clusterRole: evt.clusterRole,
        host: evt.host,
        protocol: evt.protocol,
        restPort: evt.restPort,
        label: evt.label,
        method: evt.method,
        path: evt.path,
        body: evt.body,
        ok: evt.ok,
        status: evt.status,
      });
      if (apiCallHistory.length > API_CALL_HISTORY_MAX) apiCallHistory.shift();
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

const axios = require('axios');
const https = require('https');
const tls = require('tls');
const { decrypt } = require('./crypto');
const { emitTraffic } = require('./eventBus');

/**
 * remote cluster server 포트(보통 9443)가 실제로 응답하는지 ES REST 호출과 무관하게
 * 원시 소켓으로 먼저 찔러봅니다. remote cluster server는 항상 TLS를 쓰므로,
 * TLS 핸드셰이크가 성공하면 "최소한 뭔가가 이 포트에서 TLS로 응답한다"는 강한 신호입니다.
 * (같은 포트에서 실제로 remote_cluster_server가 응답하는지까지는 ES 프로토콜 레벨 확인이
 *  필요하지만, TCP/TLS 단계에서 이미 막혀있다면 여기서 바로 알 수 있습니다.)
 */
function probeRemotePort(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let socket;
    try {
      socket = tls.connect({ host, port, rejectUnauthorized: false, timeout: timeoutMs }, () => {
        finish({ reachable: true, tlsHandshake: true });
        socket.destroy();
      });
    } catch (e) {
      finish({ reachable: false, tlsHandshake: false, error: e.message });
      return;
    }

    socket.on('error', (err) => {
      // TLS 핸드셰이크 자체는 실패해도 소켓 연결은 됐을 수 있음 (예: 순수 TCP는 열려있지만 TLS 아님)
      finish({ reachable: false, tlsHandshake: false, error: err.message });
    });
    socket.on('timeout', () => {
      finish({ reachable: false, tlsHandshake: false, error: `연결 시도 ${timeoutMs}ms 초과 (포트가 닫혀있거나 방화벽에 막혀있을 가능성)` });
      socket.destroy();
    });
  });
}

/**
 * 등록된 클러스터 레코드로부터 axios 인스턴스를 생성합니다.
 * cluster: { host, restPort, protocol('http'|'https'), authType('basic'|'apikey'), username, encPassword, encApiKey, insecureTLS }
 */
function buildClient(cluster) {
  const protocol = cluster.protocol === 'http' ? 'http' : 'https'; // 기본값 https
  const baseURL = `${protocol}://${cluster.host}:${cluster.restPort}`;

  const headers = { 'Content-Type': 'application/json' };
  let auth;

  if (cluster.authType === 'apikey') {
    const apiKey = decrypt(cluster.encApiKey);
    headers.Authorization = `ApiKey ${apiKey}`;
  } else {
    auth = { username: cluster.username, password: decrypt(cluster.encPassword) };
  }

  const httpsAgent = new https.Agent({
    rejectUnauthorized: cluster.insecureTLS ? false : true,
  });

  return axios.create({
    baseURL,
    headers,
    auth,
    httpsAgent,
    timeout: 30000,
    validateStatus: () => true, // 에러 응답도 우리가 직접 판단해서 처리
  });
}

/**
 * 공통 호출 래퍼. 성공/실패 여부와 원문 응답을 그대로 리턴해서
 * 프론트엔드 로그 패널에 그대로 찍을 수 있게 합니다.
 *
 * context: { label } - 이 호출이 절차상 어떤 의미인지 (예: 'CCR API Key 발급')
 *          프론트엔드 실시간 다이어그램/트래픽 로그에 그대로 노출됩니다.
 * 호출 시작/종료를 모두 이벤트로 쏴서, 프론트에서 "지금 어떤 요청이 어느 클러스터로
 * 날아가고 있는지"를 실시간으로 보여줄 수 있게 합니다.
 */
async function call(cluster, method, path, data, context = {}) {
  const client = buildClient(cluster);
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const base = {
    requestId,
    clusterId: cluster.id,
    clusterName: cluster.name,
    clusterRole: cluster.role,
    method,
    path,
    label: context.label || `${method} ${path}`,
  };

  emitTraffic({ phase: 'start', ...base });
  const startedAt = Date.now();

  try {
    const requestConfig = { method, url: path, data };
    // data가 이미 완성된 문자열(예: _bulk의 NDJSON)인 경우, axios 기본 transformRequest가
    // Content-Type: application/json을 보고 JSON.stringify를 또 적용해버려서 개행이
    // \n 문자열로 escape되는 문제가 있었음. 문자열 바디는 그대로(raw) 전송하도록 강제.
    if (typeof data === 'string') {
      requestConfig.headers = { 'Content-Type': 'application/x-ndjson' };
      requestConfig.transformRequest = [(d) => d];
    }
    const res = await client.request(requestConfig);
    const durationMs = Date.now() - startedAt;
    const ok = res.status >= 200 && res.status < 300;
    emitTraffic({ phase: 'end', ok, status: res.status, durationMs, ...base });
    return {
      ok,
      status: res.status,
      path,
      method,
      response: res.data,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const status = err.response?.status || 0;
    emitTraffic({ phase: 'end', ok: false, status, durationMs, ...base });
    return {
      ok: false,
      status,
      path,
      method,
      response: err.response?.data || { error: err.message },
    };
  }
}

module.exports = { buildClient, call, probeRemotePort };

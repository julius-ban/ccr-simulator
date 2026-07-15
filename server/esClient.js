const axios = require('axios');
const https = require('https');
const { decrypt } = require('./crypto');
const { emitTraffic } = require('./eventBus');

/**
 * 등록된 클러스터 레코드로부터 axios 인스턴스를 생성합니다.
 * cluster: { host, restPort, authType('basic'|'apikey'), username, encPassword, encApiKey, insecureTLS }
 */
function buildClient(cluster) {
  const baseURL = `https://${cluster.host}:${cluster.restPort}`;

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
    timeout: 15000,
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
    const res = await client.request({ method, url: path, data });
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

module.exports = { buildClient, call };

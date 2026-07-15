const { EventEmitter } = require('events');

// 백엔드가 각 클러스터로 보내는 모든 REST 호출을 브로드캐스트하기 위한 전역 버스.
// SSE(/api/events/stream)가 이걸 구독해서 프론트엔드 실시간 다이어그램/로그에 흘려보냄.
const bus = new EventEmitter();
bus.setMaxListeners(50);

let seq = 0;
function emitTraffic(evt) {
  seq += 1;
  bus.emit('traffic', { seq, timestamp: new Date().toISOString(), ...evt });
}

module.exports = { bus, emitTraffic };

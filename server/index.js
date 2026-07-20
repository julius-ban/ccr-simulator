require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { db } = require('./db');
const { bus } = require('./eventBus');
const { snapshot } = require('./stateBroadcast');

const clustersRouter = require('./routes/clusters');
const ccrRouter = require('./routes/ccr');
const indexMgmtRouter = require('./routes/index-mgmt');
const failoverRouter = require('./routes/failover');
const verifyRouter = require('./routes/verify');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.use('/api/clusters', clustersRouter);
app.use('/api/ccr', ccrRouter);
app.use('/api/index-mgmt', indexMgmtRouter);
app.use('/api/dr', failoverRouter);
app.use('/api/verify', verifyRouter);

app.get('/api/logs', (req, res) => {
  const logs = db.get('actionLog').takeRight ? db.get('actionLog').value() : db.get('actionLog').value();
  res.json(logs.slice(-200).reverse());
});

// 클러스터 목록 + 현재 CCR 연결 상태(리더/팔로워, 방향) 스냅샷.
// 우측 아키텍처 다이어그램이 처음 로드될 때 이걸로 초기 렌더링을 합니다.
app.get('/api/state', (req, res) => {
  res.json(snapshot());
});

// 실시간 스트림 - 두 종류의 이벤트를 함께 흘려보냅니다.
//  - 'traffic': 백엔드가 각 클러스터로 보내는 개별 REST 호출 (시작/종료)
//  - 'state'  : 클러스터/CCR 링크 상태가 바뀔 때마다 전체 스냅샷 (다이어그램 갱신용)
app.get('/api/events/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write(`retry: 2000\n\n`);
  res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);

  const onTraffic = (evt) => {
    res.write(`event: traffic\ndata: ${JSON.stringify(evt)}\n\n`);
  };
  const onState = (evt) => {
    res.write(`event: state\ndata: ${JSON.stringify(evt)}\n\n`);
  };
  bus.on('traffic', onTraffic);
  bus.on('state', onState);

  const heartbeat = setInterval(() => res.write(':hb\n\n'), 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off('traffic', onTraffic);
    bus.off('state', onState);
  });
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`CCR automation UI listening on http://localhost:${PORT}`);
});

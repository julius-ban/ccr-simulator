const path = require('path');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const adapter = new FileSync(path.join(__dirname, '..', 'data', 'db.json'));
const db = low(adapter);

// 초기 스키마
// ccrLinks: 현재 진행 중인 CCR 연결 상태를 추적 (아키텍처 다이어그램의 근거 데이터).
// 예: { id, leaderClusterId, followerClusterId, remoteAlias, leaderIndex, followerIndex,
//       direction: 'primary-to-dr'|'dr-to-primary', status: 'linked'|'unfollowed', updatedAt }
db.defaults({ clusters: [], actionLog: [], ccrLinks: [] }).write();

function addLog(entry) {
  db.get('actionLog')
    .push({ ...entry, timestamp: new Date().toISOString() })
    .write();
}

module.exports = { db, addLog };

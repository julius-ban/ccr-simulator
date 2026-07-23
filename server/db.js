const path = require('path');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const adapter = new FileSync(path.join(__dirname, '..', 'data', 'db.json'));
const db = low(adapter);

// 초기 스키마
// ccrLinks: 현재 진행 중인 CCR 연결 상태를 추적 (아키텍처 다이어그램의 근거 데이터).
// 예: { id, leaderClusterId, followerClusterId, remoteAlias, leaderIndex, followerIndex,
//       direction: 'primary-to-dr'|'dr-to-primary', status: 'linked'|'unfollowed', updatedAt }
// presets: 화면 입력값 스냅샷을 이름 붙여 저장 (클러스터는 ID가 아니라 이름으로 저장 -
//          초기화/재등록 후에도 이름으로 다시 매칭 가능하게 하기 위함)
db.defaults({ clusters: [], actionLog: [], ccrLinks: [], presets: [] }).write();

function addLog(entry) {
  db.get('actionLog')
    .push({ ...entry, timestamp: new Date().toISOString() })
    .write();
}

module.exports = { db, addLog };

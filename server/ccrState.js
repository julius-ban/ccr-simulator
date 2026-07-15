const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');
const { broadcastState } = require('./stateBroadcast');

function getLinks() {
  return db.get('ccrLinks').value() || [];
}

/**
 * follower index 하나에 대한 CCR 연결을 등록/갱신합니다.
 * 같은 (followerClusterId, followerIndex) 조합이 이미 있으면 갱신, 없으면 새로 추가.
 */
function upsertLink({ leaderClusterId, followerClusterId, remoteAlias, leaderIndex, followerIndex, direction }) {
  const links = db.get('ccrLinks');
  const existing = links.find({ followerClusterId, followerIndex }).value();
  const now = new Date().toISOString();

  if (existing) {
    links.find({ followerClusterId, followerIndex }).assign({
      leaderClusterId, remoteAlias, leaderIndex, direction, status: 'linked', updatedAt: now,
    }).write();
  } else {
    links.push({
      id: uuidv4(),
      leaderClusterId, followerClusterId, remoteAlias, leaderIndex, followerIndex,
      direction, status: 'linked', createdAt: now, updatedAt: now,
    }).write();
  }
  broadcastState();
}

/** Failover 등으로 팔로잉이 해제되어 독립 인덱스가 된 경우 */
function markUnfollowed(followerClusterId, followerIndex) {
  db.get('ccrLinks')
    .find({ followerClusterId, followerIndex })
    .assign({ status: 'unfollowed', updatedAt: new Date().toISOString() })
    .write();
  broadcastState();
}

/** Remote cluster 설정 자체를 제거한 경우 (역방향 정리 등) 링크 레코드도 정리 */
function removeLink(followerClusterId, followerIndex) {
  db.get('ccrLinks').remove({ followerClusterId, followerIndex }).write();
  broadcastState();
}

module.exports = { getLinks, upsertLink, markUnfollowed, removeLink };

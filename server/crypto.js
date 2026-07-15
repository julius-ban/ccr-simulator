const crypto = require('crypto');

// ENCRYPTION_KEY는 32바이트 hex 문자열이어야 합니다 (.env 참고)
function getKey() {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex || keyHex === 'REPLACE_WITH_32_BYTE_HEX_KEY') {
    throw new Error(
      'ENCRYPTION_KEY가 설정되지 않았습니다. .env 파일에 32바이트 랜덤 hex 키를 설정하세요. ' +
      '생성 예시: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY는 32바이트(64자리 hex)여야 합니다.');
  }
  return key;
}

function encrypt(plainText) {
  if (plainText === undefined || plainText === null || plainText === '') return null;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decrypt(payloadB64) {
  if (!payloadB64) return null;
  const key = getKey();
  const payload = Buffer.from(payloadB64, 'base64');
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };

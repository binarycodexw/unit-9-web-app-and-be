import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

// AES-256-GCM, output is iv.tag.ciphertext in base64url
export function encrypt(plainText, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.');
}

export function decrypt(payload, key) {
  const [iv, tag, encrypted] = payload.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// constant-time compare, used for the csrf token
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { decrypt, encrypt } from '../utils/crypto.js';

export function createMfaSecret() {
  return generateSecret();
}

export async function buildEnrolment(email, secret) {
  const otpauthUri = generateURI({ issuer: config.appName, label: email, secret });
  const qrDataUrl = await QRCode.toDataURL(otpauthUri, { margin: 1, width: 220 });
  return { otpauthUri, qrDataUrl };
}

export function encryptSecret(secret) {
  return encrypt(secret, config.mfaEncryptionKey);
}

export function decryptSecret(encryptedSecret) {
  return decrypt(encryptedSecret, config.mfaEncryptionKey);
}

// epochTolerance: 30 accepts the neighbouring 30s step (clock drift).
// afterTimeStep rejects a step that was already used, so a code can't be replayed.
export async function verifyTotp(secret, token, lastTimeStep = null) {
  const options = { secret, token, epochTolerance: 30 };
  if (lastTimeStep !== null && lastTimeStep !== undefined) {
    options.afterTimeStep = Number(lastTimeStep);
  }

  try {
    const result = await verify(options);
    return { valid: Boolean(result.valid), timeStep: result.valid ? result.timeStep : null };
  } catch {
    return { valid: false, timeStep: null };
  }
}

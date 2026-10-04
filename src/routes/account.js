import { Router } from 'express';
import argon2 from 'argon2';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimit.js';
import {
  buildEnrolment,
  createMfaSecret,
  decryptSecret,
  encryptSecret,
  verifyTotp,
} from '../services/mfa.js';
import { logSecurityEvent } from '../utils/audit.js';
import { destroySession, flash } from '../utils/session.js';
import { parseForm, safeValues } from '../validation/parse.js';
import { mfaCodeSchema, mfaDisableSchema } from '../validation/schemas.js';

const router = Router();
router.use('/account', requireAuth);

async function renderAccount(res, req, { status = 200, errors = {}, values = {} } = {}) {
  res.status(status).render('account', { title: 'Account', errors, values });
}

router.get('/account', async (req, res) => {
  await renderAccount(res, req);
});


router.get('/account/mfa/setup', async (req, res) => {
  if (req.user.mfa_enabled) return res.redirect('/account');

  // the pending secret stays in the session until a code is confirmed
  if (!req.session.pendingMfaSecret) {
    req.session.pendingMfaSecret = createMfaSecret();
  }
  const secret = req.session.pendingMfaSecret;
  const { qrDataUrl } = await buildEnrolment(req.user.email, secret);

  return res.render('mfa-setup', { title: 'Enable two-factor authentication', qrDataUrl, secret, errors: {} });
});

router.post('/account/mfa/enable', authLimiter, async (req, res) => {
  const secret = req.session.pendingMfaSecret;
  if (req.user.mfa_enabled || !secret) return res.redirect('/account');

  const { data, errors } = parseForm(mfaCodeSchema, req.body);
  const result = data ? await verifyTotp(secret, data.code) : { valid: false };

  if (errors || !result.valid) {
    const { qrDataUrl } = await buildEnrolment(req.user.email, secret);
    return res.status(400).render('mfa-setup', {
      title: 'Enable two-factor authentication',
      qrDataUrl,
      secret,
      errors: errors ?? { code: 'Incorrect code. Check your authenticator app and try again.' },
    });
  }

  await query(
    `UPDATE users
        SET mfa_enabled = TRUE, mfa_secret_encrypted = $2, mfa_last_time_step = $3
      WHERE id = $1`,
    [req.user.id, encryptSecret(secret), result.timeStep],
  );
  delete req.session.pendingMfaSecret;
  await logSecurityEvent(req, 'mfa_enabled');

  flash(req, 'success', 'Two-factor authentication is now enabled.');
  return res.redirect('/account');
});

router.post('/account/mfa/disable', authLimiter, async (req, res) => {
  if (!req.user.mfa_enabled) return res.redirect('/account');

  const { data, errors } = parseForm(mfaDisableSchema, req.body);
  if (errors) {
    return renderAccount(res, req, { status: 400, errors, values: safeValues(req.body) });
  }

  // turning MFA off needs the password and a valid code
  const { rows } = await query(
    'SELECT password_hash, mfa_secret_encrypted, mfa_last_time_step FROM users WHERE id = $1',
    [req.user.id],
  );
  const passwordOk = await argon2.verify(rows[0].password_hash, data.password).catch(() => false);
  const totp = passwordOk
    ? await verifyTotp(decryptSecret(rows[0].mfa_secret_encrypted), data.code, rows[0].mfa_last_time_step)
    : { valid: false };

  if (!passwordOk || !totp.valid) {
    await logSecurityEvent(req, 'mfa_disable_failed');
    return renderAccount(res, req, {
      status: 401,
      errors: { _mfa: 'Password or code is incorrect.' },
    });
  }

  await query(
    `UPDATE users
        SET mfa_enabled = FALSE, mfa_secret_encrypted = NULL, mfa_last_time_step = NULL
      WHERE id = $1`,
    [req.user.id],
  );
  await logSecurityEvent(req, 'mfa_disabled');
  flash(req, 'success', 'Two-factor authentication was disabled.');
  return res.redirect('/account');
});

// delete account, watchlists and items go with it (cascade)

router.post('/account/delete', authLimiter, async (req, res) => {
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  const passwordOk = password.length > 0 && (await argon2.verify(rows[0].password_hash, password).catch(() => false));

  if (!passwordOk) {
    await logSecurityEvent(req, 'account_delete_failed');
    return renderAccount(res, req, { status: 401, errors: { _delete: 'Password is incorrect.' } });
  }

  await logSecurityEvent(req, 'account_deleted');
  await query('DELETE FROM users WHERE id = $1', [req.user.id]);
  await destroySession(req);
  res.clearCookie('sid');
  return res.redirect('/');
});

export default router;

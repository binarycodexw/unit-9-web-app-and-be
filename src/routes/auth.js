import { Router } from 'express';
import argon2 from 'argon2';
import { query, withTransaction } from '../db.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { redirectIfAuthenticated } from '../middleware/auth.js';
import { decryptSecret, verifyTotp } from '../services/mfa.js';
import { logSecurityEvent } from '../utils/audit.js';
import { destroySession, flash, regenerateSession, safeRedirectPath, saveSession } from '../utils/session.js';
import { parseForm, safeValues } from '../validation/parse.js';
import { loginSchema, mfaCodeSchema, registerSchema } from '../validation/schemas.js';

const router = Router();

// Argon2id settings from the OWASP password storage cheat sheet
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const MFA_STEP_TTL_MS = 5 * 60 * 1000;
const MAX_MFA_ATTEMPTS = 5;
const GENERIC_LOGIN_ERROR = 'Invalid email or password, or the account is temporarily locked.';

// unknown email: verify against a dummy hash so the response time doesn't give it away
const DUMMY_HASH = await argon2.hash('timing-equalisation-password', ARGON2_OPTIONS);


router.get('/register', redirectIfAuthenticated, (req, res) => {
  res.render('register', { title: 'Create account', errors: {}, values: {} });
});

router.post('/register', authLimiter, redirectIfAuthenticated, async (req, res) => {
  const { data, errors } = parseForm(registerSchema, req.body);
  if (errors) {
    return res.status(400).render('register', { title: 'Create account', errors, values: safeValues(req.body) });
  }

  const passwordHash = await argon2.hash(data.password, ARGON2_OPTIONS);

  const created = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [data.email, passwordHash],
    );
    if (inserted.rowCount === 0) return null;

    await client.query('INSERT INTO watchlists (user_id, name) VALUES ($1, $2)', [
      inserted.rows[0].id,
      'My watchlist',
    ]);
    return inserted.rows[0].id;
  });

  if (created) {
    await logSecurityEvent(req, 'register', { userId: created });
  } else {
    await logSecurityEvent(req, 'register_duplicate', { details: 'Email already registered' });
  }

  // same answer whether or not the email exists
  flash(req, 'success', 'If the email can be registered, your account is ready. Please sign in.');
  return res.redirect('/login');
});

// login, step 1: password

router.get('/login', redirectIfAuthenticated, (req, res) => {
  res.render('login', { title: 'Sign in', errors: {}, values: {} });
});

router.post('/login', authLimiter, redirectIfAuthenticated, async (req, res) => {
  const { data, errors } = parseForm(loginSchema, req.body);
  if (errors) {
    return res.status(400).render('login', { title: 'Sign in', errors, values: safeValues(req.body) });
  }

  const { rows } = await query(
    `SELECT id, password_hash, mfa_enabled, failed_login_attempts, locked_until
       FROM users WHERE email = $1`,
    [data.email],
  );
  const user = rows[0];

  const isLocked = user?.locked_until && new Date(user.locked_until) > new Date();
  const passwordOk = await argon2.verify(user?.password_hash ?? DUMMY_HASH, data.password).catch(() => false);

  if (!user || isLocked || !passwordOk) {
    if (user && !isLocked) {
      const attempts = user.failed_login_attempts + 1;
      const shouldLock = attempts >= MAX_FAILED_ATTEMPTS;
      await query(
        `UPDATE users
            SET failed_login_attempts = $2,
                locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END
          WHERE id = $1`,
        [user.id, shouldLock ? 0 : attempts, shouldLock, LOCK_MINUTES],
      );
      await logSecurityEvent(req, shouldLock ? 'account_locked' : 'login_failed', { userId: user.id });
    } else {
      await logSecurityEvent(req, 'login_failed', { details: user ? 'Locked account' : 'Unknown email' });
    }
    return res
      .status(401)
      .render('login', { title: 'Sign in', errors: { _form: GENERIC_LOGIN_ERROR }, values: safeValues(req.body) });
  }

  await query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);

  const returnTo = req.session.returnTo;

  if (user.mfa_enabled) {
    // password is right but the user isn't signed in yet, only a pending marker is stored
    await regenerateSession(req);
    req.session.pendingMfa = { userId: user.id, expiresAt: Date.now() + MFA_STEP_TTL_MS, attempts: 0, returnTo };
    await saveSession(req);
    return res.redirect('/login/mfa');
  }

  await completeLogin(req, user.id);
  return res.redirect(safeRedirectPath(returnTo));
});

// login, step 2: totp code

function getPendingMfa(req) {
  const pending = req.session.pendingMfa;
  if (!pending || pending.expiresAt < Date.now()) return null;
  return pending;
}

router.get('/login/mfa', redirectIfAuthenticated, (req, res) => {
  if (!getPendingMfa(req)) return res.redirect('/login');
  return res.render('login-mfa', { title: 'Two-factor verification', errors: {} });
});

router.post('/login/mfa', authLimiter, redirectIfAuthenticated, async (req, res) => {
  const pending = getPendingMfa(req);
  if (!pending) {
    flash(req, 'error', 'Your sign-in session expired. Please start again.');
    return res.redirect('/login');
  }

  const { data, errors } = parseForm(mfaCodeSchema, req.body);
  if (errors) {
    return res.status(400).render('login-mfa', { title: 'Two-factor verification', errors });
  }

  const { rows } = await query(
    'SELECT id, mfa_secret_encrypted, mfa_last_time_step FROM users WHERE id = $1 AND mfa_enabled = TRUE',
    [pending.userId],
  );
  const user = rows[0];

  const result = user
    ? await verifyTotp(decryptSecret(user.mfa_secret_encrypted), data.code, user.mfa_last_time_step)
    : { valid: false };

  if (!result.valid) {
    pending.attempts += 1;
    await logSecurityEvent(req, 'mfa_failed', { userId: pending.userId });

    if (pending.attempts >= MAX_MFA_ATTEMPTS) {
      delete req.session.pendingMfa;
      flash(req, 'error', 'Too many incorrect codes. Please sign in again.');
      return res.redirect('/login');
    }
    return res
      .status(401)
      .render('login-mfa', { title: 'Two-factor verification', errors: { code: 'Incorrect or expired code.' } });
  }

  await query('UPDATE users SET mfa_last_time_step = $2 WHERE id = $1', [user.id, result.timeStep]);
  await completeLogin(req, user.id);
  return res.redirect(safeRedirectPath(pending.returnTo));
});

// new session id at login (session fixation)
async function completeLogin(req, userId) {
  await regenerateSession(req);
  req.session.userId = userId;
  await saveSession(req);
  await logSecurityEvent(req, 'login_success', { userId });
}

// logout is a POST with csrf token so other sites can't sign people out

router.post('/logout', async (req, res) => {
  await logSecurityEvent(req, 'logout');
  await destroySession(req);
  res.clearCookie('sid');
  res.redirect('/');
});

export default router;

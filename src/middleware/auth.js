import { query } from '../db.js';

export async function loadCurrentUser(req, res, next) {
  res.locals.currentUser = null;

  if (!req.session.userId) return next();

  const { rows } = await query(
    'SELECT id, email, role, mfa_enabled FROM users WHERE id = $1',
    [req.session.userId],
  );

  if (rows.length === 0) {
    // account deleted while the session was still open
    return req.session.destroy(() => next());
  }

  req.user = rows[0];
  res.locals.currentUser = rows[0];
  return next();
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    req.session.returnTo = req.method === 'GET' ? req.originalUrl : '/dashboard';
    return res.redirect('/login');
  }
  return next();
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    const error = new Error('Forbidden');
    error.status = 403;
    error.publicMessage = 'You do not have permission to access this page.';
    return next(error);
  }
  return next();
}

export function redirectIfAuthenticated(req, res, next) {
  if (req.user) return res.redirect('/dashboard');
  return next();
}

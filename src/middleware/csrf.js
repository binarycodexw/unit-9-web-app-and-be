import { randomToken, safeEqual } from '../utils/crypto.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// the token lives in the session and has to come back in a hidden field on every POST
export function csrfProtection(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = randomToken(32);
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (SAFE_METHODS.has(req.method)) return next();

  const submitted = req.body?._csrf;
  if (!safeEqual(submitted, req.session.csrfToken)) {
    const error = new Error('Invalid or missing CSRF token.');
    error.status = 403;
    error.publicMessage = 'Your session expired or the form was invalid. Please go back and try again.';
    return next(error);
  }
  return next();
}

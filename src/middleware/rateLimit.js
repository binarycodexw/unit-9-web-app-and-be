import rateLimit from 'express-rate-limit';

function limiter({ windowMinutes, max, message }) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res, next) => {
      const error = new Error('Too many requests');
      error.status = 429;
      error.publicMessage = message;
      next(error);
    },
  });
}

// general limit for all routes
export const generalLimiter = limiter({
  windowMinutes: 15,
  max: 600,
  message: 'Too many requests. Please wait a few minutes and try again.',
});

// stricter limit for login, register and mfa
export const authLimiter = limiter({
  windowMinutes: 15,
  // configurable so the tests can create lots of accounts
  max: Number.parseInt(process.env.AUTH_RATE_LIMIT_MAX ?? '20', 10) || 20,
  message: 'Too many attempts. Please wait 15 minutes before trying again.',
});

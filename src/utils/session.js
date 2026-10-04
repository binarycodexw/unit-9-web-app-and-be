
export function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

export function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });
}

export function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => (error ? reject(error) : resolve()));
  });
}

// shown once, on the next page
export function flash(req, type, text) {
  req.session.flash = { type, text };
}

// only local paths, so a redirect can't send people to another site
export function safeRedirectPath(candidate, fallback = '/dashboard') {
  if (typeof candidate !== 'string') return fallback;
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return fallback;
  return candidate;
}

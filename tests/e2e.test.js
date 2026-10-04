// end to end tests, they use the real database (docker compose up -d first)
import './setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { generate } from 'otplib';
import { createApp } from '../src/app.js';
import { pool, query } from '../src/db.js';

const EMAIL_DOMAIN = '@example.test';
const PASSWORD = 'correct horse battery staple';

let server;
let baseUrl;

// tiny browser: keeps cookies, doesn't follow redirects
class Browser {
  constructor() {
    this.cookies = new Map();
  }

  async request(path, { method = 'GET', form } = {}) {
    const headers = {};
    if (this.cookies.size) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const response = await fetch(baseUrl + path, { method, headers, body, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const [name, ...rest] = pair.split('=');
      if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, rest.join('='));
    }
    return { status: response.status, headers: response.headers, text: await response.text() };
  }

  async csrf(path) {
    const page = await this.request(path);
    const match = page.text.match(/name="_csrf" value="([^"]+)"/);
    assert.ok(match, `no CSRF token found on ${path}`);
    return match[1];
  }

  // loads tokenPage first to get a csrf token, then posts the form
  async post(path, fields, tokenPage) {
    const _csrf = await this.csrf(tokenPage ?? path);
    return this.request(path, { method: 'POST', form: { _csrf, ...fields } });
  }
}

let counter = 0;
function uniqueEmail(prefix = 'test') {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}${EMAIL_DOMAIN}`;
}

async function registerAndLogin(browser, email = uniqueEmail()) {
  await browser.post('/register', { email, password: PASSWORD, confirmPassword: PASSWORD });
  const login = await browser.post('/login', { email, password: PASSWORD });
  assert.equal(login.status, 302, 'login should redirect');
  return email;
}

before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await query('DELETE FROM users WHERE email LIKE $1', [`%${EMAIL_DOMAIN}`]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

describe('security headers', () => {
  it('sends CSP, nosniff and no X-Powered-By', async () => {
    const res = await new Browser().request('/login');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  it('marks the session cookie HttpOnly and SameSite', async () => {
    const res = await fetch(`${baseUrl}/login`);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('sid='));
    assert.ok(cookie, 'session cookie missing');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
  });
});

describe('CSRF protection', () => {
  it('rejects a POST without a token', async () => {
    const browser = new Browser();
    await browser.request('/login');
    const res = await browser.request('/login', {
      method: 'POST',
      form: { email: 'a@example.test', password: 'whatever' },
    });
    assert.equal(res.status, 403);
  });

  it('rejects a POST with a wrong token', async () => {
    const browser = new Browser();
    await browser.request('/login');
    const res = await browser.request('/login', {
      method: 'POST',
      form: { _csrf: 'forged', email: 'a@example.test', password: 'whatever' },
    });
    assert.equal(res.status, 403);
  });
});

describe('authentication', () => {
  it('rejects weak passwords at registration (server-side validation)', async () => {
    const browser = new Browser();
    const res = await browser.post('/register', {
      email: uniqueEmail(),
      password: 'short',
      confirmPassword: 'short',
    });
    assert.equal(res.status, 400);
    assert.match(res.text, /at least 12 characters/);
  });

  it('stores an Argon2id hash, never the plain password', async () => {
    const browser = new Browser();
    const email = await registerAndLogin(browser);
    const { rows } = await query('SELECT password_hash FROM users WHERE email = $1', [email]);
    assert.match(rows[0].password_hash, /^\$argon2id\$/);
    assert.ok(!rows[0].password_hash.includes(PASSWORD));
  });

  it('gives the same generic error for unknown email and wrong password', async () => {
    const browser = new Browser();
    const email = await registerAndLogin(new Browser());
    const wrongPassword = await browser.post('/login', { email, password: 'wrong password value' });
    const unknownUser = await browser.post('/login', { email: uniqueEmail('ghost'), password: 'wrong password value' });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    const message = (html) => html.match(/notice-error[^>]*>\s*([^<]+)/)?.[1].trim();
    assert.equal(message(wrongPassword.text), message(unknownUser.text));
  });

  it('locks the account after repeated failures', async () => {
    const email = await registerAndLogin(new Browser());
    const attacker = new Browser();
    for (let i = 0; i < 5; i += 1) {
      await attacker.post('/login', { email, password: 'wrong password value' });
    }
    const afterLock = await attacker.post('/login', { email, password: PASSWORD });
    assert.equal(afterLock.status, 401, 'correct password must be refused while locked');
  });

  it('regenerates the session id on login (session fixation)', async () => {
    const browser = new Browser();
    const email = uniqueEmail();
    await browser.post('/register', { email, password: PASSWORD, confirmPassword: PASSWORD });
    await browser.request('/login');
    const before = browser.cookies.get('sid');
    await browser.post('/login', { email, password: PASSWORD });
    assert.notEqual(browser.cookies.get('sid'), before);
  });

  it('protects private pages and keeps the user signed in', async () => {
    const anonymous = await new Browser().request('/dashboard');
    assert.equal(anonymous.status, 302);
    assert.equal(anonymous.headers.get('location'), '/login');

    const browser = new Browser();
    const email = await registerAndLogin(browser);
    const dashboard = await browser.request('/dashboard');
    assert.equal(dashboard.status, 200);
    assert.ok(dashboard.text.includes(email));
  });
});

describe('injection and XSS', () => {
  it('treats SQL injection payloads as plain data', async () => {
    const browser = new Browser();
    await registerAndLogin(browser);

    const search = await browser.request(`/stocks?q=${encodeURIComponent("' OR 1=1; DROP TABLE users; --")}`);
    assert.equal(search.status, 200);
    assert.match(search.text, /0 results/);

    const login = await new Browser().post('/login', { email: "admin@example.com' OR '1'='1", password: "' OR '1'='1" });
    assert.ok([400, 401].includes(login.status));

    const { rows } = await query('SELECT count(*)::int AS total FROM users');
    assert.ok(rows[0].total >= 1, 'users table must still exist');
  });

  it('escapes user-controlled content in HTML (stored XSS)', async () => {
    const browser = new Browser();
    await registerAndLogin(browser);
    const payload = '<script>alert(1)</script>';
    await browser.post('/watchlists', { name: payload }, '/watchlists');
    const page = await browser.request('/watchlists');
    assert.ok(!page.text.includes(payload), 'raw script tag must not appear');
    assert.ok(page.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });
});

describe('CRUD and access control', () => {
  it('supports create, read, update and delete on watchlists and items', async () => {
    const browser = new Browser();
    await registerAndLogin(browser);

    // create watchlist
    const created = await browser.post('/watchlists', { name: 'Growth' }, '/watchlists');
    assert.equal(created.status, 302);
    const listUrl = created.headers.get('location');

    // add item
    const { rows: stocks } = await query("SELECT id FROM stocks WHERE symbol = 'AAPL'");
    const added = await browser.post(`${listUrl}/items`, { stockId: stocks[0].id, note: 'core', targetPrice: '200' }, listUrl);
    assert.equal(added.status, 302);

    // read
    let page = await browser.request(listUrl);
    assert.match(page.text, /AAPL/);
    assert.match(page.text, /value="core"/);
    const itemId = page.text.match(/items\/(\d+)\/update/)[1];

    // update
    await browser.post(`${listUrl}/items/${itemId}/update`, { note: 'changed', targetPrice: '210' }, listUrl);
    page = await browser.request(listUrl);
    assert.match(page.text, /value="changed"/);

    // negative target price is refused
    await browser.post(`${listUrl}/items/${itemId}/update`, { note: 'x', targetPrice: '-5' }, listUrl);
    page = await browser.request(listUrl);
    assert.match(page.text, /value="changed"/, 'invalid update must not be applied');

    // delete
    await browser.post(`${listUrl}/items/${itemId}/delete`, {}, listUrl);
    page = await browser.request(listUrl);
    assert.ok(!/items\/\d+\/update/.test(page.text));
  });

  it('prevents users from reading or changing other users data (IDOR)', async () => {
    const owner = new Browser();
    await registerAndLogin(owner);
    const created = await owner.post('/watchlists', { name: 'Private list' }, '/watchlists');
    const listUrl = created.headers.get('location');

    const intruder = new Browser();
    await registerAndLogin(intruder);
    assert.equal((await intruder.request(listUrl)).status, 404);
    assert.equal((await intruder.post(`${listUrl}/delete`, {}, '/watchlists')).status, 404);
    assert.equal((await intruder.post(`${listUrl}/rename`, { name: 'Hacked' }, '/watchlists')).status, 404);

    const stillThere = await owner.request(listUrl);
    assert.equal(stillThere.status, 200);
    assert.match(stillThere.text, /Private list/);
  });
  it('keeps administration pages for administrators only', async () => {
    const browser = new Browser();
    await registerAndLogin(browser);
    assert.equal((await browser.request('/admin/stocks')).status, 403);
    assert.equal((await browser.post('/admin/refresh', {}, '/account')).status, 403);
    assert.equal((await browser.post('/admin/stocks', { symbol: 'EVIL', name: 'x', exchange: 'x', sector: 'x' }, '/account')).status, 403);
  });

  it('lets an administrator manage the stock catalogue', async () => {
    const email = uniqueEmail('admin');
    const browser = new Browser();
    await registerAndLogin(browser, email);
    await query("UPDATE users SET role = 'admin' WHERE email = $1", [email]);

    const created = await browser.post('/admin/stocks', { symbol: 'tstx', name: 'Test Corp', exchange: 'NYSE', sector: 'Testing' }, '/admin/stocks');
    assert.equal(created.status, 302);
    const { rows } = await query("SELECT id, symbol FROM stocks WHERE symbol = 'TSTX'");
    assert.equal(rows.length, 1, 'symbol is normalised to upper case');

    const duplicate = await browser.post('/admin/stocks', { symbol: 'TSTX', name: 'Dup', exchange: 'NYSE', sector: 'Testing' }, '/admin/stocks');
    assert.equal(duplicate.status, 409);

    await browser.post(`/admin/stocks/${rows[0].id}/update`, { symbol: 'TSTX', name: 'Renamed Corp', exchange: 'NYSE', sector: 'Testing' }, `/admin/stocks/${rows[0].id}/edit`);
    const renamed = await query('SELECT name FROM stocks WHERE id = $1', [rows[0].id]);
    assert.equal(renamed.rows[0].name, 'Renamed Corp');

    await browser.post(`/admin/stocks/${rows[0].id}/delete`, {}, '/admin/stocks');
    const gone = await query('SELECT 1 FROM stocks WHERE id = $1', [rows[0].id]);
    assert.equal(gone.rowCount, 0);

    // security log page and refresh buttons are gone
    assert.equal((await browser.request('/admin/events')).status, 404);
    assert.equal((await browser.post('/admin/refresh', {}, '/admin/stocks')).status, 404);
    const page = await browser.request('/admin/stocks');
    assert.ok(!page.text.includes('Refresh'), 'no manual refresh controls');
  });
});

describe('multi-factor authentication (TOTP)', () => {
  it('enrols, enforces the second factor and rejects replayed codes', async () => {
    const email = uniqueEmail('mfa');
    const browser = new Browser();
    await registerAndLogin(browser, email);

    // enrol: read the secret from the setup page and confirm with a code
    const setup = await browser.request('/account/mfa/setup');
    assert.equal(setup.status, 200);
    const secret = setup.text.match(/<code>([A-Z2-7]+)<\/code>/)[1];

    const wrong = await browser.post('/account/mfa/enable', { code: '000000' }, '/account/mfa/setup');
    assert.equal(wrong.status, 400);

    const firstCode = await generate({ secret });
    const enabled = await browser.post('/account/mfa/enable', { code: firstCode }, '/account/mfa/setup');
    assert.equal(enabled.status, 302);

    // secret is stored encrypted
    const { rows } = await query('SELECT mfa_secret_encrypted FROM users WHERE email = $1', [email]);
    assert.ok(!rows[0].mfa_secret_encrypted.includes(secret));

    // new login: password alone is not enough
    await browser.post('/logout', {}, '/account');
    const step1 = await browser.post('/login', { email, password: PASSWORD });
    assert.equal(step1.status, 302);
    assert.equal(step1.headers.get('location'), '/login/mfa');
    assert.equal((await browser.request('/dashboard')).status, 302, 'not signed in before the code');

    // wrong code
    const bad = await browser.post('/login/mfa', { code: '123456' }, '/login/mfa');
    assert.equal(bad.status, 401);

    // the code used during enrolment can't be reused
    const replay = await browser.post('/login/mfa', { code: firstCode }, '/login/mfa');
    assert.equal(replay.status, 401, 'a used time step must not be accepted again');

    // code from the next time step works
    const nextCode = await generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });
    const ok = await browser.post('/login/mfa', { code: nextCode }, '/login/mfa');
    assert.equal(ok.status, 302);
    assert.equal((await browser.request('/dashboard')).status, 200);
  });
});

describe('charts', () => {
  const readChart = (html) => {
    const raw = html.match(/<canvas data-chart="([^"]+)"/)?.[1];
    assert.ok(raw, 'chart canvas not found');
    return JSON.parse(raw.replace(/&#34;|&quot;/g, '"').replace(/&amp;/g, '&'));
  };

  it('serves Chart.js from our own origin, so the CSP stays strict', async () => {
    const res = await fetch(`${baseUrl}/vendor/chart.umd.min.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    const csp = (await fetch(`${baseUrl}/login`)).headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.ok(!/https?:\/\/(cdn|unpkg|cdnjs)/.test(csp), 'no external script host allowed');
  });

  it('renders the price chart with a selectable period', async () => {
    const browser = new Browser();
    await registerAndLogin(browser);

    const short = readChart((await browser.request('/stocks/AAPL?range=30')).text);
    assert.equal(short.type, 'full');
    assert.ok(short.labels.length <= 30 && short.labels.length > 1);
    assert.equal(short.labels.length, short.prices.length);

    const long = readChart((await browser.request('/stocks/AAPL?range=100')).text);
    assert.ok(long.labels.length > short.labels.length);

    // unsupported values fall back to the default period
    const fallback = await browser.request("/stocks/AAPL?range=1';DROP TABLE stocks;--");
    assert.equal(fallback.status, 200);
    assert.match(fallback.text, /last 60 days/);
  });

  it('draws only the signed-in user target prices', async () => {
    const owner = new Browser();
    await registerAndLogin(owner);
    const { rows } = await query("SELECT id, last_price FROM stocks WHERE symbol = 'MSFT'");
    const price = rows[0].last_price;

    const created = await owner.post('/watchlists', { name: 'Chart lines' }, '/watchlists');
    const listUrl = created.headers.get('location');
    await owner.post(`${listUrl}/items`, { stockId: rows[0].id, targetPrice: (price * 1.02).toFixed(2) }, listUrl);

    const own = readChart((await owner.request('/stocks/MSFT')).text);
    assert.deepEqual(own.lines.map((l) => l.kind), ['target']);

    const other = new Browser();
    await registerAndLogin(other);
    const foreign = readChart((await other.request('/stocks/MSFT')).text);
    assert.equal(foreign.lines.length, 0, 'another user must not see these lines');
  });
});

describe('error handling', () => {
  it('returns a generic 404 page and refuses malformed identifiers', async () => {
    const browser = new Browser();
    await registerAndLogin(browser);
    const res = await browser.request('/does-not-exist');
    assert.equal(res.status, 404);
    assert.ok(!/at .*\.js:\d+/.test(res.text), 'no stack trace');

    assert.equal((await browser.request('/watchlists/abc')).status, 404);
    assert.equal((await browser.request("/watchlists/1' OR '1'='1")).status, 404);
    assert.equal((await browser.request('/stocks/NOT%20A%20SYMBOL')).status, 404);
  });
});

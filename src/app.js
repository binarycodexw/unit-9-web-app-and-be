import path from 'node:path';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db.js';
import { loadCurrentUser } from './middleware/auth.js';
import { csrfProtection } from './middleware/csrf.js';
import { generalLimiter } from './middleware/rateLimit.js';
import accountRoutes from './routes/account.js';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import pageRoutes from './routes/pages.js';
import stockRoutes from './routes/stocks.js';
import watchlistRoutes from './routes/watchlists.js';
import { formatDate, formatDateTime, formatPercent, formatPrice } from './utils/format.js';

const rootDir = path.resolve(import.meta.dirname, '..');

export function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(rootDir, 'views'));
  app.disable('x-powered-by');

  // needed on Render and similar hosts to get the real client IP
  if (config.isProduction) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"], // no inline scripts
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'], // the MFA QR code is a data: url
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.isProduction ? [] : null,
        },
      },
      referrerPolicy: { policy: 'same-origin' },
      strictTransportSecurity: config.isProduction
        ? { maxAge: 31_536_000, includeSubDomains: true }
        : false,
    }),
  );

  // static files go before the session so they don't create one
  app.use(express.static(path.join(rootDir, 'public'), { maxAge: config.isProduction ? '1d' : 0 }));

  // Chart.js comes from node_modules, no CDN, so script-src can stay 'self'
  app.get('/vendor/chart.umd.min.js', (req, res) => {
    res.sendFile(path.join(rootDir, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js'), {
      maxAge: config.isProduction ? '7d' : 0,
    });
  });

  app.use(generalLimiter);

  app.use(express.urlencoded({ extended: false, limit: '10kb' }));

  const PgStore = connectPgSimple(session);
  app.use(
    session({
      store: new PgStore({ pool, tableName: 'session', createTableIfMissing: false }),
      name: 'sid',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        secure: config.isProduction,
        sameSite: 'lax',
        maxAge: 2 * 60 * 60 * 1000, // 2 hours, renewed on each request
      },
    }),
  );

  // pages contain user data, don't let the browser cache them
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // flash message and helpers used by the views
  app.use((req, res, next) => {
    res.locals.flash = req.session.flash ?? null;
    delete req.session.flash;
    res.locals.appName = config.appName;
    res.locals.fmtPrice = formatPrice;
    res.locals.fmtPercent = formatPercent;
    res.locals.fmtDate = formatDate;
    res.locals.fmtDateTime = formatDateTime;
    res.locals.currentPath = req.path;
    next();
  });

  app.use(csrfProtection);
  app.use(loadCurrentUser);

  app.use(pageRoutes);
  app.use(authRoutes);
  app.use(accountRoutes);
  app.use(watchlistRoutes);
  app.use(stockRoutes);
  app.use(adminRoutes);

  app.use((req, res, next) => {
    next(Object.assign(new Error('Not found'), { status: 404 }));
  });

  // error handler: details go to the log, the user only sees a generic message
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;

    if (status >= 500) {
      console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, error);
    }

    const messages = {
      403: 'You do not have permission to do that.',
      404: 'The page you are looking for does not exist.',
      429: 'Too many requests. Please slow down.',
    };
    const message = error.publicMessage ?? messages[status] ?? 'Something went wrong. Please try again later.';

    if (res.headersSent) return;
    res.status(status).render('error', {
      title: `Error ${status}`,
      status,
      message,
      appName: config.appName,
      currentUser: res.locals.currentUser ?? null,
      flash: null,
      csrfToken: res.locals.csrfToken ?? '',
    });
  });

  return app;
}

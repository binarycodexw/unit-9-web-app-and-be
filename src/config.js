import 'dotenv/config';

// refuse to start if a secret is missing or too short
const required = ['DATABASE_URL', 'SESSION_SECRET', 'MFA_ENCRYPTION_KEY'];
for (const name of required) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

if (process.env.SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET must be at least 32 characters long.');
}

if (!/^[0-9a-fA-F]{64}$/.test(process.env.MFA_ENCRYPTION_KEY)) {
  throw new Error('MFA_ENCRYPTION_KEY must be exactly 64 hexadecimal characters.');
}

const isProduction = process.env.NODE_ENV === 'production';

export const config = {
  isProduction,
  port: Number.parseInt(process.env.PORT ?? '3000', 10),
  databaseUrl: process.env.DATABASE_URL,
  databaseSsl: process.env.DATABASE_SSL === 'true',
  sessionSecret: process.env.SESSION_SECRET,
  mfaEncryptionKey: Buffer.from(process.env.MFA_ENCRYPTION_KEY, 'hex'),
  alphaVantageKey: process.env.ALPHAVANTAGE_API_KEY || '',
  // hours before a stored price counts as old
  priceMaxAgeHours: Math.max(1, Number.parseInt(process.env.PRICE_MAX_AGE_HOURS ?? '12', 10) || 12),
  // max api calls per day, the free plan gives 25
  apiDailyBudget: Math.max(0, Number.parseInt(process.env.API_DAILY_BUDGET ?? '20', 10) || 20),
  appName: 'WatchSecure',
};

// Creates the tables, and with --seed loads the sample data and the admin user.
// node scripts/init-db.js [--reset] [--seed]
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import argon2 from 'argon2';
import pg from 'pg';

const args = new Set(process.argv.slice(2));
const rootDir = path.resolve(import.meta.dirname, '..');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false,
});

try {
  await client.connect();

  if (args.has('--reset')) {
    console.log('Dropping existing tables...');
    await client.query(`
      DROP TABLE IF EXISTS watchlist_items, watchlists, price_history,
                           stocks, security_events, "session", users CASCADE;
    `);
  }

  console.log('Applying db/schema.sql ...');
  await client.query(await fs.readFile(path.join(rootDir, 'db', 'schema.sql'), 'utf8'));

  if (args.has('--seed')) {
    console.log('Applying db/seed.sql ...');
    await client.query(await fs.readFile(path.join(rootDir, 'db', 'seed.sql'), 'utf8'));

    const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD ?? '';
    if (email && password.length >= 12) {
      const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
      const result = await client.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')
         ON CONFLICT (email) DO NOTHING RETURNING id`,
        [email, hash],
      );
      if (result.rowCount) {
        await client.query('INSERT INTO watchlists (user_id, name) VALUES ($1, $2)', [result.rows[0].id, 'My watchlist']);
        console.log(`Administrator created: ${email}`);
      } else {
        console.log(`Administrator ${email} already exists, left unchanged.`);
      }
    } else {
      console.log('ADMIN_EMAIL / ADMIN_PASSWORD (min. 12 chars) not set: no administrator created.');
    }
  }

  console.log('Database ready.');
} catch (error) {
  console.error('Database initialisation failed:', error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}

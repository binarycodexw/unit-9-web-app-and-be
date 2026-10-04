// Refreshes one stock to test the Alpha Vantage key (uses 1 call).
// node scripts/try-refresh.js AAPL
import { query, pool } from '../src/db.js';
import { refreshStock } from '../src/services/alphavantage.js';

const symbol = (process.argv[2] ?? 'AAPL').toUpperCase();

try {
  const { rows } = await query('SELECT id, symbol FROM stocks WHERE symbol = $1', [symbol]);
  if (rows.length === 0) throw new Error(`Unknown symbol ${symbol}`);
  const result = await refreshStock(rows[0]);
  console.log(`${symbol}: price ${result.price}, ${result.candles} candles stored.`);
} catch (error) {
  console.error(`Refresh failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

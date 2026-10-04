import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { buildPriceChart, percentChange } from '../services/chart.js';
import { priceUpdater } from '../services/prices.js';
import { parseForm } from '../validation/parse.js';
import { RANGE_OPTIONS, stockRangeSchema, stockSearchSchema } from '../validation/schemas.js';

const router = Router();
router.use('/stocks', requireAuth);

const PAGE_SIZE = 8;

// escape % and _ so they match literally
function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

// search and filter

router.get('/stocks', async (req, res) => {
  const { data } = parseForm(stockSearchSchema, req.query);
  const filters = data ?? { q: '', sector: '', page: 1 };

  const params = [];
  const conditions = [];

  if (filters.q) {
    params.push(`%${escapeLike(filters.q)}%`);
    conditions.push(`(symbol ILIKE $${params.length} ESCAPE '\\' OR name ILIKE $${params.length} ESCAPE '\\')`);
  }
  if (filters.sector) {
    params.push(filters.sector);
    conditions.push(`sector = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const total = await query(`SELECT COUNT(*)::int AS total FROM stocks ${where}`, params);
  const pages = Math.max(1, Math.ceil(total.rows[0].total / PAGE_SIZE));
  const page = Math.min(filters.page, pages);

  const listParams = [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE];
  const stocks = await query(
    `SELECT id, symbol, name, exchange, sector, last_price, last_price_at
       FROM stocks ${where}
      ORDER BY symbol ASC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams,
  );

  const sectors = await query('SELECT DISTINCT sector FROM stocks ORDER BY sector ASC');

  res.render('stocks', {
    title: 'Stocks',
    stocks: stocks.rows,
    sectors: sectors.rows.map((row) => row.sector),
    filters: { ...filters, page },
    pages,
    totalResults: total.rows[0].total,
  });
});

// one stock with its history

router.get('/stocks/:symbol', async (req, res, next) => {
  const symbol = String(req.params.symbol).toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    const error = new Error('Not found');
    error.status = 404;
    return next(error);
  }

  const stockSql =
    'SELECT id, symbol, name, exchange, sector, last_price, last_price_at FROM stocks WHERE symbol = $1';
  let { rows } = await query(stockSql, [symbol]);
  if (rows.length === 0) {
    const error = new Error('Not found');
    error.status = 404;
    return next(error);
  }

  // refresh if the price is old, on failure the stored one is kept
  const update = await priceUpdater.ensureFresh(rows[0]);
  if (update.status === 'refreshed') {
    ({ rows } = await query(stockSql, [symbol]));
  }
  const stock = rows[0];

  const range = Number(stockRangeSchema.parse(req.query).range);

  const history = await query(
    `SELECT trade_date, open_price, high_price, low_price, close_price, volume
       FROM price_history
      WHERE stock_id = $1
      ORDER BY trade_date DESC
      LIMIT $2`,
    [stock.id, range],
  );
  const chronological = [...history.rows].reverse();

  // the user's own target prices, drawn as reference lines
  const targets = await query(
    `SELECT wi.target_price AS value, w.name
       FROM watchlist_items wi
       JOIN watchlists w ON w.id = wi.watchlist_id
      WHERE w.user_id = $1 AND wi.stock_id = $2 AND wi.target_price IS NOT NULL`,
    [req.user.id, stock.id],
  );
  const lines = targets.rows.map((row) => ({
    kind: 'target',
    label: `Target (${row.name})`,
    value: row.value,
  }));

  const chart = buildPriceChart(chronological, lines);
  const change = percentChange(chronological.map((row) => row.close_price));

  const watchlists = await query(
    `SELECT w.id, w.name,
            EXISTS (SELECT 1 FROM watchlist_items wi WHERE wi.watchlist_id = w.id AND wi.stock_id = $2) AS has_stock
       FROM watchlists w
      WHERE w.user_id = $1
      ORDER BY w.name ASC`,
    [req.user.id, stock.id],
  );

  return res.render('stock', {
    title: `${stock.symbol} - ${stock.name}`,
    stock,
    priceStale: update.status === 'stale',
    withCharts: true,
    chartJson: chart ? JSON.stringify(chart) : null,
    change,
    range,
    rangeOptions: RANGE_OPTIONS,
    history: history.rows.slice(0, 10),
    watchlists: watchlists.rows,
    errors: {},
    values: {},
  });
});

export default router;

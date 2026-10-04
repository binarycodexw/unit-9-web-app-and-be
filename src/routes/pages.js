import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { buildSparkline, percentChange } from '../services/chart.js';

const router = Router();

router.get('/', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  return res.render('home', { title: 'Welcome' });
});

router.get('/dashboard', requireAuth, async (req, res) => {
  const items = await query(
    `SELECT w.id AS watchlist_id, w.name AS watchlist_name,
            s.symbol, s.name, s.last_price, s.last_price_at, wi.target_price
       FROM watchlists w
       LEFT JOIN watchlist_items wi ON wi.watchlist_id = w.id
       LEFT JOIN stocks s ON s.id = wi.stock_id
      WHERE w.user_id = $1
      ORDER BY w.created_at ASC, s.symbol ASC`,
    [req.user.id],
  );

  // last 30 closes of every watched stock in one query, float8 so pg gives numbers
  const series = await query(
    `SELECT s.symbol, array_agg(h.close_price::float8 ORDER BY h.trade_date) AS closes
       FROM stocks s
       JOIN LATERAL (
              SELECT close_price, trade_date FROM price_history
               WHERE stock_id = s.id ORDER BY trade_date DESC LIMIT 30
            ) h ON TRUE
      WHERE s.id IN (
              SELECT wi.stock_id FROM watchlist_items wi
                JOIN watchlists w ON w.id = wi.watchlist_id
               WHERE w.user_id = $1)
      GROUP BY s.symbol`,
    [req.user.id],
  );
  const closesBySymbol = new Map(series.rows.map((row) => [row.symbol, row.closes]));

  // group by watchlist
  const groups = new Map();
  for (const row of items.rows) {
    if (!groups.has(row.watchlist_id)) {
      groups.set(row.watchlist_id, { id: row.watchlist_id, name: row.watchlist_name, items: [] });
    }
    if (row.symbol) {
      const closes = closesBySymbol.get(row.symbol);
      const spark = buildSparkline(closes);
      groups.get(row.watchlist_id).items.push({
        ...row,
        sparkJson: spark ? JSON.stringify(spark) : null,
        change: closes ? percentChange(closes) : null,
      });
    }
  }

  const watchlists = [...groups.values()];
  const watchedSymbols = new Set(watchlists.flatMap((list) => list.items.map((item) => item.symbol)));

  // biggest movers over 30 sessions
  const movers = watchlists
    .flatMap((list) => list.items)
    .filter((item, index, all) => item.change !== null && all.findIndex((other) => other.symbol === item.symbol) === index)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, 3);

  res.render('dashboard', {
    title: 'Dashboard',
    withCharts: true,
    watchlists,
    watchedCount: watchedSymbols.size,
    movers,
  });
});

export default router;

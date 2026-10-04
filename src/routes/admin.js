import { Router } from 'express';
import { query } from '../db.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { logSecurityEvent } from '../utils/audit.js';
import { flash } from '../utils/session.js';
import { parseForm, parseId, safeValues } from '../validation/parse.js';
import { stockSchema } from '../validation/schemas.js';

const router = Router();
// only under /admin, other unknown urls still get a normal 404
router.use('/admin', requireAuth, requireAdmin);

const notFound = (next) => next(Object.assign(new Error('Not found'), { status: 404 }));

async function renderAdminStocks(res, { status = 200, errors = {}, values = {} } = {}) {
  const stocks = await query(
    `SELECT s.id, s.symbol, s.name, s.exchange, s.sector, s.last_price, s.last_price_at,
            (SELECT COUNT(*)::int FROM watchlist_items wi WHERE wi.stock_id = s.id) AS watchers
       FROM stocks s
      ORDER BY s.symbol ASC`,
  );
  res.status(status).render('admin-stocks', {
    title: 'Manage stocks',
    stocks: stocks.rows,
    errors,
    values,
  });
}

// list
router.get('/admin/stocks', async (req, res) => {
  await renderAdminStocks(res);
});

// create
router.post('/admin/stocks', async (req, res) => {
  const { data, errors } = parseForm(stockSchema, req.body);
  if (errors) {
    return renderAdminStocks(res, { status: 400, errors, values: safeValues(req.body) });
  }

  const inserted = await query(
    `INSERT INTO stocks (symbol, name, exchange, sector) VALUES ($1, $2, $3, $4)
     ON CONFLICT (symbol) DO NOTHING
     RETURNING id`,
    [data.symbol, data.name, data.exchange, data.sector],
  );
  if (inserted.rowCount === 0) {
    return renderAdminStocks(res, {
      status: 409,
      errors: { symbol: 'That symbol already exists.' },
      values: safeValues(req.body),
    });
  }

  await logSecurityEvent(req, 'stock_created', { details: data.symbol });
  flash(req, 'success', `${data.symbol} added. Its price is downloaded automatically the first time its page is opened.`);
  return res.redirect('/admin/stocks');
});

// edit form
router.get('/admin/stocks/:id/edit', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(next);

  const { rows } = await query('SELECT id, symbol, name, exchange, sector FROM stocks WHERE id = $1', [id]);
  if (rows.length === 0) return notFound(next);

  return res.render('admin-stock-edit', { title: `Edit ${rows[0].symbol}`, stock: rows[0], errors: {}, values: rows[0] });
});

// update
router.post('/admin/stocks/:id/update', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(next);

  const { rows } = await query('SELECT id, symbol FROM stocks WHERE id = $1', [id]);
  if (rows.length === 0) return notFound(next);

  const { data, errors } = parseForm(stockSchema, req.body);
  if (errors) {
    return res.status(400).render('admin-stock-edit', {
      title: `Edit ${rows[0].symbol}`,
      stock: rows[0],
      errors,
      values: safeValues(req.body),
    });
  }

  try {
    await query(
      'UPDATE stocks SET symbol = $1, name = $2, exchange = $3, sector = $4 WHERE id = $5',
      [data.symbol, data.name, data.exchange, data.sector, id],
    );
  } catch (error) {
    if (error.code !== '23505') throw error; // symbol already used
    return res.status(409).render('admin-stock-edit', {
      title: `Edit ${rows[0].symbol}`,
      stock: rows[0],
      errors: { symbol: 'That symbol already exists.' },
      values: safeValues(req.body),
    });
  }

  await logSecurityEvent(req, 'stock_updated', { details: data.symbol });
  flash(req, 'success', 'Stock updated.');
  return res.redirect('/admin/stocks');
});

// delete
router.post('/admin/stocks/:id/delete', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(next);

  const result = await query('DELETE FROM stocks WHERE id = $1 RETURNING symbol', [id]);
  if (result.rowCount === 0) return notFound(next);

  await logSecurityEvent(req, 'stock_deleted', { details: result.rows[0].symbol });
  flash(req, 'success', `${result.rows[0].symbol} deleted.`);
  return res.redirect('/admin/stocks');
});

export default router;

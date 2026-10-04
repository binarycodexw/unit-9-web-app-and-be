import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { flash } from '../utils/session.js';
import { parseForm, parseId, safeValues } from '../validation/parse.js';
import { watchlistItemAddSchema, watchlistItemUpdateSchema, watchlistSchema } from '../validation/schemas.js';

const router = Router();
router.use('/watchlists', requireAuth);

const MAX_WATCHLISTS_PER_USER = 10;
const MAX_ITEMS_PER_WATCHLIST = 100;

function notFound(next) {
  const error = new Error('Not found');
  error.status = 404;
  return next(error);
}

// the user_id check is part of the query, so someone else's id just finds nothing
async function findOwnWatchlist(id, userId) {
  const { rows } = await query(
    'SELECT id, name, created_at FROM watchlists WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return rows[0] ?? null;
}

// list

router.get('/watchlists', async (req, res) => {
  const { rows } = await query(
    `SELECT w.id, w.name, w.created_at, COUNT(wi.id)::int AS item_count
       FROM watchlists w
       LEFT JOIN watchlist_items wi ON wi.watchlist_id = w.id
      WHERE w.user_id = $1
      GROUP BY w.id
      ORDER BY w.created_at ASC`,
    [req.user.id],
  );
  res.render('watchlists', { title: 'My watchlists', watchlists: rows, errors: {}, values: {} });
});

// create

router.post('/watchlists', async (req, res) => {
  const { data, errors } = parseForm(watchlistSchema, req.body);

  const { rows: countRows } = await query('SELECT COUNT(*)::int AS total FROM watchlists WHERE user_id = $1', [
    req.user.id,
  ]);
  const limitReached = countRows[0].total >= MAX_WATCHLISTS_PER_USER;

  if (errors || limitReached) {
    const { rows } = await query(
      `SELECT w.id, w.name, w.created_at, COUNT(wi.id)::int AS item_count
         FROM watchlists w LEFT JOIN watchlist_items wi ON wi.watchlist_id = w.id
        WHERE w.user_id = $1 GROUP BY w.id ORDER BY w.created_at ASC`,
      [req.user.id],
    );
    return res.status(400).render('watchlists', {
      title: 'My watchlists',
      watchlists: rows,
      errors: errors ?? { name: `You can have at most ${MAX_WATCHLISTS_PER_USER} watchlists.` },
      values: safeValues(req.body),
    });
  }

  const inserted = await query(
    `INSERT INTO watchlists (user_id, name) VALUES ($1, $2)
     ON CONFLICT (user_id, name) DO NOTHING
     RETURNING id`,
    [req.user.id, data.name],
  );

  if (inserted.rowCount === 0) {
    flash(req, 'error', 'You already have a watchlist with that name.');
    return res.redirect('/watchlists');
  }
  flash(req, 'success', 'Watchlist created.');
  return res.redirect(`/watchlists/${inserted.rows[0].id}`);
});

// detail

async function renderWatchlist(res, req, watchlist, { status = 200, errors = {}, values = {}, itemErrors = {} } = {}) {
  const items = await query(
    `SELECT wi.id, wi.note, wi.target_price, wi.added_at,
            s.id AS stock_id, s.symbol, s.name, s.last_price, s.last_price_at
       FROM watchlist_items wi
       JOIN stocks s ON s.id = wi.stock_id
      WHERE wi.watchlist_id = $1
      ORDER BY s.symbol ASC`,
    [watchlist.id],
  );

  // stocks not yet in this list
  const available = await query(
    `SELECT id, symbol, name FROM stocks
      WHERE id NOT IN (SELECT stock_id FROM watchlist_items WHERE watchlist_id = $1)
      ORDER BY symbol ASC`,
    [watchlist.id],
  );

  res.status(status).render('watchlist', {
    title: watchlist.name,
    watchlist,
    items: items.rows,
    available: available.rows,
    errors,
    values,
    itemErrors,
  });
}

router.get('/watchlists/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  const watchlist = id && (await findOwnWatchlist(id, req.user.id));
  if (!watchlist) return notFound(next);
  return renderWatchlist(res, req, watchlist);
});

// rename

router.post('/watchlists/:id/rename', async (req, res, next) => {
  const id = parseId(req.params.id);
  const watchlist = id && (await findOwnWatchlist(id, req.user.id));
  if (!watchlist) return notFound(next);

  const { data, errors } = parseForm(watchlistSchema, req.body);
  if (errors) {
    return renderWatchlist(res, req, watchlist, { status: 400, errors, values: safeValues(req.body) });
  }

  try {
    await query('UPDATE watchlists SET name = $1 WHERE id = $2 AND user_id = $3', [data.name, id, req.user.id]);
    flash(req, 'success', 'Watchlist renamed.');
  } catch (error) {
    if (error.code !== '23505') throw error; // name already used
    flash(req, 'error', 'You already have a watchlist with that name.');
  }
  return res.redirect(`/watchlists/${id}`);
});

// delete (items go with it, ON DELETE CASCADE)

router.post('/watchlists/:id/delete', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(next);

  const result = await query('DELETE FROM watchlists WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  if (result.rowCount === 0) return notFound(next);

  flash(req, 'success', 'Watchlist deleted.');
  return res.redirect('/watchlists');
});

// add a stock

router.post('/watchlists/:id/items', async (req, res, next) => {
  const id = parseId(req.params.id);
  const watchlist = id && (await findOwnWatchlist(id, req.user.id));
  if (!watchlist) return notFound(next);

  const { data, errors } = parseForm(watchlistItemAddSchema, req.body);
  if (errors) {
    return renderWatchlist(res, req, watchlist, {
      status: 400,
      itemErrors: errors,
      values: safeValues(req.body),
    });
  }

  const { rows: countRows } = await query(
    'SELECT COUNT(*)::int AS total FROM watchlist_items WHERE watchlist_id = $1',
    [id],
  );
  if (countRows[0].total >= MAX_ITEMS_PER_WATCHLIST) {
    flash(req, 'error', `A watchlist can contain at most ${MAX_ITEMS_PER_WATCHLIST} stocks.`);
    return res.redirect(`/watchlists/${id}`);
  }

  try {
    const inserted = await query(
      `INSERT INTO watchlist_items (watchlist_id, stock_id, note, target_price)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (watchlist_id, stock_id) DO NOTHING`,
      [id, data.stockId, data.note, data.targetPrice ?? null],
    );
    flash(
      req,
      inserted.rowCount ? 'success' : 'error',
      inserted.rowCount ? 'Stock added to the watchlist.' : 'That stock is already in this watchlist.',
    );
  } catch (error) {
    if (error.code !== '23503') throw error; // unknown stock
    flash(req, 'error', 'That stock does not exist.');
  }
  return res.redirect(`/watchlists/${id}`);
});

// edit note and target price

router.post('/watchlists/:id/items/:itemId/update', async (req, res, next) => {
  const id = parseId(req.params.id);
  const itemId = parseId(req.params.itemId);
  const watchlist = id && itemId && (await findOwnWatchlist(id, req.user.id));
  if (!watchlist) return notFound(next);

  const { data, errors } = parseForm(watchlistItemUpdateSchema, req.body);
  if (errors) {
    flash(req, 'error', Object.values(errors)[0]);
    return res.redirect(`/watchlists/${id}`);
  }

  const result = await query(
    `UPDATE watchlist_items
        SET note = $1, target_price = $2
      WHERE id = $3 AND watchlist_id = $4`,
    [data.note, data.targetPrice ?? null, itemId, id],
  );
  if (result.rowCount === 0) return notFound(next);

  flash(req, 'success', 'Item updated.');
  return res.redirect(`/watchlists/${id}`);
});

// remove a stock

router.post('/watchlists/:id/items/:itemId/delete', async (req, res, next) => {
  const id = parseId(req.params.id);
  const itemId = parseId(req.params.itemId);
  const watchlist = id && itemId && (await findOwnWatchlist(id, req.user.id));
  if (!watchlist) return notFound(next);

  await query('DELETE FROM watchlist_items WHERE id = $1 AND watchlist_id = $2', [itemId, id]);
  flash(req, 'success', 'Stock removed from the watchlist.');
  return res.redirect(`/watchlists/${id}`);
});

export default router;

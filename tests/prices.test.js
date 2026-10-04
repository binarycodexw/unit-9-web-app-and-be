import './setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MarketDataError } from '../src/services/alphavantage.js';
import { createPriceUpdater } from '../src/services/prices.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 15, 10, 0, 0);

// updater with a fake clock and a fake provider, no network or db
function setup({ refresh, ...options } = {}) {
  const clock = { time: T0 };
  const calls = [];
  const fake = refresh ?? (async (stock) => { calls.push(stock.symbol); });
  const wrapped = async (stock) => { calls.push(stock.symbol); return fake(stock); };
  const updater = createPriceUpdater({
    refresh: refresh ? wrapped : fake,
    enabled: true,
    maxAgeMs: 12 * HOUR,
    dailyBudget: 3,
    cooldownMs: 15 * 60 * 1000,
    stockBackoffMs: HOUR,
    now: () => clock.time,
    ...options,
  });
  return { updater, clock, calls };
}

const stock = (id, hoursOld) => ({
  id,
  symbol: `S${id}`,
  last_price_at: hoursOld === null ? null : new Date(T0 - hoursOld * HOUR),
});

describe('automatic price updates', () => {
  it('refreshes an old or missing price once and keeps a recent one', async () => {
    const { updater, calls } = setup();
    assert.equal((await updater.ensureFresh(stock(3, 1))).status, 'fresh');
    assert.equal(calls.length, 0);
    assert.equal((await updater.ensureFresh(stock(1, 30))).status, 'refreshed');
    assert.equal((await updater.ensureFresh(stock(2, null))).status, 'refreshed');
    assert.deepEqual(calls, ['S1', 'S2']);
  });
  it('stops after the daily budget and starts again the next UTC day', async () => {
    const { updater, clock, calls } = setup();
    for (const id of [1, 2, 3]) await updater.ensureFresh(stock(id, 30));
    assert.equal((await updater.ensureFresh(stock(4, 30))).status, 'stale');
    assert.equal(calls.length, 3);

    clock.time += 24 * HOUR;
    assert.equal((await updater.ensureFresh(stock(4, 30))).status, 'refreshed');
  });

  it('keeps the last price and pauses all calls after a quota error', async () => {
    const { updater, clock, calls } = setup({
      refresh: async () => { throw new MarketDataError('quota', 'quota'); },
    });
    const first = await updater.ensureFresh(stock(1, 30));
    assert.equal(first.status, 'stale');

    // other stocks wait for the cooldown too
    assert.equal((await updater.ensureFresh(stock(2, 30))).status, 'stale');
    assert.equal(calls.length, 1);

    clock.time += 16 * 60 * 1000;
    await updater.ensureFresh(stock(2, 30));
    assert.equal(calls.length, 2, 'provider is tried again after the cool-down');
  });
});

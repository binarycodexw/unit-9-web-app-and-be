import { config } from '../config.js';
import { MarketDataError, refreshStock } from './alphavantage.js';

const HOUR_MS = 60 * 60 * 1000;
const utcDay = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);

// Refreshes a stock price when its page is opened and the stored one is old.
// If anything goes wrong the old price is kept. Since any user can trigger this
// there are limits: max age per stock, a daily budget, a cooldown after
// quota/network errors, a backoff for stocks that failed and one call at a time per stock.
export function createPriceUpdater({
  refresh = refreshStock,
  enabled = Boolean(config.alphaVantageKey),
  maxAgeMs = config.priceMaxAgeHours * HOUR_MS,
  dailyBudget = config.apiDailyBudget,
  cooldownMs = 15 * 60 * 1000,
  stockBackoffMs = HOUR_MS,
  now = () => Date.now(),
} = {}) {
  let day = utcDay(now());
  let used = 0;
  let cooldownUntil = 0;
  const backoffUntil = new Map(); // stock id -> timestamp
  const inFlight = new Map(); // stock id -> Promise

  async function ensureFresh(stock) {
    if (!enabled) return { status: 'disabled' };

    const current = now();
    if (utcDay(current) !== day) {
      day = utcDay(current);
      used = 0;
    }

    const age = stock.last_price_at ? current - new Date(stock.last_price_at).getTime() : Number.POSITIVE_INFINITY;
    if (age < maxAgeMs) return { status: 'fresh' };

    if (inFlight.has(stock.id)) return inFlight.get(stock.id);

    const blocked =
      current < cooldownUntil || used >= dailyBudget || current < (backoffUntil.get(stock.id) ?? 0);
    if (blocked) return { status: 'stale' };

    used += 1;
    const job = refresh(stock)
      .then(() => {
        backoffUntil.delete(stock.id);
        return { status: 'refreshed' };
      })
      .catch((error) => {
        backoffUntil.set(stock.id, now() + stockBackoffMs);
        if (error instanceof MarketDataError) {
          if (error.kind === 'quota' || error.kind === 'network') cooldownUntil = now() + cooldownMs;
        } else {
          console.error(`Price update failed for ${stock.symbol}:`, error.message);
        }
        return { status: 'stale', reason: error.message };
      })
      .finally(() => inFlight.delete(stock.id));

    inFlight.set(stock.id, job);
    return job;
  }

  return { ensureFresh, stats: () => ({ used, cooldownUntil }) };
}

export const priceUpdater = createPriceUpdater();

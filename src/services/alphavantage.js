import { z } from 'zod';
import { config } from '../config.js';
import { withTransaction } from '../db.js';

// fixed url: user input never ends up in the host or path (SSRF)
const API_BASE = 'https://www.alphavantage.co/query';
const REQUEST_TIMEOUT_MS = 8_000;
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;

// kind: quota/network = provider is down, pause for everyone;
// symbol/format = only this stock; config = no api key
export class MarketDataError extends Error {
  constructor(message, kind = 'format') {
    super(message);
    this.name = 'MarketDataError';
    this.kind = kind;
  }
}

// third party data, check its shape
const numericString = z.string().regex(/^-?\d+(\.\d+)?$/);
const dailyCandle = z.object({
  '1. open': numericString,
  '2. high': numericString,
  '3. low': numericString,
  '4. close': numericString,
  '5. volume': z.string().regex(/^\d+$/),
});
const dailyResponse = z.object({
  'Time Series (Daily)': z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), dailyCandle),
});

export async function fetchDailySeries(symbol) {
  if (!config.alphaVantageKey) {
    throw new MarketDataError('ALPHAVANTAGE_API_KEY is not configured.', 'config');
  }
  if (!SYMBOL_PATTERN.test(symbol)) {
    throw new MarketDataError('Invalid symbol.', 'symbol');
  }

  const url = new URL(API_BASE);
  url.search = new URLSearchParams({
    function: 'TIME_SERIES_DAILY',
    symbol,
    outputsize: 'compact',
    apikey: config.alphaVantageKey,
  }).toString();

  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new MarketDataError('The market data provider did not respond in time.', 'network');
  }

  if (!response.ok) {
    throw new MarketDataError(`The market data provider returned HTTP ${response.status}.`, 'network');
  }

  const body = await response.json();

  // quota errors come back as a 200 with a Note/Information field
  if (body.Note || body.Information) {
    throw new MarketDataError('Daily API quota reached. Try again tomorrow or use the stored prices.', 'quota');
  }
  if (body['Error Message']) {
    throw new MarketDataError(`No market data found for ${symbol}.`, 'symbol');
  }

  const parsed = dailyResponse.safeParse(body);
  if (!parsed.success) {
    throw new MarketDataError('Unexpected response format from the market data provider.');
  }

  return Object.entries(parsed.data['Time Series (Daily)'])
    .map(([date, candle]) => ({
      date,
      open: Number.parseFloat(candle['1. open']),
      high: Number.parseFloat(candle['2. high']),
      low: Number.parseFloat(candle['3. low']),
      close: Number.parseFloat(candle['4. close']),
      volume: Number.parseInt(candle['5. volume'], 10),
    }))
    .filter((c) => c.high >= c.low && c.low >= 0)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

export async function refreshStock(stock) {
  const candles = await fetchDailySeries(stock.symbol);
  if (candles.length === 0) {
    throw new MarketDataError(`No candles returned for ${stock.symbol}.`, 'symbol');
  }
  const latest = candles[0];

  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO price_history (stock_id, trade_date, open_price, high_price, low_price, close_price, volume)
       SELECT $1::int, d, o, h, l, c, v
       FROM unnest($2::date[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::bigint[])
            AS t(d, o, h, l, c, v)
       ON CONFLICT (stock_id, trade_date) DO UPDATE
         SET open_price = EXCLUDED.open_price,
             high_price = EXCLUDED.high_price,
             low_price = EXCLUDED.low_price,
             close_price = EXCLUDED.close_price,
             volume = EXCLUDED.volume`,
      [
        stock.id,
        candles.map((c) => c.date),
        candles.map((c) => c.open),
        candles.map((c) => c.high),
        candles.map((c) => c.low),
        candles.map((c) => c.close),
        candles.map((c) => c.volume),
      ],
    );

    // delete seed candles inside the downloaded window, otherwise the chart
    // would mix fake and real prices
    await client.query(
      `DELETE FROM price_history
        WHERE stock_id = $1
          AND trade_date >= $2::date
          AND trade_date <> ALL($3::date[])`,
      [stock.id, candles[candles.length - 1].date, candles.map((c) => c.date)],
    );

    await client.query(
      'UPDATE stocks SET last_price = $1, last_price_at = now() WHERE id = $2',
      [latest.close, stock.id],
    );

    return { candles: candles.length, price: latest.close };
  });
}
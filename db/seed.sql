-- Sample data, the prices are made up. Real ones are downloaded from Alpha Vantage
-- the first time each stock page is opened.

INSERT INTO stocks (symbol, name, exchange, sector, last_price, last_price_at) VALUES
    ('AAPL',  'Apple Inc.',                 'NASDAQ', 'Technology',          190.00, NULL),
    ('MSFT',  'Microsoft Corporation',      'NASDAQ', 'Technology',          410.00, NULL),
    ('GOOGL', 'Alphabet Inc. Class A',      'NASDAQ', 'Communication',       150.00, NULL),
    ('AMZN',  'Amazon.com, Inc.',           'NASDAQ', 'Consumer Cyclical',   175.00, NULL),
    ('NVDA',  'NVIDIA Corporation',         'NASDAQ', 'Technology',          120.00, NULL),
    ('TSLA',  'Tesla, Inc.',                'NASDAQ', 'Consumer Cyclical',   220.00, NULL),
    ('JPM',   'JPMorgan Chase & Co.',       'NYSE',   'Financial Services',  195.00, NULL),
    ('KO',    'The Coca-Cola Company',      'NYSE',   'Consumer Defensive',   62.00, NULL),
    ('XOM',   'Exxon Mobil Corporation',    'NYSE',   'Energy',              110.00, NULL),
    ('JNJ',   'Johnson & Johnson',          'NYSE',   'Healthcare',          155.00, NULL)
ON CONFLICT (symbol) DO NOTHING;

-- fake price history for the last 60 weekdays, the last day matches last_price
INSERT INTO price_history (stock_id, trade_date, open_price, high_price, low_price, close_price, volume)
SELECT
    s.id,
    (current_date - g.n)                                                       AS trade_date,
    round((c.close_price * 0.998)::numeric, 4)                                 AS open_price,
    round((c.close_price * 1.010)::numeric, 4)                                 AS high_price,
    round((c.close_price * 0.990)::numeric, 4)                                 AS low_price,
    round(c.close_price::numeric, 4)                                           AS close_price,
    1000000 + ((g.n * 7919 + s.id * 104729) % 500000)                          AS volume
FROM stocks s
CROSS JOIN generate_series(0, 59) AS g(n)
CROSS JOIN LATERAL (
    SELECT s.last_price * (1 + 0.05 * sin(g.n / 7.0 + s.id) * (g.n / 59.0)) AS close_price
) AS c
WHERE s.last_price IS NOT NULL
  AND extract(isodow FROM (current_date - g.n)) < 6
ON CONFLICT (stock_id, trade_date) DO NOTHING;

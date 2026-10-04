
const toIsoDate = (value) => new Date(value).toISOString().slice(0, 10);

export function percentChange(values) {
  if (values.length < 2 || !values[0]) return null;
  return ((values[values.length - 1] - values[0]) / values[0]) * 100;
}

// drop target lines too far from the prices, they would squash the chart
function relevantLines(lines, prices) {
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const margin = (max - min) * 1.5 + max * 0.05;
  return lines.filter((line) => line.value >= min - margin && line.value <= max + margin);
}

export function buildPriceChart(rows, lines = []) {
  if (rows.length < 2) return null;

  const prices = rows.map((row) => Number(row.close_price));
  return {
    type: 'full',
    labels: rows.map((row) => toIsoDate(row.trade_date)),
    prices,
    isUp: prices[prices.length - 1] >= prices[0],
    lines: relevantLines(lines, prices),
  };
}

export function buildSparkline(closes) {
  if (!closes || closes.length < 2) return null;
  return {
    type: 'spark',
    prices: closes.map(Number),
    isUp: Number(closes[closes.length - 1]) >= Number(closes[0]),
  };
}

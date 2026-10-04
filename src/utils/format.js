const priceFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPrice(value) {
  if (value === null || value === undefined) return 'n/a';
  return priceFormatter.format(Number(value));
}

export function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function formatDate(value) {
  if (!value) return 'n/a';
  return new Date(value).toISOString().slice(0, 10);
}

export function formatDateTime(value) {
  if (!value) return 'n/a';
  return new Date(value).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

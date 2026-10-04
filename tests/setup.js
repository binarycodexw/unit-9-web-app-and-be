// has to be imported first, the app reads process.env on load
process.env.AUTH_RATE_LIMIT_MAX = '1000';
// no real api calls in tests, the key only allows 25 a day
process.env.ALPHAVANTAGE_API_KEY = '';

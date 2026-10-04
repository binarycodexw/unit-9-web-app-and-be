import { config } from './src/config.js';
import { pool } from './src/db.js';
import { createApp } from './src/app.js';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`${config.appName} listening on http://localhost:${config.port} (${config.isProduction ? 'production' : 'development'})`);
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

import { query } from '../db.js';

// never log passwords, tokens or mfa codes
export async function logSecurityEvent(req, eventType, { userId = null, details = '' } = {}) {
  try {
    await query(
      `INSERT INTO security_events (user_id, event_type, ip_address, details)
       VALUES ($1, $2, $3, $4)`,
      [userId ?? req.session?.userId ?? null, eventType, req.ip ?? null, String(details).slice(0, 300)],
    );
  } catch (error) {
    // a logging failure shouldn't break the request
    console.error('Failed to write security event:', error.message);
  }
}

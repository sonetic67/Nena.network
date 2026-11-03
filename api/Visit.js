// POST /api/visit -> { count: 37 }
// Zaehlt jeden Besucher (IP) einmal pro Tag, ab 00:00 Schweizer Zeit.
const { isConfigured, pipeline, visitorId, send } = require('./_redis');

module.exports = async function handler(req, res) {
  if (!isConfigured()) return send(res, 503, { error: 'not configured' });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(new Date()); // 2026-11-02
  const key = `visitors:${today}`;
  try {
    const results = req.method === 'POST'
      ? await pipeline([['SADD', key, visitorId(req)], ['EXPIRE', key, 60 * 60 * 48], ['SCARD', key]])
      : await pipeline([['SCARD', key]]);
    return send(res, 200, { count: Number(results[results.length - 1]) || 0 });
  } catch (e) {
    return send(res, 500, { error: 'database error' });
  }
};
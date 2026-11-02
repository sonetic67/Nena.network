// GET /api/likes?ids=1/collection1,2/collection1
// -> { counts: { "1/collection1": 4, ... }, liked: { "1/collection1": true, ... } }
const { isConfigured, pipeline, visitorId, validCollectionId, send } = require('./_redis');

module.exports = async function handler(req, res) {
  if (!isConfigured()) return send(res, 503, { error: 'not configured' });
  const url = new URL(req.url, 'http://x');
  const ids = String(url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(validCollectionId).slice(0, 200);
  if (ids.length === 0) return send(res, 200, { counts: {}, liked: {} });

  const me = visitorId(req);
  try {
    const results = await pipeline(ids.flatMap((id) => [['SCARD', `likes:${id}`], ['SISMEMBER', `likes:${id}`, me]]));
    const counts = {};
    const liked = {};
    ids.forEach((id, i) => {
      counts[id] = Number(results[i * 2]) || 0;
      liked[id] = Number(results[i * 2 + 1]) === 1;
    });
    return send(res, 200, { counts, liked });
  } catch (e) {
    return send(res, 500, { error: 'database error' });
  }
};

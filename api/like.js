// POST /api/like   Body: { "id": "1/collection1" }
// Like an/aus fuer diese Collection. Pro IP hoechstens ein Like (die Menge enthaelt jeden Besucher nur einmal).
// Schutz: nur Collections, die es wirklich gibt; hoechstens 30 Klicks pro Minute pro Besucher.
// -> { count: 5, liked: true }
const { isConfigured, pipeline, visitorId, validCollectionId, readBody, send } = require('./_redis');

// Gibt es die Collection? (prueft, ob ihr Hauptbild auf der eigenen Seite existiert)
async function collectionExists(req, id) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  if (!host) return false;
  const proto = String(req.headers['x-forwarded-proto'] || 'https');
  for (const ext of ['jpg', 'png', 'webp']) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(`${proto}://${host}/collection/${id}/main.${ext}`, { method: 'HEAD', signal: ctrl.signal });
      clearTimeout(timer);
      const type = res.headers.get('content-type') || '';
      if (res.ok && type.startsWith('image/')) return true;
    } catch (e) { /* naechste Endung probieren */ }
  }
  return false;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!isConfigured()) return send(res, 503, { error: 'not configured' });

  const { id } = readBody(req);
  if (!validCollectionId(id)) return send(res, 400, { error: 'invalid id' });

  const me = visitorId(req);
  const key = `likes:${id}`;
  try {
    // Rate-Limit: hoechstens 30 Klicks pro Minute
    const minute = Math.floor(Date.now() / 60000);
    const rlKey = `rl:${me}:${minute}`;
    const [clicks] = await pipeline([['INCR', rlKey], ['EXPIRE', rlKey, 120]]);
    if (Number(clicks) > 30) return send(res, 429, { error: 'too many requests' });

    if (!(await collectionExists(req, id))) return send(res, 404, { error: 'unknown collection' });

    const [isMember] = await pipeline([['SISMEMBER', key, me]]);
    const liked = Number(isMember) !== 1;
    const [, count] = await pipeline([[liked ? 'SADD' : 'SREM', key, me], ['SCARD', key]]);
    return send(res, 200, { count: Number(count) || 0, liked });
  } catch (e) {
    return send(res, 500, { error: 'database error' });
  }
};

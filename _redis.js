// Gemeinsame Hilfsfunktionen fuer die API (Dateien mit "_" werden von Vercel nicht als eigene Adresse veroeffentlicht).
// Spricht die Upstash-Redis-Datenbank ueber ihre REST-Schnittstelle an (kein zusaetzliches Paket noetig).
const crypto = require('crypto');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

function isConfigured() {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

// Mehrere Befehle in einem Aufruf: [['GET','a'], ['SADD','b','c']] -> [result, result]
async function pipeline(commands) {
  const res = await fetch(`${REDIS_URL.replace(/\/+$/, '')}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!res.ok) throw new Error(`Redis ${res.status}`);
  const data = await res.json();
  return data.map((d) => {
    if (d.error) throw new Error(d.error);
    return d.result;
  });
}

// Die IP wird nie gespeichert, nur ein nicht umkehrbarer Fingerabdruck davon.
function visitorId(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '');
  const ip = fwd.split(',')[0].trim() || String(req.headers['x-real-ip'] || '') || 'unknown';
  const salt = process.env.LIKE_SALT || REDIS_TOKEN || 'nena-network';
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32);
}

// Collection-Kennung wie "1/collection1" (Kuenstler-Ordner / Collection-Ordner)
function validCollectionId(id) {
  return typeof id === 'string' && id.length <= 120 && /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(id) && !id.includes('..');
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

module.exports = { isConfigured, pipeline, visitorId, validCollectionId, readBody, send };

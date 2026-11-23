// /api/upload-session
//   GET    -> { setup: { ready, missing, artists }, artist: "1" | null }   (ist jemand angemeldet?)
//   POST   Body: { artist: "1", password: "..." } -> Anmelden (Cookie, 12 Stunden)
//   DELETE -> Abmelden
// Schutz: hoechstens 8 Versuche pro Besucher und 30 pro Kuenstler in 15 Minuten.
const {
  send, visitorId, setupStatus, validArtist, checkPassword, sessionCookie, clearCookie, currentArtist, sameOrigin, overLimit
} = require('./_upload');
const { readBody } = require('./_redis');

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    return send(res, 200, { setup: setupStatus(), artist: currentArtist(req) });
  }
  if (!sameOrigin(req)) return send(res, 403, { error: 'Nur von der eigenen Seite' });

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearCookie());
    return send(res, 200, { artist: null });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST, GET oder DELETE' });

  const setup = setupStatus();
  if (!setup.ready) return send(res, 503, { error: 'Upload ist noch nicht eingerichtet', missing: setup.missing });

  const { artist, password } = readBody(req);
  if (!validArtist(artist)) return send(res, 400, { error: 'Kuenstler fehlt' });

  try {
    if (await overLimit(`upl:login:v:${visitorId(req)}`, 8, 900) || await overLimit(`upl:login:a:${artist}`, 30, 900)) {
      return send(res, 429, { error: 'Zu viele Versuche. Bitte in 15 Minuten nochmal.' });
    }
  } catch (e) {
    return send(res, 500, { error: 'Datenbankfehler' });
  }

  if (!checkPassword(artist, password)) return send(res, 401, { error: 'Passwort falsch' });

  res.setHeader('Set-Cookie', sessionCookie(artist));
  return send(res, 200, { artist });
};

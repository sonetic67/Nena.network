// POST /api/upload-image   Body: { image: "<JPEG als base64>", make: "Apple", model: "iPhone 15", taken: "2026:11:21 14:03:22" }
// Nur angemeldet. Das Bild wird hier nochmals bereinigt (auch wenn der Browser das schon getan hat):
// es bleiben nur die Bilddaten, Kamera (Hersteller + Modell) und Aufnahmedatum.
// Danach liegt es bei GitHub bereit, ist aber noch nirgends sichtbar - erst /api/upload-entry macht den Eintrag.
// -> { sha, receipt, width, height, bytes }
const { send, currentArtist, sameOrigin, overLimit, cleanJpeg, imageReceipt, github, agreementOk } = require('./_upload');
const { readBody } = require('./_redis');

const MAX_BASE64 = 4_300_000; // Vercel nimmt hoechstens ~4.5 MB pro Anfrage an

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!sameOrigin(req)) return send(res, 403, { error: 'Nur von der eigenen Seite' });
  const artist = currentArtist(req);
  if (!artist) return send(res, 401, { error: 'Bitte anmelden' });
  try {
    if (!(await agreementOk(artist))) return send(res, 403, { error: 'Bitte zuerst die Vereinbarung annehmen', code: 'agreement' });
  } catch (e) {
    return send(res, 500, { error: 'Datenbankfehler' });
  }

  const { image, make, model, taken } = readBody(req);
  if (typeof image !== 'string' || !image || image.length > MAX_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(image)) {
    return send(res, 400, { error: 'Bild fehlt oder ist zu gross' });
  }

  try {
    if (await overLimit(`upl:img:${artist}`, 120, 3600)) return send(res, 429, { error: 'Zu viele Bilder in einer Stunde' });
  } catch (e) {
    return send(res, 500, { error: 'Datenbankfehler' });
  }

  let clean;
  try {
    clean = cleanJpeg(Buffer.from(image, 'base64'), { make, model, taken });
  } catch (e) {
    return send(res, e.status || 400, { error: e.message });
  }

  try {
    const blob = await github('POST', '/git/blobs', { content: clean.data.toString('base64'), encoding: 'base64' });
    return send(res, 200, {
      sha: blob.sha,
      receipt: imageReceipt(blob.sha, artist),
      width: clean.width,
      height: clean.height,
      bytes: clean.data.length
    });
  } catch (e) {
    console.error('upload-image', e.message);
    return send(res, 502, { error: 'GitHub hat das Bild nicht angenommen' });
  }
};

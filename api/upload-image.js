// POST /api/upload-image   (nur angemeldet, nach Zustimmung zur Vereinbarung)
// Bilder werden in voller Groesse gespeichert (die Seite zeigt verkleinerte Kopien, im Vollbild das Original).
// Vercel nimmt hoechstens ~4.5 MB pro Anfrage an, darum kommen grosse Bilder in Teilen:
//
//   kleines Bild (bis 3 MB):  { image: "<JPEG base64>", make, model, taken, orientation }
//   grosses Bild, Teil fuer Teil: { upload: "<id>", index: 0..n-1, total: n, data: "<base64, bis 3 MB>" }
//                                  -> Teile liegen hoechstens 30 Minuten in Redis
//   grosses Bild, fertig:         { upload: "<id>", total: n, finish: true, make, model, taken, orientation }
//
// Das Bild wird hier (nochmals) bereinigt: es bleiben nur die Bilddaten, Kamera (Hersteller + Modell),
// Aufnahmedatum und Ausrichtung. Danach liegt es bei GitHub bereit, ist aber noch nirgends sichtbar -
// erst /api/upload-entry macht den Eintrag.
// -> { sha, receipt, width, height, bytes }   (bei Teilen: { ok, index })
const { send, currentArtist, sameOrigin, overLimit, cleanJpeg, imageReceipt, github, agreementOk } = require('./_upload');
const { readBody, pipeline } = require('./_redis');

const MAX_BASE64 = 4_300_000;           // eine Anfrage (Vercel: ~4.5 MB)
const MAX_PARTS = 24;                   // 24 x 3 MB = 72 MB
const MAX_BYTES = 60 * 1024 * 1024;     // ein Bild hoechstens 60 MB (GitHub nimmt hoechstens 100 MB pro Datei)
const PART_TTL = 1800;
const B64 = /^[A-Za-z0-9+/=]+$/;

const partKey = (artist, id, i) => `upl:part:${artist}:${id}:${i}`;

async function store(artist, buf, meta) {
  const clean = cleanJpeg(buf, meta); // wirft bei kaputten oder fremden Dateien
  const blob = await github('POST', '/git/blobs', { content: clean.data.toString('base64'), encoding: 'base64' });
  return {
    sha: blob.sha,
    receipt: imageReceipt(blob.sha, artist),
    width: clean.width,
    height: clean.height,
    bytes: clean.data.length
  };
}

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

  const body = readBody(req);
  const meta = { make: body.make, model: body.model, taken: body.taken, orientation: Number(body.orientation) || 1 };

  // ---------- grosses Bild in Teilen ----------
  if (body.upload !== undefined) {
    const id = String(body.upload);
    const total = Number(body.total);
    if (!/^[0-9a-f]{16,40}$/.test(id) || !Number.isInteger(total) || total < 1 || total > MAX_PARTS) {
      return send(res, 400, { error: 'Bild ist zu gross (höchstens 60 MB)' });
    }

    if (!body.finish) {
      const index = Number(body.index);
      const data = body.data;
      if (!Number.isInteger(index) || index < 0 || index >= total
        || typeof data !== 'string' || !data || data.length > MAX_BASE64 || !B64.test(data)) {
        return send(res, 400, { error: 'Bildteil fehlt oder ist zu gross' });
      }
      if (index === 0 && !data.startsWith('/9j/')) return send(res, 400, { error: 'Kein JPEG-Bild' }); // FF D8 FF
      try {
        if (await overLimit(`upl:part:${artist}`, 1500, 3600)) return send(res, 429, { error: 'Zu viele Bilder in einer Stunde' });
        await pipeline([['SET', partKey(artist, id, index), data, 'EX', PART_TTL]]);
      } catch (e) {
        console.error('upload-image part', e.message);
        return send(res, 500, { error: 'Zwischenspeicher nicht erreichbar' });
      }
      return send(res, 200, { ok: true, index });
    }

    // fertig: Teile zusammensetzen (einzeln holen - Redis gibt hoechstens 10 MB pro Antwort)
    let buf;
    try {
      if (await overLimit(`upl:img:${artist}`, 120, 3600)) return send(res, 429, { error: 'Zu viele Bilder in einer Stunde' });
      const keys = Array.from({ length: total }, (_, i) => partKey(artist, id, i));
      const parts = await Promise.all(keys.map(async (k) => (await pipeline([['GET', k]]))[0]));
      if (parts.some((p) => typeof p !== 'string' || !p)) return send(res, 400, { error: 'Ein Teil des Bildes fehlt - bitte nochmal hochladen' });
      buf = Buffer.concat(parts.map((p) => Buffer.from(p, 'base64')));
      pipeline([['DEL', ...keys]]).catch(() => { /* laeuft sowieso nach 30 Minuten ab */ });
    } catch (e) {
      console.error('upload-image finish', e.message);
      return send(res, 500, { error: 'Zwischenspeicher nicht erreichbar' });
    }
    if (buf.length > MAX_BYTES) return send(res, 400, { error: 'Bild ist zu gross (höchstens 60 MB)' });
    try {
      return send(res, 200, await store(artist, buf, meta));
    } catch (e) {
      if (e.status) return send(res, e.status, { error: e.message });
      console.error('upload-image', e.message);
      return send(res, 502, { error: 'GitHub hat das Bild nicht angenommen' });
    }
  }

  // ---------- kleines Bild in einem Stueck ----------
  const { image } = body;
  if (typeof image !== 'string' || !image || image.length > MAX_BASE64 || !B64.test(image)) {
    return send(res, 400, { error: 'Bild fehlt oder ist zu gross' });
  }
  try {
    if (await overLimit(`upl:img:${artist}`, 120, 3600)) return send(res, 429, { error: 'Zu viele Bilder in einer Stunde' });
  } catch (e) {
    return send(res, 500, { error: 'Datenbankfehler' });
  }
  try {
    return send(res, 200, await store(artist, Buffer.from(image, 'base64'), meta));
  } catch (e) {
    if (e.status) return send(res, e.status, { error: e.message });
    console.error('upload-image', e.message);
    return send(res, 502, { error: 'GitHub hat das Bild nicht angenommen' });
  }
};

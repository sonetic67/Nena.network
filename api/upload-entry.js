// POST /api/upload-entry
// Body: {
//   date: "2026-11-21", title: "Viel und schnell",
//   main:  { sha, receipt },                               (von /api/upload-image)
//   broll: [{ sha, receipt, title: "Skizze im Zug" }],     (optional, hoechstens 12)
//   brollTitle: "...", description: "..."                  (optional, nur mit B-Roll: landen in info.txt)
// }
// Legt alles in EINEM Commit in timeline/ ab, mit dem richtigen Dateinamen:
//   timeline/21112026_Viel und schnell_1.jpg
//   timeline/21112026_Viel und schnell_1/b1_Skizze im Zug.jpg
//   timeline/21112026_Viel und schnell_1/info.txt
// Danach macht die GitHub Action timeline.json neu und Vercel stellt die Seite neu bereit (ca. 1-2 Minuten).
const {
  send, currentArtist, sameOrigin, overLimit, checkReceipt, cleanTitle, cleanText, fileDate, pathExists, commitFiles, agreementOk
} = require('./_upload');
const { readBody } = require('./_redis');

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
  const date = fileDate(body.date);
  if (!date) return send(res, 400, { error: 'Datum fehlt oder ist ungueltig' });
  const title = cleanTitle(body.title);
  if (!title) return send(res, 400, { error: 'Titel fehlt oder enthaelt nicht erlaubte Zeichen (_ / ? # % & + :)' });

  const main = body.main || {};
  if (!checkReceipt(main.sha, artist, main.receipt)) return send(res, 400, { error: 'Hauptbild fehlt - bitte nochmal hochladen' });

  const broll = Array.isArray(body.broll) ? body.broll : [];
  if (broll.length > 12) return send(res, 400, { error: 'Hoechstens 12 B-Roll-Bilder' });
  for (const b of broll) {
    if (!b || !checkReceipt(b.sha, artist, b.receipt)) return send(res, 400, { error: 'Ein B-Roll-Bild fehlt - bitte nochmal hochladen' });
    if (b.title && !cleanTitle(b.title)) return send(res, 400, { error: `B-Roll-Titel "${String(b.title).slice(0, 40)}" enthaelt nicht erlaubte Zeichen` });
  }

  try {
    if (await overLimit(`upl:entry:${artist}`, 20, 3600)) return send(res, 429, { error: 'Zu viele Eintraege in einer Stunde' });
  } catch (e) {
    return send(res, 500, { error: 'Datenbankfehler' });
  }

  const name = `${date}_${title}_${artist}`;
  const base = `timeline/${name}`;
  const files = [{ path: `${base}.jpg`, sha: main.sha }];
  broll.forEach((b, i) => {
    const caption = cleanTitle(b.title) || `Bild ${i + 1}`;
    files.push({ path: `${base}/b${i + 1}_${caption}.jpg`, sha: b.sha });
  });
  if (broll.length) {
    const heading = cleanText(body.brollTitle, 80).replace(/\n+/g, ' ');
    const description = cleanText(body.description, 3000);
    const lines = [];
    if (heading) lines.push(`title: ${heading}`, '');
    if (description) lines.push(`desc: ${description}`);
    if (lines.length) files.push({ path: `${base}/info.txt`, content: `${lines.join('\n').trim()}\n` });
  }

  try {
    if (await pathExists(`${base}.jpg`) || await pathExists(base)) {
      return send(res, 409, { error: 'Es gibt schon einen Eintrag mit diesem Datum und Titel' });
    }
    const [d, m, y] = [date.slice(0, 2), date.slice(2, 4), date.slice(4)];
    const commit = await commitFiles(files, `Upload: ${title} (${d}.${m}.${y}), Kuenstler ${artist}${broll.length ? `, ${broll.length} B-Roll` : ''}`);
    return send(res, 200, { ok: true, path: `${base}.jpg`, files: files.map((f) => f.path), commit });
  } catch (e) {
    console.error('upload-entry', e.message);
    return send(res, 502, { error: 'Speichern bei GitHub hat nicht geklappt' });
  }
};

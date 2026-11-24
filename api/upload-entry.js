// POST /api/upload-entry   (nur angemeldet, nach Zustimmung zur Vereinbarung)
// Speichert alles in EINEM Commit. Bilder kommen vorher ueber /api/upload-image ({ sha, receipt }).
//
// type "timeline" (Standard):
//   { date: "2026-11-21", title: "Viel und schnell", main: {sha, receipt},
//     broll: [{ sha, receipt, title }], brollTitle, description }      (B-Roll hoechstens 12; Texte nur mit B-Roll)
//   -> timeline/21112026_Viel und schnell_1.jpg (+ Ordner mit b1_....jpg und info.txt)
//
// type "collection" (Galerie):
//   { title: "Fenster in Sommerbrise", subtitle: "Sommer 2026", description,
//     images: [{ sha, receipt, caption }] }                             (erstes Bild = Hauptbild, hoechstens 31)
//   -> collection/<kuenstler>/collection<N>/main.jpg, 1.jpg, 2.jpg ... + info.txt   (N = naechste freie Nummer)
//
// Danach aktualisiert die GitHub Action
// timeline.json bzw. uploads.json (ca. 1-2 Minuten).
const {
  send, currentArtist, sameOrigin, overLimit, checkReceipt, cleanTitle, cleanText, cleanLine, fileDate, pathExists,
  listDir, commitFiles, agreementOk
} = require('./_upload');
const { readBody } = require('./_redis');

function fail(status, error) {
  const e = new Error(error);
  e.status = status;
  return e;
}

// ---------- Zeitstrahl ----------
async function timelineEntry(body, artist) {
  const date = fileDate(body.date);
  if (!date) throw fail(400, 'Datum fehlt oder ist ungültig');
  const title = cleanTitle(body.title);
  if (!title) throw fail(400, 'Titel fehlt oder enthält nicht erlaubte Zeichen (_ / ? # % & + :)');

  const main = body.main || {};
  if (!checkReceipt(main.sha, artist, main.receipt)) throw fail(400, 'Hauptbild fehlt - bitte nochmal hochladen');

  const broll = Array.isArray(body.broll) ? body.broll : [];
  if (broll.length > 12) throw fail(400, 'Höchstens 12 B-Roll-Bilder');
  for (const b of broll) {
    if (!b || !checkReceipt(b.sha, artist, b.receipt)) throw fail(400, 'Ein B-Roll-Bild fehlt - bitte nochmal hochladen');
    if (b.title && !cleanTitle(b.title)) throw fail(400, `B-Roll-Titel "${String(b.title).slice(0, 40)}" enthält nicht erlaubte Zeichen`);
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

  if (await pathExists(`${base}.jpg`) || await pathExists(base)) throw fail(409, 'Es gibt schon einen Eintrag mit diesem Datum und Titel');
  const [d, m, y] = [date.slice(0, 2), date.slice(2, 4), date.slice(4)];
  const message = `Upload: ${title} (${d}.${m}.${y}), Kuenstler ${artist}${broll.length ? `, ${broll.length} B-Roll` : ''}`;
  return { files, message, path: `${base}.jpg` };
}

// ---------- Galerie ----------
async function collectionEntry(body, artist) {
  // Titel und Untertitel stehen in der Galerie in Grossbuchstaben (wie die bisherigen Kollektionen)
  const title = cleanLine(body.title, 60).toUpperCase();
  if (!title) throw fail(400, 'Titel fehlt');
  const subtitle = cleanLine(body.subtitle, 40).toUpperCase();
  const description = cleanText(body.description, 3000);

  const images = Array.isArray(body.images) ? body.images : [];
  if (!images.length) throw fail(400, 'Mindestens ein Bild (das Hauptbild)');
  if (images.length > 31) throw fail(400, 'Höchstens 31 Bilder pro Kollektion');
  for (const im of images) {
    if (!im || !checkReceipt(im.sha, artist, im.receipt)) throw fail(400, 'Ein Bild fehlt - bitte nochmal hochladen');
  }

  // naechste freie Nummer: collection1, collection2, ... (die Galerie sucht sie der Reihe nach)
  const existing = await listDir(`collection/${artist}`);
  const numbers = existing.map((n) => (n.match(/^collection(\d+)$/i) || [])[1]).filter(Boolean).map(Number);
  const n = (numbers.length ? Math.max(...numbers) : 0) + 1;
  const base = `collection/${artist}/collection${n}`;

  const files = images.map((im, i) => ({ path: `${base}/${i === 0 ? 'main' : i}.jpg`, sha: im.sha }));
  const lines = [`title: ${title}`];
  if (subtitle) lines.push(`subtitle: ${subtitle}`);
  if (description) lines.push(`description: ${description}`);
  lines.push('');
  images.forEach((im, i) => {
    let caption = cleanLine(im.caption, 200);
    if (/^dc(\s|$)/i.test(caption)) caption = caption.replace(/^dc/i, 'DC'); // "dc " am Anfang hiesse "breites Bild"
    if (caption) lines.push(`${i === 0 ? 'main' : i}: ${caption}`);
  });
  files.push({ path: `${base}/info.txt`, content: `${lines.join('\n').trim()}\n` });

  const message = `Upload: Kollektion ${title} (collection${n}), Kuenstler ${artist}, ${images.length} Bilder`;
  return { files, message, path: base };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!sameOrigin(req)) return send(res, 403, { error: 'Nur von der eigenen Seite' });
  const artist = currentArtist(req);
  if (!artist) return send(res, 401, { error: 'Bitte anmelden' });
  try {
    if (!(await agreementOk(artist))) return send(res, 403, { error: 'Bitte zuerst die Vereinbarung annehmen', code: 'agreement' });
    if (await overLimit(`upl:entry:${artist}`, 20, 3600)) return send(res, 429, { error: 'Zu viele Einträge in einer Stunde' });
  } catch (e) {
    return send(res, 500, { error: 'Datenbankfehler' });
  }

  const body = readBody(req);
  const type = body.type || 'timeline';
  const build = { timeline: timelineEntry, collection: collectionEntry }[type];
  if (!build) return send(res, 400, { error: 'Unbekannter Typ' });

  try {
    const { files, message, path } = await build(body, artist);
    const commit = await commitFiles(files, message);
    return send(res, 200, { ok: true, type, path, files: files.map((f) => f.path), commit });
  } catch (e) {
    if (e.status) return send(res, e.status, { error: e.message });
    console.error('upload-entry', e.message);
    return send(res, 502, { error: 'Speichern bei GitHub hat nicht geklappt' });
  }
};

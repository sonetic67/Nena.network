// POST /api/upload-edit   (nur angemeldet, nach Zustimmung zur Vereinbarung) - Bearbeiten in der Vorschau von /login
//   { action: "delete", type: "timeline", entry: "24112026_titel_1.jpg" }   Eintrag wie in timeline/timeline.json
//        -> loescht das Bild (oder den Ordner) samt B-Roll-Ordner, Bildtexten und Beschreibung
//   { action: "delete", type: "collection", key: "1/collection2", title: "TITEL" }
//        -> loescht die Kollektion; die danach ruecken nach (collection3 -> collection2 ...), mit ihren
//           Upload-Daten (collection/uploads.json), Likes und dem Platz in der Profil-Reihenfolge
//   { action: "delete", type: "image", key: "1/collection2", file: "3.jpg", title }
//        -> loescht ein Bild der Kollektion; die danach ruecken nach (Hauptbild weg: 1 wird Hauptbild), Bildtexte mit
//   { action: "replace", type: "image", key, file, title, sha, receipt }      (Bild vorher ueber /api/upload-image)
//   { action: "replace", type: "timeline", entry, sha, receipt }
//        -> ersetzt das Bild, Name, Bildtext und alles andere bleiben
//   { action: "text", type: "collection", key, oldTitle, title, subtitle, description, captions: { main: "...", "1": "..." } }
//        -> schreibt Titel, Untertitel, Beschreibung und Bildtexte in info.txt; alles andere dort bleibt
// Antwort: { ok, ..., check } - woran der Browser sieht, dass es online ist:
//   { timeline: entry } (nicht mehr in timeline.json), { path, gone: true } (Datei weg),
//   { path, replaced: true } (Datei hat die Groesse des neuen Bildes), { path, content } (Datei hat diesen Inhalt),
//   { wait: s } (einfach warten)
// Jeder darf nur seine eigenen Eintraege loeschen, der Betreiber alle (Entfernen auf Wunsch, Vereinbarung 6).
// Alles in einem Commit; aeltere Fassungen bleiben in der Git-Geschichte.
const {
  send, currentArtist, sameOrigin, overLimit, agreementOk, isAdmin, readRepoFile, repoTree, commitFiles, checkReceipt,
  cleanLine, cleanText
} = require('./_upload');
const { readBody, pipeline } = require('./_redis');

const IMG = /\.(jpe?g|png|webp)$/i;

function timelineFiles(tree, entry) {
  const clean = String(entry || '').trim().replace(/^\/+|\/+$/g, '');
  if (!clean || clean.length > 200 || clean.includes('..') || !/^[^/]+(\/[^/]+)?$/.test(clean)) return null;
  const stem = clean.replace(IMG, '');
  const owner = (stem.split('/').pop().split('_').pop() || '').trim();
  const paths = tree.map((e) => e.path).filter((p) => p === `timeline/${clean}` || p.startsWith(`timeline/${stem}/`));
  return { clean, owner, paths };
}

async function deleteTimeline(body, artist, tree) {
  const found = timelineFiles(tree, body.entry);
  if (!found) return { status: 400, error: 'Unbekannter Eintrag' };
  if (!isAdmin(artist) && found.owner !== artist) return { status: 403, error: 'Das ist nicht dein Eintrag' };
  if (!found.paths.length) return { status: 404, error: 'Den Eintrag gibt es nicht (mehr)' };
  const commit = await commitFiles(found.paths.map((path) => ({ path, remove: true })),
    `Loeschen: Zeitstrahl ${found.clean} (Kuenstler ${found.owner})`);
  return { status: 200, data: { ok: true, type: 'timeline', entry: found.clean, removed: found.paths.length, commit, check: { timeline: found.clean } } };
}

async function replaceTimeline(body, artist, tree) {
  const found = timelineFiles(tree, body.entry);
  if (!found) return { status: 400, error: 'Unbekannter Eintrag' };
  if (!isAdmin(artist) && found.owner !== artist) return { status: 403, error: 'Das ist nicht dein Eintrag' };
  if (!checkReceipt(body.sha, artist, body.receipt)) return { status: 400, error: 'Bild fehlt - bitte nochmal auswählen' };
  // Einzelbild: die Datei selbst; Ordner-Eintrag: sein erstes Bild (main oder 1)
  let target = found.paths.find((p) => p === `timeline/${found.clean}`);
  if (!target) {
    const imgs = found.paths.filter((p) => /\/(main|\d+)\.(jpe?g|png|webp)$/i.test(p) && p.split('/').length === `timeline/${found.clean}/x`.split('/').length);
    target = imgs.sort((a, b) => imageNumber(a) - imageNumber(b))[0];
  }
  if (!target) return { status: 404, error: 'Den Eintrag gibt es nicht (mehr)' };
  return replaceAt(target, body.sha, `Bild ersetzt: Zeitstrahl ${found.clean} (Kuenstler ${found.owner})`);
}

// "main.jpg" -> 0, "7.png" -> 7
function imageNumber(path) {
  const name = path.split('/').pop();
  if (/^main\./i.test(name)) return 0;
  const n = parseInt(name, 10);
  return Number.isFinite(n) ? n : 1e9;
}

// Neues Bild an die Stelle des alten (immer JPEG: aus "7.png" wird "7.jpg")
async function replaceAt(target, sha, message) {
  const jpeg = /\.jpe?g$/i.test(target) ? target : target.replace(/\.[a-z]+$/i, '.jpg');
  const files = [{ path: jpeg, sha }];
  if (jpeg !== target) files.push({ path: target, remove: true });
  const commit = await commitFiles(files, message);
  return { status: 200, data: { ok: true, type: 'replace', path: jpeg, commit, check: { path: jpeg, replaced: true } } };
}

const titleOf = (text) => ((String(text || '').match(/^\s*title\s*:\s*(.+)$/im) || [])[1] || '').trim();
const norm = (s) => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim().toUpperCase();

async function deleteCollection(body, artist, tree) {
  const m = String(body.key || '').match(/^(\d+)\/collection(\d+)$/);
  if (!m) return { status: 400, error: 'Unbekannte Kollektion' };
  const [, owner, numText] = m;
  const k = Number(numText);
  if (!isAdmin(artist) && owner !== artist) return { status: 403, error: 'Das ist nicht deine Kollektion' };

  const base = (j) => `collection/${owner}/collection${j}/`;
  const filesOf = (j) => tree.filter((e) => e.path.startsWith(base(j)));
  if (!filesOf(k).length) return { status: 404, error: 'Die Kollektion gibt es nicht (mehr)' };

  // Sicherheit: stimmt der Titel? (Sonst hat sich die Nummerierung inzwischen verschoben.)
  if (body.title !== undefined) {
    const now = titleOf(await readRepoFile(`${base(k)}info.txt`));
    if (now && norm(now).replace(/:$/, '') !== norm(body.title).replace(/:$/, '')) {
      return { status: 409, error: 'Die Seite hat sich inzwischen geändert – bitte neu laden und nochmal versuchen.' };
    }
  }

  // die Nummern danach (ohne Luecke, wie die Seite sie findet)
  let last = k;
  while (filesOf(last + 1).length) last += 1;

  const ops = new Map(); // Pfad -> { sha } (neu/ersetzt) oder { remove: true }
  for (let j = k; j <= last; j += 1) {
    const incoming = j < last ? filesOf(j + 1).map((e) => ({ path: base(j) + e.path.slice(base(j + 1).length), sha: e.sha })) : [];
    const keep = new Set(incoming.map((e) => e.path));
    filesOf(j).forEach((e) => { if (!keep.has(e.path)) ops.set(e.path, { remove: true }); });
    incoming.forEach((e) => ops.set(e.path, { sha: e.sha }));
  }
  const files = Array.from(ops, ([path, op]) => ({ path, ...op }));

  const shift = (name) => { // "collection5" -> "collection4" (nach der geloeschten), sonst gleich
    const n = Number((String(name).match(/^collection(\d+)$/) || [])[1]);
    if (!n || n < k || n > last) return name;
    return n === k ? null : `collection${n - 1}`;
  };

  // Upload-Daten mitverschieben (sonst sortiert "Empfohlen" falsch)
  try {
    const raw = await readRepoFile('collection/uploads.json');
    if (raw) {
      const uploads = JSON.parse(raw);
      const out = {};
      Object.keys(uploads).forEach((key) => {
        const [a, folder] = key.split('/');
        if (a !== owner) { out[key] = uploads[key]; return; }
        const to = shift(folder);
        if (to) out[`${a}/${to}`] = uploads[key];
      });
      const sorted = Object.fromEntries(Object.keys(out).sort().map((key) => [key, out[key]]));
      files.push({ path: 'collection/uploads.json', content: `${JSON.stringify(sorted, null, 2)}\n` });
    }
  } catch (e) { /* kaputt: der Workflow baut sie neu */ }

  // eigene Reihenfolge der Galerie (falls es sie gibt) und Profil-Reihenfolge
  try {
    const raw = await readRepoFile('collection/order.json');
    const order = raw ? JSON.parse(raw) : null;
    if (Array.isArray(order)) {
      const next = order.map((e) => {
        const [a, folder] = String(e).replace(/^collection\//, '').split('/');
        if (a !== owner) return e;
        const to = shift(folder);
        return to ? `${a}/${to}` : null;
      }).filter(Boolean);
      files.push({ path: 'collection/order.json', content: `${JSON.stringify(next, null, 2)}\n` });
    }
  } catch (e) { /* bleibt */ }
  try {
    const raw = await readRepoFile(`profiles/${owner}.json`);
    const profile = raw ? JSON.parse(raw) : null;
    if (profile && Array.isArray(profile.order)) {
      profile.order = profile.order.map(shift).filter(Boolean);
      files.push({ path: `profiles/${owner}.json`, content: `${JSON.stringify(profile, null, 2)}\n` });
    }
  } catch (e) { /* bleibt */ }

  const title = titleOf(await readRepoFile(`${base(k)}info.txt`)) || `collection${k}`;
  const commit = await commitFiles(files, `Loeschen: Kollektion ${title} (collection${k}), Kuenstler ${owner}`);

  // Likes wandern mit ihrer Kollektion
  try {
    await pipeline([['DEL', `likes:${owner}/collection${k}`]]);
    for (let j = k; j < last; j += 1) {
      const from = `likes:${owner}/collection${j + 1}`;
      const [exists] = await pipeline([['EXISTS', from]]);
      await pipeline([Number(exists) ? ['RENAME', from, `likes:${owner}/collection${j}`] : ['DEL', `likes:${owner}/collection${j}`]]);
    }
  } catch (e) {
    console.error('upload-edit likes', e.message);
  }

  return { status: 200, data: { ok: true, type: 'collection', key: `${owner}/collection${k}`, last, removed: filesOf(k).length, commit,
    check: { path: `${base(last)}info.txt`, gone: true } } };
}

// Bilder einer Kollektion (nur direkt im Ordner): Hauptbild, 1, 2, ... in dieser Reihenfolge
function collectionImages(tree, base) {
  return tree
    .filter((e) => e.path.startsWith(base) && !e.path.slice(base.length).includes('/')
      && /^(main|\d+)\.(jpe?g|png|webp)$/i.test(e.path.slice(base.length)))
    .sort((a, b) => imageNumber(a.path) - imageNumber(b.path));
}

async function collectionTarget(body, artist, tree) {
  const m = String(body.key || '').match(/^(\d+)\/collection(\d+)$/);
  const file = String(body.file || '');
  if (!m || !/^(main|\d+)\.(jpe?g|png|webp)$/i.test(file)) return { error: { status: 400, error: 'Unbekanntes Bild' } };
  const [, owner, k] = m;
  if (!isAdmin(artist) && owner !== artist) return { error: { status: 403, error: 'Das ist nicht deine Kollektion' } };
  const base = `collection/${owner}/collection${k}/`;
  const images = collectionImages(tree, base);
  const target = images.find((e) => e.path === base + file);
  if (!target) return { error: { status: 404, error: 'Das Bild gibt es nicht (mehr) – bitte neu laden.' } };
  const info = await readRepoFile(`${base}info.txt`);
  if (body.title !== undefined) {
    const now = titleOf(info);
    if (now && norm(now).replace(/:$/, '') !== norm(body.title).replace(/:$/, '')) {
      return { error: { status: 409, error: 'Die Seite hat sich inzwischen geändert – bitte neu laden und nochmal versuchen.' } };
    }
  }
  return { owner, k, base, images, target, info: info || '' };
}

async function deleteImage(body, artist, tree) {
  const t = await collectionTarget(body, artist, tree);
  if (t.error) return t.error;
  const { owner, k, base, images, target } = t;
  if (images.length < 2) return { status: 400, error: 'Das ist das einzige Bild – lösche stattdessen die ganze Kollektion.' };

  // die uebrigen der Reihe nach neu benennen: Hauptbild, 1, 2, ...
  const rest = images.filter((e) => e !== target);
  const keyOf = (path) => (imageNumber(path) === 0 ? 'main' : String(imageNumber(path)));
  const renamed = rest.map((e, i) => {
    const name = e.path.slice(base.length);
    const ext = name.slice(name.lastIndexOf('.'));
    const keepName = (i === 0 && /^main\./i.test(name)) || (i > 0 && imageNumber(e.path) === i);
    return { from: e, to: keepName ? e.path : `${base}${i === 0 ? 'main' : i}${ext.toLowerCase()}`, oldKey: keyOf(e.path), newKey: i === 0 ? 'main' : String(i) };
  });
  const wanted = new Map(renamed.map((r) => [r.to, r.from.sha]));
  const files = [];
  images.forEach((e) => { if (!wanted.has(e.path)) files.push({ path: e.path, remove: true }); });
  renamed.forEach((r) => { if (r.to !== r.from.path) files.push({ path: r.to, sha: r.from.sha }); });

  // Bildtexte in info.txt mitnehmen ("main: ...", "3: ...")
  if (t.info) {
    const map = new Map(renamed.map((r) => [r.oldKey, r.newKey]));
    const newKeys = new Set(renamed.map((r) => r.newKey));
    const gone = keyOf(target.path);
    const lines = t.info.split('\n').flatMap((line) => {
      const mm = line.match(/^(\s*)(main|\d+)(\s*:.*)$/i);
      if (!mm) return [line];
      const key = mm[2].toLowerCase();
      if (key === gone) return [];
      if (map.has(key)) return [`${mm[1]}${map.get(key)}${mm[3]}`];
      return newKeys.has(key) ? [] : [line]; // Bildtext ohne Bild: weg, wenn seine Nummer jetzt ein anderes Bild hat
    });
    const text = lines.join('\n');
    if (text !== t.info) files.push({ path: `${base}info.txt`, content: text });
  }

  const commit = await commitFiles(files, `Bild geloescht: ${target.path.slice(base.length)} aus Kollektion ${titleOf(t.info) || `collection${k}`} (Kuenstler ${owner})`);
  const last = images[images.length - 1].path;
  return { status: 200, data: { ok: true, type: 'image', removed: target.path, commit,
    check: wanted.has(last) ? { wait: 90 } : { path: last, gone: true } } };
}

async function replaceImage(body, artist, tree) {
  const t = await collectionTarget(body, artist, tree);
  if (t.error) return t.error;
  if (!checkReceipt(body.sha, artist, body.receipt)) return { status: 400, error: 'Bild fehlt - bitte nochmal auswählen' };
  return replaceAt(t.target.path, body.sha, `Bild ersetzt: ${t.target.path.slice(t.base.length)} in Kollektion ${titleOf(t.info) || `collection${t.k}`} (Kuenstler ${t.owner})`);
}

// ---------- Texte einer Kollektion ----------
const KEY_LINE = /^(title|subtitle|date|artist|desc|description\s*[12]?|main|\d+)\s*:/i;
const PLACEMENT = /^(desc|description)\s*:\s*[12]\s*$/i; // "desc: 1" = wo die Beschreibungs-Kachel steht

// "dc" am Anfang eines Bildtextes hiesse "breites Bild" - so wie beim Hochladen entschaerfen
const captionText = (v) => {
  const c = cleanLine(v, 200);
  return /^dc(\s|$)/i.test(c) ? c.replace(/^dc/i, 'DC') : c;
};

// Aendert nur Titel, Untertitel, Beschreibung und Bildtexte; Datum, Kuenstler, "desc: 1", breite Bilder ("dc") usw. bleiben
function rewriteInfo(old, { title, subtitle, description, captions }) {
  const lines = String(old || '').replace(/\r/g, '').split('\n');
  const out = [];
  const desc = description ? description.split('\n') : [];
  const done = { title: false, subtitle: false, description: false };
  const seenCaptions = new Set();
  for (let i = 0; i < lines.length;) {
    const t = lines[i].trim();
    if (/^title\s*:/i.test(t)) { if (!done.title) out.push(`title: ${title}`); done.title = true; i += 1; continue; }
    if (/^subtitle\s*:/i.test(t)) { if (!done.subtitle && subtitle) out.push(`subtitle: ${subtitle}`); done.subtitle = true; i += 1; continue; }
    if (/^(desc|description\s*[12]?)\s*:/i.test(t) && !PLACEMENT.test(t)) {
      const prefix = t.match(/^(desc|description\s*[12]?)\s*:/i)[1];
      i += 1;
      while (i < lines.length && !KEY_LINE.test(lines[i].trim())) i += 1; // alte Folgezeilen weg
      if (!done.description && desc.length) out.push(`${prefix}: ${desc[0]}`, ...desc.slice(1), '');
      done.description = true;
      continue;
    }
    const cap = t.match(/^(main|\d+)\s*:\s*(.*)$/i);
    if (cap && Object.prototype.hasOwnProperty.call(captions, cap[1].toLowerCase())) {
      const key = cap[1].toLowerCase();
      if (!seenCaptions.has(key) && captions[key]) out.push(`${key}: ${/^dc(\s+|$)/i.test(cap[2]) ? 'dc ' : ''}${captions[key]}`);
      seenCaptions.add(key);
      i += 1;
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  // was es noch nicht gab: oben einfuegen (Titel, Untertitel, Beschreibung), Bildtexte unten
  const head = [];
  if (!done.title) head.push(`title: ${title}`);
  if (!done.subtitle && subtitle) head.push(`subtitle: ${subtitle}`);
  let at = out.findIndex((l) => /^(title|subtitle)\s*:/i.test(l.trim()));
  while (at >= 0 && at + 1 < out.length && /^(title|subtitle)\s*:/i.test(out[at + 1].trim())) at += 1;
  if (!done.description && desc.length) head.push(`description: ${desc[0]}`, ...desc.slice(1), '');
  out.splice(at < 0 ? 0 : at + 1, 0, ...head);
  const missing = Object.keys(captions).filter((k) => captions[k] && !seenCaptions.has(k))
    .sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : Number(a) - Number(b)));
  if (missing.length && out.length && out[out.length - 1].trim()) out.push('');
  missing.forEach((k) => out.push(`${k}: ${captions[k]}`));
  // hoechstens eine Leerzeile am Stueck
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return `${text}\n`;
}

async function editCollectionText(body, artist, tree) {
  const m = String(body.key || '').match(/^(\d+)\/collection(\d+)$/);
  if (!m) return { status: 400, error: 'Unbekannte Kollektion' };
  const [, owner, k] = m;
  if (!isAdmin(artist) && owner !== artist) return { status: 403, error: 'Das ist nicht deine Kollektion' };
  const base = `collection/${owner}/collection${k}/`;
  const images = collectionImages(tree, base);
  if (!images.length) return { status: 404, error: 'Die Kollektion gibt es nicht (mehr)' };
  const old = (await readRepoFile(`${base}info.txt`)) || '';
  const now = titleOf(old);
  if (body.oldTitle !== undefined && now && norm(now).replace(/:$/, '') !== norm(body.oldTitle).replace(/:$/, '')) {
    return { status: 409, error: 'Die Seite hat sich inzwischen geändert – bitte neu laden und nochmal versuchen.' };
  }

  const title = cleanLine(body.title, 60).toUpperCase();
  if (!title) return { status: 400, error: 'Titel fehlt' };
  const subtitle = cleanLine(body.subtitle, 40).toUpperCase();
  const description = cleanText(body.description, 3000);
  // nur Bildtexte zu Bildern, die es gibt
  const keys = new Set(images.map((e) => (imageNumber(e.path) === 0 ? 'main' : String(imageNumber(e.path)))));
  const captions = {};
  const given = body.captions && typeof body.captions === 'object' ? body.captions : {};
  Object.keys(given).forEach((key) => {
    const kk = String(key).toLowerCase();
    if (keys.has(kk)) captions[kk] = captionText(given[key]);
  });

  const content = rewriteInfo(old, { title, subtitle, description, captions });
  if (content === old) return { status: 200, data: { ok: true, type: 'text', unchanged: true, check: { wait: 0 } } };
  const commit = await commitFiles([{ path: `${base}info.txt`, content }], `Texte geaendert: Kollektion ${title} (collection${k}), Kuenstler ${owner}`);
  return { status: 200, data: { ok: true, type: 'text', commit, check: { path: `${base}info.txt`, content } } };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!sameOrigin(req)) return send(res, 403, { error: 'Nur von der eigenen Seite' });
  const artist = currentArtist(req);
  if (!artist) return send(res, 401, { error: 'Bitte anmelden' });
  try {
    if (!(await agreementOk(artist))) return send(res, 403, { error: 'Bitte zuerst die Vereinbarung annehmen', code: 'agreement' });
    if (await overLimit(`upl:edit:${artist}`, 60, 3600)) return send(res, 429, { error: 'Zu viele Änderungen in einer Stunde' });
  } catch (e) {
    return send(res, 500, { error: 'Datenbankfehler' });
  }

  const body = readBody(req);
  const run = (body.action === 'replace' ? { timeline: replaceTimeline, image: replaceImage }
    : body.action === 'text' ? { collection: editCollectionText }
      : { timeline: deleteTimeline, collection: deleteCollection, image: deleteImage })[body.type];
  if (!run) return send(res, 400, { error: 'Unbekannter Typ' });
  try {
    const tree = await repoTree();
    const result = await run(body, artist, tree);
    return result.status === 200 ? send(res, 200, result.data) : send(res, result.status, { error: result.error });
  } catch (e) {
    console.error('upload-edit', e.message);
    return send(res, 502, { error: 'GitHub hat nicht geantwortet' });
  }
};
module.exports.rewriteInfo = rewriteInfo; // fuer Tests

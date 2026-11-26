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
//   { action: "text", type: "collection", key, oldTitle, title, subtitle, description, captions: { main: "...", "1": "..." },
//     order: ["3", "main", "1", ...] }
//        -> schreibt Titel, Untertitel, Beschreibung und Bildtexte in info.txt; alles andere dort bleibt.
//           order (optional) = die bisherigen Bilder in neuer Reihenfolge: das erste wird Hauptbild, die anderen 1, 2, ...
//           Bildtexte (nach bisherigem Namen) und breite Bilder ("dc") wandern mit
//   { action: "text", type: "timeline", entry, title, heading, description,
//     broll: [{ file: "b2_skizze.jpg", title: "skizze", changed: true }, ...] }   (B-Roll in neuer Reihenfolge)
//        -> Titel (benennt Bild und B-Roll-Ordner um), Ueberschrift und Beschreibung der B-Roll (info.txt),
//           Titel und Reihenfolge der B-Roll-Bilder (b1_..., b2_...)
// Antwort: { ok, ..., check } - woran der Browser sieht, dass es online ist:
//   { timeline: entry } (nicht mehr in timeline.json), { path, gone: true } (Datei weg),
//   { path, replaced: true } (Datei hat die Groesse des neuen Bildes), { path, content } (Datei hat diesen Inhalt),
//   { wait: s } (einfach warten)
// Jeder darf nur seine eigenen Eintraege loeschen, der Betreiber alle (Entfernen auf Wunsch, Vereinbarung 6).
// Alles in einem Commit; aeltere Fassungen bleiben in der Git-Geschichte.
const {
  send, currentArtist, sameOrigin, overLimit, agreementOk, isAdmin, readRepoFile, repoTree, commitFiles, checkReceipt,
  cleanLine, cleanText, cleanTitle
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
function rewriteInfo(old, { title, subtitle, description, captions, wide }) {
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
      const dc = wide ? wide.has(key) : /^dc(\s+|$)/i.test(cap[2]);
      if (!seenCaptions.has(key) && captions[key]) out.push(`${key}: ${dc ? 'dc ' : ''}${captions[key]}`);
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
  missing.forEach((k) => out.push(`${k}: ${wide && wide.has(k) ? 'dc ' : ''}${captions[k]}`));
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
  const keyOf = (path) => (imageNumber(path) === 0 ? 'main' : String(imageNumber(path)));
  const current = images.map((e) => ({ key: keyOf(e.path), e }));
  const given = body.captions && typeof body.captions === 'object' ? body.captions : {};
  const givenFor = (key) => (Object.prototype.hasOwnProperty.call(given, key) ? given[key] : undefined);

  // neue Reihenfolge (die bisherigen Namen, jedes Bild genau einmal)
  let order = current.map((c) => c.key);
  if (Array.isArray(body.order)) {
    const want = body.order.map((x) => String(x).toLowerCase());
    if (want.length !== order.length || new Set(want).size !== want.length || want.some((x) => !order.includes(x))) {
      return { status: 409, error: 'Die Bilder haben sich inzwischen geändert – bitte neu laden und nochmal versuchen.' };
    }
    order = want;
  }
  const moved = order.some((key, i) => key !== current[i].key);

  const files = [];
  const captions = {};
  let wide = null;
  if (!moved) {
    // nur Texte: Bildtexte bleiben bei ihrem Bild
    current.forEach((c) => { if (givenFor(c.key) !== undefined) captions[c.key] = captionText(givenFor(c.key)); });
  } else {
    // Bilder neu benennen: erstes = Hauptbild, dann 1, 2, ... (Bildtext und "breit" wandern mit)
    const wideOld = new Set(String(old).split('\n').map((l) => l.trim().match(/^(main|\d+)\s*:\s*dc(\s+|$)/i)).filter(Boolean).map((mm) => mm[1].toLowerCase()));
    wide = new Set();
    const wanted = new Map();
    order.forEach((oldKey, i) => {
      const src = current.find((c) => c.key === oldKey).e;
      const name = src.path.slice(base.length);
      const newKey = i === 0 ? 'main' : String(i);
      wanted.set(`${base}${newKey}${name.slice(name.lastIndexOf('.')).toLowerCase()}`, src.sha);
      const oldCaption = givenFor(oldKey);
      captions[newKey] = captionText(oldCaption !== undefined ? oldCaption : '');
      if (wideOld.has(oldKey)) wide.add(newKey);
    });
    const existing = new Map(images.map((e) => [e.path, e.sha]));
    images.forEach((e) => { if (!wanted.has(e.path)) files.push({ path: e.path, remove: true }); });
    wanted.forEach((sha, path) => { if (existing.get(path) !== sha) files.push({ path, sha }); });
    // alte Nummern, die es nicht mehr gibt (Luecken werden geschlossen): ihre Bildtext-Zeilen weg
    current.forEach((c) => { if (!Object.prototype.hasOwnProperty.call(captions, c.key)) captions[c.key] = ''; });
    // Bildtexte, die der Browser nicht geschickt hat: aus der alten Datei uebernehmen
    order.forEach((oldKey, i) => {
      if (givenFor(oldKey) !== undefined) return;
      const line = String(old).split('\n').map((l) => l.trim()).find((l) => new RegExp(`^${oldKey}\\s*:`, 'i').test(l));
      captions[i === 0 ? 'main' : String(i)] = line ? line.replace(/^[^:]*:\s*/, '').replace(/^dc(\s+|$)/i, '').trim() : '';
    });
  }

  const content = rewriteInfo(old, { title, subtitle, description, captions, wide });
  if (content === old && !files.length) return { status: 200, data: { ok: true, type: 'text', unchanged: true, check: { wait: 0 } } };
  if (content !== old) files.push({ path: `${base}info.txt`, content });
  const commit = await commitFiles(files, `${moved ? 'Kollektion umsortiert' : 'Texte geaendert'}: ${title} (collection${k}), Kuenstler ${owner}`);
  return { status: 200, data: { ok: true, type: 'text', commit, check: { path: `${base}info.txt`, content } } };
}

// ---------- Texte eines Zeitstrahl-Eintrags ----------
// Name: "18112026_1_titel_1" -> { prefix: "18112026_1", title: "titel", artist: "1" }
function splitStem(stem) {
  const m = String(stem).match(/^(\d{8}(?:_\d+)?)_(.+)_(\d+)$/);
  return m ? { prefix: m[1], title: m[2], artist: m[3] } : null;
}
// B-Roll-Datei "b2_04112026_skizze.jpg" -> { num: 2, date: "04112026", title: "skizze", ext: ".jpg" }
function splitBroll(name) {
  const m = String(name).match(/^b(\d+)[_-](.*?)(\.[a-z0-9]+)$/i);
  if (!m) return null;
  const d = m[2].match(/^(\d{8})_(.+)$/);
  return { num: Number(m[1]), date: d ? d[1] : '', title: d ? d[2] : m[2], ext: m[3].toLowerCase() };
}

// info.txt der B-Roll: "title:" und den ersten "desc:"-Block ersetzen, alles andere behalten
function rewriteBrollInfo(old, heading, description) {
  const lines = String(old || '').replace(/\r/g, '').split('\n');
  const out = [];
  let doneTitle = false;
  let doneDesc = false;
  const key = /^(title|desc|description|text|b?\d+)\s*:/i;
  const desc = description ? description.split('\n') : [];
  for (let i = 0; i < lines.length;) {
    const t = lines[i].trim();
    if (/^title\s*:/i.test(t)) { if (!doneTitle && heading) out.push(`title: ${heading}`, ''); doneTitle = true; i += 1; continue; }
    if (!doneDesc && /^(desc|description|text)\s*:/i.test(t)) {
      i += 1;
      while (i < lines.length && !key.test(lines[i].trim())) i += 1;
      if (desc.length) out.push(`desc: ${desc[0]}`, ...desc.slice(1), '');
      doneDesc = true;
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  const head = [];
  if (!doneTitle && heading) head.push(`title: ${heading}`, '');
  if (!doneDesc && desc.length) head.push(`desc: ${desc[0]}`, ...desc.slice(1), '');
  const text = head.concat(out).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text ? `${text}\n` : '';
}

async function editTimelineText(body, artist, tree) {
  const found = timelineFiles(tree, body.entry);
  if (!found) return { status: 400, error: 'Unbekannter Eintrag' };
  if (!isAdmin(artist) && found.owner !== artist) return { status: 403, error: 'Das ist nicht dein Eintrag' };
  const mainPath = `timeline/${found.clean}`;
  const main = tree.find((e) => e.path === mainPath);
  if (!main || !IMG.test(found.clean)) return { status: 400, error: 'Dieser Eintrag lässt sich hier nicht bearbeiten.' };
  const ext = found.clean.slice(found.clean.lastIndexOf('.'));
  const stem = found.clean.slice(0, -ext.length);
  const folder = `timeline/${stem}/`;
  const inFolder = tree.filter((e) => e.path.startsWith(folder));

  // Titel -> neuer Name fuer Bild und Ordner
  const parts = splitStem(stem.split('/').pop());
  let newStem = stem;
  if (body.title !== undefined && parts) {
    const title = cleanTitle(body.title);
    if (!title) return { status: 400, error: 'Titel fehlt oder enthält nicht erlaubte Zeichen (_ / ? # % & + :)' };
    if (title !== parts.title) {
      const dir = stem.includes('/') ? `${stem.slice(0, stem.lastIndexOf('/') + 1)}` : '';
      newStem = `${dir}${parts.prefix}_${title}_${parts.artist}`;
      const clash = tree.some((e) => e.path === `timeline/${newStem}${ext}` || e.path.startsWith(`timeline/${newStem}/`)
        || (IMG.test(e.path) && e.path.replace(IMG, '') === `timeline/${newStem}`));
      if (clash) return { status: 409, error: 'Es gibt schon einen Eintrag mit diesem Datum und Titel.' };
    }
  }
  const newFolder = `timeline/${newStem}/`;

  // B-Roll: neue Reihenfolge und Titel
  const brollNow = inFolder.filter((e) => !e.path.slice(folder.length).includes('/') && splitBroll(e.path.slice(folder.length)) && IMG.test(e.path))
    .sort((a, b) => splitBroll(a.path.slice(folder.length)).num - splitBroll(b.path.slice(folder.length)).num);
  const want = Array.isArray(body.broll) ? body.broll : brollNow.map((e) => ({ file: e.path.slice(folder.length), changed: false }));
  const names = brollNow.map((e) => e.path.slice(folder.length));
  if (want.length !== names.length || new Set(want.map((b) => String(b && b.file))).size !== names.length
    || want.some((b) => !b || !names.includes(String(b.file)))) {
    return { status: 409, error: 'Die B-Roll hat sich inzwischen geändert – bitte neu laden und nochmal versuchen.' };
  }
  const renamed = new Map(); // alter Pfad (im Ordner) -> neuer Name
  for (let i = 0; i < want.length; i += 1) {
    const b = want[i];
    const old = splitBroll(b.file);
    let title = old.title;
    if (b.changed) {
      const t = String(b.title || '').trim();
      title = t ? cleanTitle(t) : '';
      if (t && !title) return { status: 400, error: `B-Roll-Titel "${t.slice(0, 40)}" enthält nicht erlaubte Zeichen (_ / ? # % & + :)` };
      if (!title) title = `Bild ${i + 1}`;
    } else if (/^Bild \d+$/.test(old.title)) {
      title = `Bild ${i + 1}`; // Standardname folgt der neuen Nummer
    }
    renamed.set(b.file, `b${i + 1}_${old.date ? `${old.date}_` : ''}${title}${old.ext}`); // Datum im Namen bleibt
  }

  // info.txt (nur mit B-Roll sichtbar)
  const oldInfo = (await readRepoFile(`${folder}info.txt`)) || '';
  const heading = cleanText(body.heading, 80).replace(/\n+/g, ' ');
  const description = cleanText(body.description, 3000);
  const info = brollNow.length ? rewriteBrollInfo(oldInfo, heading, description) : oldInfo;

  // gewuenschter Endzustand
  const wanted = new Map(); // Pfad -> { sha } | { content }
  wanted.set(`timeline/${newStem}${ext}`, { sha: main.sha });
  inFolder.forEach((e) => {
    const rest = e.path.slice(folder.length);
    if (rest === 'info.txt') return;
    wanted.set(newFolder + (renamed.get(rest) || rest), { sha: e.sha });
  });
  if (info) wanted.set(`${newFolder}info.txt`, { content: info });

  const existing = new Map(tree.map((e) => [e.path, e.sha]));
  const files = [];
  [mainPath, ...inFolder.map((e) => e.path)].forEach((path) => { if (!wanted.has(path)) files.push({ path, remove: true }); });
  wanted.forEach((v, path) => {
    if (v.sha && existing.get(path) === v.sha) return;
    if (v.content !== undefined && path === `${folder}info.txt` && v.content === oldInfo) return;
    files.push({ path, ...v });
  });
  if (!files.length) return { status: 200, data: { ok: true, type: 'text', unchanged: true, check: { wait: 0 } } };

  const label = parts ? (newStem !== stem ? `${parts.title} -> ${splitStem(newStem.split('/').pop()).title}` : parts.title) : stem;
  const commit = await commitFiles(files, `Zeitstrahl bearbeitet: ${label} (Kuenstler ${found.owner})`);
  const entry = `${newStem}${ext}`;
  const brollList = want.map((b) => `${newStem}/${renamed.get(b.file)}`);
  const check = newStem !== stem ? { timelineHas: entry }
    : [...renamed].some(([from, to]) => from !== to) ? { broll: { entry, files: brollList } }
      : info ? { path: `${newFolder}info.txt`, content: info } : { path: `${folder}info.txt`, gone: true };
  return { status: 200, data: { ok: true, type: 'text', entry, commit, check } };
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
    : body.action === 'text' ? { collection: editCollectionText, timeline: editTimelineText }
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

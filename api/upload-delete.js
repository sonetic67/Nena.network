// POST /api/upload-delete   (nur angemeldet, nach Zustimmung zur Vereinbarung)
//   { type: "timeline", entry: "24112026_titel_1.jpg" }        Eintrag wie in timeline/timeline.json
//        -> loescht das Bild (oder den Ordner) samt B-Roll-Ordner, Bildtexten und Beschreibung
//   { type: "collection", key: "1/collection2", title: "TITEL" }
//        -> loescht die Kollektion; die danach ruecken nach (collection3 -> collection2 ...), mit ihren
//           Upload-Daten (collection/uploads.json), Likes und dem Platz in der Profil-Reihenfolge
// Jeder darf nur seine eigenen Eintraege loeschen, der Betreiber alle (Entfernen auf Wunsch, Vereinbarung 6).
// Alles in einem Commit; aeltere Fassungen bleiben in der Git-Geschichte.
const {
  send, currentArtist, sameOrigin, overLimit, agreementOk, isAdmin, readRepoFile, repoTree, commitFiles
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
  return { status: 200, data: { ok: true, type: 'timeline', entry: found.clean, removed: found.paths.length, commit } };
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
    console.error('upload-delete likes', e.message);
  }

  return { status: 200, data: { ok: true, type: 'collection', key: `${owner}/collection${k}`, last, removed: filesOf(k).length, commit } };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!sameOrigin(req)) return send(res, 403, { error: 'Nur von der eigenen Seite' });
  const artist = currentArtist(req);
  if (!artist) return send(res, 401, { error: 'Bitte anmelden' });
  try {
    if (!(await agreementOk(artist))) return send(res, 403, { error: 'Bitte zuerst die Vereinbarung annehmen', code: 'agreement' });
    if (await overLimit(`upl:delete:${artist}`, 30, 3600)) return send(res, 429, { error: 'Zu viele Löschungen in einer Stunde' });
  } catch (e) {
    return send(res, 500, { error: 'Datenbankfehler' });
  }

  const body = readBody(req);
  const run = { timeline: deleteTimeline, collection: deleteCollection }[body.type];
  if (!run) return send(res, 400, { error: 'Unbekannter Typ' });
  try {
    const tree = await repoTree();
    const result = await run(body, artist, tree);
    return result.status === 200 ? send(res, 200, result.data) : send(res, result.status, { error: result.error });
  } catch (e) {
    console.error('upload-delete', e.message);
    return send(res, 502, { error: 'GitHub hat nicht geantwortet' });
  }
};

// /api/upload-profile   (nur angemeldet, nach Zustimmung zur Vereinbarung)
//   GET  -> { profile: { text, picture, order }, images: [{ path, group }], collections: ["collection1", ...] }
//           images = alle eigenen Bilder (Galerie, Zeitstrahl, B-Roll, eigenes Profilbild) fuer die Auswahl
//   POST { text, picture: null | { path } | { sha, receipt }, order: ["collection3", "collection1", ...] }
//        -> speichert profiles/<kuenstler>.json (+ neues Profilbild profiles/<kuenstler>-<id>.jpg)
//
// profiles/<kuenstler>.json liest die Kuenstlerseite:
//   text    = Profiltext oben auf der Seite
//   picture = Profilbild ("/collection/2/collection1/main.jpg" oder "/profiles/2-1a2b3c4d.jpg")
//   order   = Reihenfolge "Empfohlen" der eigenen Kollektionen (Standard-Sortierung der Seite)
const {
  send, currentArtist, sameOrigin, overLimit, agreementOk, checkReceipt, cleanText, readRepoFile, repoPaths, commitFiles
} = require('./_upload');
const { readBody } = require('./_redis');

const IMG = '(?:jpe?g|png|webp)';

function ownImages(paths, artist) {
  const a = artist.replace(/[^0-9]/g, '');
  const rules = [
    [new RegExp(`^collection/${a}/(collection\\d+)/(?:main|\\d+)\\.${IMG}$`, 'i'), (m) => m[1]],
    [new RegExp(`^timeline/[^/]+_${a}\\.${IMG}$`, 'i'), () => 'timeline'],
    [new RegExp(`^timeline/[^/]+_${a}/b\\d+[_-][^/]+\\.${IMG}$`, 'i'), () => 'broll'],
    [new RegExp(`^profiles/${a}-[0-9a-f]{8}\\.${IMG}$`, 'i'), () => 'profile']
  ];
  const out = [];
  for (const p of paths) {
    for (const [re, group] of rules) {
      const m = p.match(re);
      if (m) { out.push({ path: p, group: group(m) }); break; }
    }
  }
  const rank = (g) => (g === 'profile' ? 0 : g.startsWith('collection') ? 1 : g === 'timeline' ? 2 : 3);
  const num = (p) => parseInt((p.match(/collection(\d+)\/(?:main|(\d+))/) || [])[2] || '0', 10);
  return out.sort((x, y) => rank(x.group) - rank(y.group) || x.group.localeCompare(y.group, undefined, { numeric: true })
    || num(x.path) - num(y.path) || y.path.localeCompare(x.path));
}

async function currentProfile(artist) {
  const raw = await readRepoFile(`profiles/${artist}.json`);
  try {
    const p = raw ? JSON.parse(raw) : {};
    return { text: typeof p.text === 'string' ? p.text : '', picture: typeof p.picture === 'string' ? p.picture : '', order: Array.isArray(p.order) ? p.order : [] };
  } catch (e) {
    return { text: '', picture: '', order: [] };
  }
}

module.exports = async function handler(req, res) {
  const artist = currentArtist(req);
  if (!artist) return send(res, 401, { error: 'Bitte anmelden' });
  try {
    if (!(await agreementOk(artist))) return send(res, 403, { error: 'Bitte zuerst die Vereinbarung annehmen', code: 'agreement' });
  } catch (e) {
    return send(res, 500, { error: 'Datenbankfehler' });
  }

  try {
    const [paths, profile] = await Promise.all([repoPaths(), currentProfile(artist)]);
    const images = ownImages(paths, artist);
    const collections = Array.from(new Set(images.map((i) => i.group).filter((g) => /^collection\d+$/.test(g))))
      .sort((x, y) => parseInt(x.slice(10), 10) - parseInt(y.slice(10), 10));

    if (req.method === 'GET') return send(res, 200, { profile, images, collections });
    if (req.method !== 'POST') return send(res, 405, { error: 'GET oder POST' });
    if (!sameOrigin(req)) return send(res, 403, { error: 'Nur von der eigenen Seite' });
    if (await overLimit(`upl:entry:${artist}`, 20, 3600)) return send(res, 429, { error: 'Zu viele Änderungen in einer Stunde' });

    const body = readBody(req);
    const text = cleanText(body.text, 2000);
    const files = [];

    // Profilbild: eines der eigenen Bilder, ein neu hochgeladenes oder keines
    let picture = '';
    const pic = body.picture;
    if (pic && typeof pic.path === 'string') {
      const path = pic.path.replace(/^\/+/, '');
      if (!images.some((i) => i.path === path)) return send(res, 400, { error: 'Dieses Bild gehört nicht zu deinen Uploads' });
      picture = `/${path}`;
    } else if (pic && pic.sha) {
      if (!checkReceipt(pic.sha, artist, pic.receipt)) return send(res, 400, { error: 'Profilbild fehlt - bitte nochmal auswählen' });
      const path = `profiles/${artist}-${pic.sha.slice(0, 8)}.jpg`; // neuer Name = kein altes Bild aus dem Zwischenspeicher
      files.push({ path, sha: pic.sha });
      picture = `/${path}`;
    }
    // altes, eigens hochgeladenes Profilbild aufraeumen, wenn es nicht mehr gebraucht wird
    const old = (profile.picture || '').replace(/^\/+/, '');
    if (/^profiles\/\d+-[0-9a-f]{8}\.jpg$/i.test(old) && `/${old}` !== picture && paths.includes(old)) files.push({ path: old, remove: true });

    // Reihenfolge "Empfohlen": nur eigene Kollektionen, jede einmal, fehlende hinten anhaengen
    const wanted = Array.isArray(body.order) ? body.order.filter((c) => typeof c === 'string' && collections.includes(c)) : [];
    const order = Array.from(new Set(wanted.concat(collections)));

    const json = { text, picture, order };
    files.push({ path: `profiles/${artist}.json`, content: `${JSON.stringify(json, null, 2)}\n` });
    const commit = await commitFiles(files, `Profil: Kuenstler ${artist}`);
    return send(res, 200, { ok: true, profile: json, commit });
  } catch (e) {
    console.error('upload-profile', e.message);
    return send(res, 502, { error: 'GitHub hat nicht geantwortet' });
  }
};

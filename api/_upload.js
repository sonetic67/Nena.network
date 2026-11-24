// Gemeinsame Hilfsfunktionen fuer die Upload-Seite (/upload). Kein zusaetzliches Paket noetig.
//
// Einstellungen in Vercel (Settings -> Environment Variables):
//   UPLOAD_GITHUB_TOKEN    GitHub-Schluessel (fine-grained), nur dieses Repo, "Contents: Read and write"
//   UPLOAD_SESSION_SECRET  langer Zufallstext (auf /upload?setup erzeugen)
//   UPLOAD_PASSWORD_1      Passwort-Fingerabdruck fuer Kuenstler 1 (auf /upload?setup erzeugen), _2 fuer Kuenstler 2 ...
//   UPLOAD_GITHUB_REPO     optional, Standard "sonetic67/Nena.network"
//   UPLOAD_GITHUB_BRANCH   optional, Standard "main"
const crypto = require('crypto');
const { isConfigured: redisConfigured, pipeline, visitorId, send } = require('./_redis');

// Fassung der Vereinbarung ueber die Veroeffentlichung (Text in upload.html, id="agreementText").
// Wird der Text geaendert, hier das Datum erhoehen: dann muessen alle neu zustimmen.
const AGREEMENT_VERSION = '2026-11-24';
// Der Betreiber (Kuenstler-Nummer) muss nicht mit sich selbst eine Vereinbarung abschliessen und sieht alle Zustimmungen.
const ADMIN_ARTIST = process.env.UPLOAD_ADMIN || '1';

const GITHUB_API = (process.env.UPLOAD_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
const GITHUB_REPO = process.env.UPLOAD_GITHUB_REPO || 'sonetic67/Nena.network';
const GITHUB_BRANCH = process.env.UPLOAD_GITHUB_BRANCH || 'main';
const SESSION_HOURS = 12;
const COOKIE = 'nena_upload';

function secret() {
  return process.env.UPLOAD_SESSION_SECRET || '';
}

function passwordHash(artist) {
  return validArtist(artist) ? (process.env[`UPLOAD_PASSWORD_${artist}`] || '') : '';
}

// Welche Einstellungen fehlen noch? (nur Namen, nie Werte)
function setupStatus() {
  const artists = Object.keys(process.env)
    .map((k) => (k.match(/^UPLOAD_PASSWORD_(\d{1,3})$/) || [])[1])
    .filter(Boolean)
    .sort((a, b) => a - b);
  const missing = [];
  if (!redisConfigured()) missing.push('KV_REST_API_URL'); // Datenbank: speichert die Zustimmungen zur Vereinbarung
  if (!process.env.UPLOAD_GITHUB_TOKEN) missing.push('UPLOAD_GITHUB_TOKEN');
  if (secret().length < 32) missing.push('UPLOAD_SESSION_SECRET');
  if (!artists.length) missing.push('UPLOAD_PASSWORD_1');
  return { ready: missing.length === 0, missing, artists };
}

function validArtist(a) {
  return typeof a === 'string' && /^\d{1,3}$/.test(a);
}

// ---------- Signaturen (Anmelde-Cookie, Bild-Belege) ----------

function sign(text) {
  return crypto.createHmac('sha256', secret()).update(text).digest('base64url');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Passwort pruefen. Gespeichert ist nur: pbkdf2$<runden>$<salz>$<fingerabdruck> (base64)
function checkPassword(artist, password) {
  const stored = passwordHash(artist);
  const m = stored.match(/^pbkdf2\$(\d{4,7})\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/);
  if (!m || typeof password !== 'string' || !password || password.length > 200) {
    // trotzdem rechnen, damit die Antwortzeit nichts verraet
    crypto.pbkdf2Sync('x', 'nena-dummy-salt', 210000, 32, 'sha256');
    return false;
  }
  const expected = Buffer.from(m[3], 'base64');
  // NFC: "ü" kann je nach Tastatur als ein oder zwei Zeichen ankommen (die Einrichtungsseite macht dasselbe)
  const actual = crypto.pbkdf2Sync(password.normalize('NFC'), Buffer.from(m[2], 'base64'), parseInt(m[1], 10), expected.length, 'sha256');
  return expected.length > 0 && crypto.timingSafeEqual(actual, expected);
}

function sessionCookie(artist) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600;
  const value = `${artist}.${exp}.${sign(`session.${artist}.${exp}`)}`;
  return `${COOKIE}=${value}; Path=/api/; Max-Age=${SESSION_HOURS * 3600}; HttpOnly; Secure; SameSite=Strict`;
}

function clearCookie() {
  return `${COOKIE}=; Path=/api/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

// Angemeldeter Kuenstler ("1", "2", ...) oder null
function currentArtist(req) {
  if (secret().length < 32) return null;
  const raw = String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  const [artist, exp, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!validArtist(artist) || !/^\d+$/.test(exp || '') || !sig) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  if (!safeEqual(sig, sign(`session.${artist}.${exp}`))) return null;
  if (!passwordHash(artist)) return null; // Passwort entfernt = abgemeldet
  return artist;
}

// Beleg, dass ein Bild ueber /api/upload-image (also bereinigt) hochgeladen wurde
function imageReceipt(sha, artist) {
  const exp = Math.floor(Date.now() / 1000) + 2 * 3600;
  return `${exp}.${sign(`image.${sha}.${artist}.${exp}`)}`;
}

function checkReceipt(sha, artist, receipt) {
  const [exp, sig] = String(receipt || '').split('.');
  if (!/^[0-9a-f]{40}$/.test(String(sha)) || !/^\d+$/.test(exp || '') || !sig) return false;
  if (Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, sign(`image.${sha}.${artist}.${exp}`));
}

// Nur Anfragen von der eigenen Seite (Schutz gegen fremde Seiten, die im Namen eines angemeldeten Kuenstlers posten)
function sameOrigin(req) {
  const origin = String(req.headers.origin || '');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch (e) { return false; }
}

// Zaehler pro Zeitfenster (Upstash Redis). Ohne Datenbank: kein Limit.
async function overLimit(key, max, seconds) {
  if (!redisConfigured()) return false;
  const windowKey = `${key}:${Math.floor(Date.now() / 1000 / seconds)}`; // feste Zeitfenster wie bei den Likes
  const [count] = await pipeline([['INCR', windowKey], ['EXPIRE', windowKey, seconds * 2]]);
  return Number(count) > max;
}

// ---------- Vereinbarung ueber die Veroeffentlichung ----------
// Gespeichert pro Kuenstler: { artist, name, version, at } - nur Name, Datum und Fassung, keine IP.

const agreementKey = (artist) => `upl:agreement:${artist}`;

async function getAgreement(artist) {
  const [raw] = await pipeline([['GET', agreementKey(artist)]]);
  try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

async function getAgreements(artists) {
  if (!artists.length) return {};
  const raws = await pipeline([['MGET', ...artists.map(agreementKey)]]);
  const list = Array.isArray(raws[0]) ? raws[0] : [];
  const out = {};
  artists.forEach((a, i) => {
    try { out[a] = list[i] ? JSON.parse(list[i]) : null; } catch (e) { out[a] = null; }
  });
  return out;
}

async function saveAgreement(artist, name) {
  const record = { artist, name, version: AGREEMENT_VERSION, at: new Date().toISOString() };
  await pipeline([['SET', agreementKey(artist), JSON.stringify(record)]]);
  return record;
}

const isAdmin = (artist) => artist === ADMIN_ARTIST;

// Darf hochladen: Betreiber immer, alle anderen erst nach Zustimmung zur aktuellen Fassung
async function agreementOk(artist) {
  if (isAdmin(artist)) return true;
  const rec = await getAgreement(artist);
  return Boolean(rec && rec.version === AGREEMENT_VERSION);
}

// Vollstaendiger Name als Unterschrift: Buchstaben, Leerzeichen, Bindestrich, Apostroph, Punkt; 3-80 Zeichen, mind. 2 Woerter
function cleanSignature(s) {
  const t = String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (t.length < 3 || t.length > 80 || !/^[\p{L}][\p{L} .'-]*$/u.test(t) || t.split(' ').length < 2) return '';
  return t;
}

// ---------- Bilder: alles entfernen ausser Kamera und Aufnahmedatum ----------

function badImage(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

const ascii = (s, max) => String(s || '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, max);

// "2026:11:21 14:03:22" (EXIF-Format) oder leer
function exifDate(s) {
  const m = String(s || '').trim().match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return '';
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return '';
  return m[0];
}

// Kleinster moeglicher EXIF-Block: Hersteller, Modell, Ausrichtung = normal, Aufnahmedatum. Sonst nichts.
function buildExif({ make, model, taken }) {
  make = ascii(make, 64);
  model = ascii(model, 64);
  taken = exifDate(taken);
  if (!make && !model && !taken) return null;

  const asciiVal = (s) => Buffer.from(`${s}\0`, 'latin1');
  const ifd0 = [];
  if (make) ifd0.push({ tag: 0x010f, type: 2, value: asciiVal(make) });
  if (model) ifd0.push({ tag: 0x0110, type: 2, value: asciiVal(model) });
  ifd0.push({ tag: 0x0112, type: 3, value: Buffer.from([1, 0]) }); // Ausrichtung: normal (Bild ist schon gedreht)
  const exifIfd = [];
  if (taken) exifIfd.push({ tag: 0x9003, type: 2, value: asciiVal(taken) });
  if (exifIfd.length) ifd0.push({ tag: 0x8769, type: 4, value: Buffer.alloc(4), pointer: true });

  const ifdSize = (n) => 2 + n * 12 + 4;
  const ifd0At = 8;
  const exifAt = ifd0At + ifdSize(ifd0.length);
  let dataAt = exifAt + (exifIfd.length ? ifdSize(exifIfd.length) : 0);
  const out = Buffer.alloc(dataAt + 256);
  out.write('II', 0, 'latin1');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(ifd0At, 4);

  const writeIfd = (at, entries) => {
    out.writeUInt16LE(entries.length, at);
    entries.forEach((e, i) => {
      const p = at + 2 + i * 12;
      const count = e.type === 2 ? e.value.length : 1;
      out.writeUInt16LE(e.tag, p);
      out.writeUInt16LE(e.type, p + 2);
      out.writeUInt32LE(count, p + 4);
      if (e.pointer) {
        out.writeUInt32LE(exifAt, p + 8);
      } else if (e.value.length <= 4) {
        e.value.copy(out, p + 8);
      } else {
        out.writeUInt32LE(dataAt, p + 8);
        e.value.copy(out, dataAt);
        dataAt += e.value.length + (e.value.length % 2);
      }
    });
    out.writeUInt32LE(0, at + 2 + entries.length * 12); // kein weiteres IFD
  };
  writeIfd(ifd0At, ifd0);
  if (exifIfd.length) writeIfd(exifAt, exifIfd);

  const tiff = out.subarray(0, dataAt);
  const header = Buffer.from([0xff, 0xe1, 0, 0, 0x45, 0x78, 0x69, 0x66, 0, 0]); // APP1 "Exif\0\0"
  header.writeUInt16BE(tiff.length + 8, 2);
  return Buffer.concat([header, tiff]);
}

// Baut ein JPEG neu zusammen: nur die Bilddaten bleiben. Entfernt EXIF (GPS, Seriennummern, Software ...),
// XMP, IPTC, Kommentare, Vorschaubilder und alles hinter dem Bildende (z.B. Bewegungs-Videos von Handys).
// Behalten: Farbprofil (ICC) und Farb-Angaben, die zum korrekten Anzeigen noetig sind.
function cleanJpeg(buf, meta) {
  if (!Buffer.isBuffer(buf) || buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) throw badImage('Kein JPEG-Bild');
  const parts = [];
  let jfif = null;
  let width = 0;
  let height = 0;
  let scans = 0;
  let ended = false;
  let pos = 2;

  while (pos < buf.length) {
    if (buf[pos] !== 0xff) throw badImage('Bilddatei beschaedigt');
    let marker = buf[pos + 1];
    while (marker === 0xff && pos + 2 < buf.length) { pos += 1; marker = buf[pos + 1]; } // Fuellbytes
    if (marker === 0xd9) { ended = true; break; } // Bildende: alles danach wird verworfen
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { parts.push(buf.subarray(pos, pos + 2)); pos += 2; continue; }
    if (pos + 4 > buf.length) throw badImage('Bilddatei beschaedigt');
    const len = buf.readUInt16BE(pos + 2);
    if (len < 2 || pos + 2 + len > buf.length) throw badImage('Bilddatei beschaedigt');
    const seg = buf.subarray(pos, pos + 2 + len);
    const id = seg.subarray(4, 16).toString('latin1');
    let keep;
    if (marker >= 0xe0 && marker <= 0xef) {
      if (marker === 0xe0 && id.startsWith('JFIF\0')) { jfif = seg; keep = false; }
      else keep = (marker === 0xe2 && id.startsWith('ICC_PROFILE')) || (marker === 0xee && id.startsWith('Adobe'));
    } else {
      keep = marker !== 0xfe; // Kommentare weg, Bild-Segmente bleiben
    }
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      height = seg.readUInt16BE(5);
      width = seg.readUInt16BE(7);
    }
    if (keep) parts.push(seg);
    pos += 2 + len;

    if (marker === 0xda) {
      // Bilddaten bis zum naechsten echten Marker (FF00 = Datenbyte, FFD0-D7 = Neustart-Marker)
      scans += 1;
      const start = pos;
      while (pos < buf.length - 1) {
        if (buf[pos] === 0xff) {
          const next = buf[pos + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { pos += 2; continue; }
          if (next === 0xff) { pos += 1; continue; }
          break;
        }
        pos += 1;
      }
      parts.push(buf.subarray(start, pos));
    }
  }

  if (!ended || !scans || !width || !height) throw badImage('Bilddatei unvollstaendig');
  if (width > 6000 || height > 6000 || width < 50 || height < 50) throw badImage('Bildgroesse nicht erlaubt');

  const exif = buildExif(meta || {});
  return {
    data: Buffer.concat([Buffer.from([0xff, 0xd8]), ...(jfif ? [jfif] : []), ...(exif ? [exif] : []), ...parts, Buffer.from([0xff, 0xd9])]),
    width,
    height
  };
}

// ---------- Texte und Dateinamen ----------

// Erlaubt: Buchstaben (auch ae/oe/ue/e mit Akzent ...), Ziffern, Leerzeichen und . , ' ! ( ) -
// Nicht: _ (trennt Datum/Titel/Kuenstler im Dateinamen), / \ ? # % & + : und Steuerzeichen
function cleanTitle(s, max = 60) {
  const t = String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!t || t.length > max) return '';
  if (!/^[\p{L}\p{N} .,'!()-]+$/u.test(t)) return '';
  if (/^\d{1,3}$/.test(t)) return ''; // reine Zahl wuerde als Kuenstler-Nummer gelesen
  if (/^[.\s-]/.test(t) || /[.\s]$/.test(t)) return '';
  return t;
}

// Text fuer info.txt: Zeilen, die wie ein Schluessel aussehen ("2: ...", "title: ..."), wuerden sonst falsch gelesen
function cleanText(s, max) {
  return String(s || '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .slice(0, max)
    .split('\n')
    .map((line) => line.replace(/^(\s*)(b?\d+|title|desc|description|text)(\s*):/i, '$1$2$3 –'))
    .join('\n')
    .trim();
}

// "2026-11-21" -> "21112026" (wie die anderen Timeline-Dateien)
function fileDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const [y, mo, d] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (y < 2000 || y > 2100 || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return '';
  return `${m[3]}${m[2]}${m[1]}`;
}

// ---------- GitHub ----------

async function github(method, path, body) {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.UPLOAD_GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nena-network-upload',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status}: ${(data && data.message) || text.slice(0, 200)}`);
    err.githubStatus = res.status;
    throw err;
  }
  return data;
}

async function pathExists(path) {
  try {
    await github('GET', `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
    return true;
  } catch (e) {
    if (e.githubStatus === 404) return false;
    throw e;
  }
}

// Ein Commit mit allen Dateien. files: [{ path, sha }] (schon hochgeladene Bilder) oder [{ path, content }] (Text)
async function commitFiles(files, message) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ref = await github('GET', `/git/ref/heads/${encodeURIComponent(GITHUB_BRANCH)}`);
    const head = ref.object.sha;
    const headCommit = await github('GET', `/git/commits/${head}`);
    const tree = await github('POST', '/git/trees', {
      base_tree: headCommit.tree.sha,
      tree: files.map((f) => (f.sha
        ? { path: f.path, mode: '100644', type: 'blob', sha: f.sha }
        : { path: f.path, mode: '100644', type: 'blob', content: f.content }))
    });
    const commit = await github('POST', '/git/commits', { message, tree: tree.sha, parents: [head] });
    try {
      await github('PATCH', `/git/refs/heads/${encodeURIComponent(GITHUB_BRANCH)}`, { sha: commit.sha, force: false });
      return commit.sha;
    } catch (e) {
      if (e.githubStatus !== 422 || attempt === 2) throw e; // jemand anderes hat gleichzeitig gepusht: nochmal
    }
  }
  throw new Error('commit failed');
}

module.exports = {
  AGREEMENT_VERSION,
  getAgreement,
  getAgreements,
  saveAgreement,
  agreementOk,
  isAdmin,
  cleanSignature,
  send,
  visitorId,
  setupStatus,
  validArtist,
  checkPassword,
  sessionCookie,
  clearCookie,
  currentArtist,
  imageReceipt,
  checkReceipt,
  sameOrigin,
  overLimit,
  cleanJpeg,
  buildExif,
  exifDate,
  cleanTitle,
  cleanText,
  fileDate,
  github,
  pathExists,
  commitFiles
};

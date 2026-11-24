// /api/upload-spellcheck   (nur angemeldet, nach Zustimmung zur Vereinbarung)
//   POST { texts: { "<feld>": "text", ... } }
//     -> { style: { lowercase, swiss }, texts: { "<feld>": { changes: [{ offset, length, from, to, message, kind }] } },
//          unavailable?: true }
//   POST { remember: "wort" }  -> Wort ins persoenliche Woerterbuch: wird nie mehr korrigiert
//
// Prueft mit LanguageTool (api.languagetool.org, Texte werden dort laut Anbieter nicht gespeichert).
// Korrigiert wird nur Rechtschreibung, Grammatik, Zeichensetzung, Zusammenschreibung - keine Stilvorschlaege,
// keine Typografie (Gedankenstriche, Anfuehrungszeichen bleiben wie geschrieben).
// Die Seite wendet die Aenderungen an; der Server liefert nur die Liste.
const { send, currentArtist, sameOrigin, overLimit, agreementOk } = require('./_upload');
const { readBody, isConfigured: redisConfigured, pipeline } = require('./_redis');

const LT_URL = process.env.UPLOAD_LANGUAGETOOL_URL || 'https://api.languagetool.org/v2/check';

// Schreibstil pro Kuenstler, so wie die Texte jetzt auf der Seite stehen:
//   lowercase: alles klein (Grossschreibung wird nicht "korrigiert", Vorschlaege kommen klein)
//   swiss:     ß -> ss
const STYLES = {
  1: { language: 'de-CH', lowercase: true, swiss: true } // Dylan: deutsch, alles klein, Schweizer ss
};
const DEFAULT_STYLE = { language: 'auto', preferredVariants: 'de-CH,en-GB', lowercase: false, swiss: true };

const MAX_TOTAL = 18000; // LanguageTool nimmt hoechstens 20 KB pro Anfrage

const dictKey = (artist) => `upl:dict:${artist}`;
const KIND = { TYPOS: 'spelling', GRAMMAR: 'grammar', PUNCTUATION: 'punctuation', CASING: 'casing', COMPOUNDING: 'spelling', CONFUSED_WORDS: 'grammar' };

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
  const style = STYLES[artist] || DEFAULT_STYLE;

  // Wort merken
  if (typeof body.remember === 'string') {
    const word = body.remember.normalize('NFC').trim().toLowerCase();
    if (!word || word.length > 60 || /\s/.test(word)) return send(res, 400, { error: 'Ungültiges Wort' });
    if (!redisConfigured()) return send(res, 503, { error: 'Keine Datenbank' });
    await pipeline([['SADD', dictKey(artist), word]]);
    return send(res, 200, { remembered: word });
  }

  const texts = body.texts && typeof body.texts === 'object' ? body.texts : {};
  const keys = Object.keys(texts).filter((k) => typeof texts[k] === 'string' && texts[k].trim()).slice(0, 40);
  const out = { style: { lowercase: style.lowercase, swiss: style.swiss }, texts: {} };
  keys.forEach((k) => { out.texts[k] = { changes: [] }; });
  if (!keys.length) return send(res, 200, out);

  try {
    if (await overLimit(`upl:spell:${artist}`, 40, 600)) return send(res, 429, { error: 'Zu viele Prüfungen. Bitte kurz warten.' });
  } catch (e) { /* ohne Datenbank: kein Limit */ }

  // Alle Felder in EINER Anfrage (Limit 20 Anfragen pro Minute), getrennt durch Leerzeilen
  let combined = '';
  const segments = [];
  for (const k of keys) {
    const text = texts[k].normalize('NFC');
    if (combined.length + text.length > MAX_TOTAL) break;
    if (combined) combined += '\n\n';
    segments.push({ key: k, start: combined.length, end: combined.length + text.length, text });
    combined += text;
  }

  let matches;
  try {
    const params = new URLSearchParams({ text: combined, language: style.language, level: 'default' });
    if (style.preferredVariants) params.set('preferredVariants', style.preferredVariants);
    const disabled = ['TYPOGRAPHY', 'STYLE', 'REDUNDANCY', 'COLLOQUIALISMS', 'SEMANTICS', 'MISC'];
    if (style.lowercase) disabled.push('CASING');
    params.set('disabledCategories', disabled.join(','));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    const r = await fetch(LT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'nena-network-upload' },
      body: params.toString(),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`LanguageTool ${r.status}`);
    matches = (await r.json()).matches || [];
  } catch (e) {
    console.error('upload-spellcheck', e.message);
    out.unavailable = true; // Seite macht dann nur die Stil-Regeln (klein, ss)
    return send(res, 200, out);
  }

  let dict = new Set();
  if (redisConfigured()) {
    try { dict = new Set((await pipeline([['SMEMBERS', dictKey(artist)]]))[0] || []); } catch (e) { /* ohne Woerterbuch */ }
  }

  for (const m of matches) {
    const seg = segments.find((s) => m.offset >= s.start && m.offset + m.length <= s.end);
    if (!seg) continue;
    const from = combined.slice(m.offset, m.offset + m.length);
    const reps = (m.replacements || []).map((r) => r.value).filter((v) => typeof v === 'string');
    if (!reps.length) continue;                         // unbekanntes Wort ohne Vorschlag (Namen, Orte): lassen
    if (dict.has(from.toLowerCase())) continue;          // vom Kuenstler gemerkt
    let to;
    if (style.lowercase) {
      // Nur Gross/Klein anders ("fenster" -> "Fenster") = bei diesem Stil richtig
      if (reps.some((v) => v.toLowerCase() === from.toLowerCase())) continue;
      to = reps[0].toLowerCase();
    } else {
      to = reps[0];
    }
    if (to === from) continue;
    out.texts[seg.key].changes.push({
      offset: m.offset - seg.start,
      length: m.length,
      from,
      to,
      message: String((m.shortMessage || m.message || '')).slice(0, 140),
      kind: KIND[m.rule && m.rule.category && m.rule.category.id] || 'other'
    });
  }

  return send(res, 200, out);
};

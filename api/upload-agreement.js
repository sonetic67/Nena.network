// /api/upload-agreement   (nur angemeldet)
//   GET  -> { version, required, accepted: { name, version, at } | null, all?: [...] }
//           all: nur fuer den Betreiber - wer hat wann welcher Fassung zugestimmt
//   POST Body: { version: "2026-11-24", name: "Vorname Nachname", accept: true }
//        -> Zustimmung zur Vereinbarung ueber die Veroeffentlichung (Name gilt als Unterschrift)
// Gespeichert werden nur Name, Datum und Fassung (Upstash), keine IP.
const {
  send, currentArtist, sameOrigin, setupStatus, AGREEMENT_VERSION, getAgreement, getAgreements, saveAgreement,
  isAdmin, cleanSignature
} = require('./_upload');
const { readBody } = require('./_redis');

module.exports = async function handler(req, res) {
  const artist = currentArtist(req);
  if (!artist) return send(res, 401, { error: 'Bitte anmelden' });

  try {
    if (req.method === 'GET') {
      const own = await getAgreement(artist);
      const out = {
        version: AGREEMENT_VERSION,
        required: !isAdmin(artist),
        accepted: own && own.version === AGREEMENT_VERSION ? own : null,
        previous: own && own.version !== AGREEMENT_VERSION ? own : null
      };
      if (isAdmin(artist)) {
        const codes = setupStatus().artists.filter((a) => !isAdmin(a));
        const records = await getAgreements(codes);
        out.all = codes.map((a) => ({ artist: a, record: records[a] }));
      }
      return send(res, 200, out);
    }

    if (req.method !== 'POST') return send(res, 405, { error: 'GET oder POST' });
    if (!sameOrigin(req)) return send(res, 403, { error: 'Nur von der eigenen Seite' });

    const { version, name, accept } = readBody(req);
    if (version !== AGREEMENT_VERSION) return send(res, 409, { error: 'Die Vereinbarung wurde geändert. Bitte Seite neu laden.' });
    if (accept !== true) return send(res, 400, { error: 'Bitte bestätigen, dass du einverstanden bist' });
    const signature = cleanSignature(name);
    if (!signature) return send(res, 400, { error: 'Bitte Vor- und Nachnamen eingeben' });

    const record = await saveAgreement(artist, signature);
    return send(res, 200, { accepted: record });
  } catch (e) {
    console.error('upload-agreement', e.message);
    return send(res, 500, { error: 'Datenbankfehler' });
  }
};

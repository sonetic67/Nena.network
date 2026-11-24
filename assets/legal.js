// Impressum und Datenschutz: Sprache waehlen (Adresse /privacy oder /imprint = Englisch,
// /datenschutz oder /impressum = Deutsch, sonst Browsersprache) und Umschalter DE / EN.
(() => {
    const path = location.pathname.toLowerCase();
    let lang;
    if (/\/(privacy|imprint)\b/.test(path)) lang = 'en';
    else if (/\/(datenschutz|impressum)\b/.test(path)) lang = 'de';
    else {
        const first = (navigator.languages && navigator.languages[0]) || navigator.language || 'en';
        lang = /^de\b/i.test(first) ? 'de' : 'en';
    }
    const titles = {
        de: document.documentElement.dataset.titleDe,
        en: document.documentElement.dataset.titleEn
    };
    const set = (l) => {
        document.documentElement.dataset.lang = l;
        document.documentElement.lang = l;
        if (titles[l]) document.title = titles[l];
        document.querySelectorAll('.langs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === l)));
    };
    set(lang);
    document.querySelectorAll('.langs button').forEach((b) => b.addEventListener('click', () => set(b.dataset.lang)));

    // Sicherung: solange Name oder E-Mail noch Platzhalter sind, gut sichtbar warnen
    if (/\[\[[A-Z-]+\]\]/.test(document.body.textContent)) {
        const banner = document.createElement('div');
        banner.className = 'todo-banner';
        banner.textContent = 'Noch nicht fertig: Kontaktangaben fehlen. / Not finished: contact details missing.';
        document.body.prepend(banner);
    }
    // Leere Adresszeilen ausblenden
    document.querySelectorAll('[data-optional]').forEach((el) => { if (!el.textContent.trim()) el.hidden = true; });
})();

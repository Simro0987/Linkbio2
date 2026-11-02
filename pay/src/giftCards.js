'use strict';
/**
 * 🎁 Darčekové karty (gift cards) – admin-editable list (add / remove / reorder / name, logo, buy link, enabled).
 * Shown in the „Poukážky / darčekové karty“ group as gc_* methods; the customer opens /giftcard/<id>
 * (buy link + guide + secure code form → Telegram to Ryan), same flow as PaysafeCard / G2A.
 * Existing PaysafeCard and G2A entries stay as they were (built-ins).
 * Seed buy links were checked to load (HTTP 200) on 2026-11-02; logos are real brand marks in /logos (see SOURCES.md).
 */
const fs = require('fs');
const path = require('path');
const store = require('./sealedStore');

const ID_RE = /^gc_[a-z0-9_]{2,40}$/;
const MAX = 60;
const LOGO_DIR = path.join(__dirname, '..', 'public', 'logos');
const SEED = [
  ['gc_amazon', 'Amazon', '/logos/amazon.svg', 'https://dundle.com/sk/amazon/'],
  ['gc_googleplay', 'Google Play', '/logos/googleplay.svg', 'https://dundle.com/sk/google-play/'],
  ['gc_apple', 'Apple Gift Card (iTunes)', '/logos/apple.svg', 'https://dundle.com/sk/itunes/'],
  ['gc_steam', 'Steam', '/logos/steam.svg', 'https://dundle.com/sk/steam/'],
  ['gc_xbox', 'Xbox', '/logos/xbox.svg', 'https://dundle.com/sk/xbox/'],
  ['gc_playstation', 'PlayStation (PSN)', '/logos/playstation.svg', 'https://dundle.com/sk/playstation/'],
  ['gc_netflix', 'Netflix', '/logos/netflix.svg', 'https://dundle.com/sk/netflix/'],
  ['gc_spotify', 'Spotify', '/logos/spotify.svg', 'https://dundle.com/sk/spotify/'],
  ['gc_binance', 'Binance Gift Card', '/logos/binance.svg', 'https://www.binance.com/sk/gift-card'],
  ['gc_bitrefill', 'Bitrefill', '/logos/bitrefill.svg', 'https://www.bitrefill.com/sk/en/'],
  ['gc_neosurf', 'Neosurf', '/logos/neosurf.png', 'https://dundle.com/sk/neosurf/'],
  ['gc_cashtocode', 'CashToCode', '/logos/cashtocode.png', 'https://dundle.com/sk/cashtocode/'],
  ['gc_razergold', 'Razer Gold', '/logos/razer.svg', 'https://dundle.com/sk/razer-gold/'],
].map(([id, name, logo, url]) => ({ id, name, logo, url, enabled: true, note: '' }));

let log = () => {};
const cfg = store.create('gift-cards', { cards: null });
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

function list() { const c = cfg.get().cards; return Array.isArray(c) ? c : SEED.map((x) => ({ ...x })); }
function enabled() { return list().filter((c) => c.enabled !== false && c.url); }
function get(id) { return list().find((c) => c.id === String(id || '').toLowerCase()) || null; }
function logoLibrary() {
  try { return fs.readdirSync(LOGO_DIR).filter((f) => /\.(svg|png|webp|jpg)$/i.test(f)).sort().map((f) => '/logos/' + f); } catch { return []; }
}
function validLogo(v) { return /^\/logos\/[a-z0-9._-]{1,60}\.(svg|png|webp|jpg)$/i.test(v) || /^\/pm-logo\/[a-z0-9_-]{1,80}$/i.test(v); }
function validUrl(v) { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && v.length <= 500; } catch { return false; } }
function slug(name) { return 'gc_' + String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '').slice(0, 30); }

/** Provider items for the customer list (vouchers group). */
function items() {
  return enabled().map((c) => ({
    id: c.id, providerId: c.id, provider_name: c.name, method_label: c.name, status: 'active', group: 'vouchers', gateway: 'giftcard',
    configured: true, soon: false, unavailableLabel: null, preferred: false, giftcard: true,
    hint: c.note || `Darčeková karta ${c.name} – kúpte kartu a pošlite kód cez bezpečný formulár.`, minimum_amount: 1, minimum_currency: 'EUR',
    logos: [c.logo || '/logos/generic-voucher.svg'],
  }));
}
/** Add the enabled cards to the grouped provider payload (respects admin disable of a card; no duplicates). */
function inject(res) {
  if (!res || !res.groups) return res;
  const its = items(); if (!its.length) return res;
  if (!res.groups.vouchers) res.groups.vouchers = { label: 'Poukážky / darčekové karty', color: '#f59e0b', providers: [], soon: [] };
  const g = res.groups.vouchers; const have = new Set(g.providers.map((x) => x.id));
  for (const it of its) if (!have.has(it.id)) { g.providers.push(it); (res.providers || (res.providers = [])).push(it); }
  return res;
}

async function saveList(cards) { await cfg.save({ cards }); log(`GIFTCARDS_SAVED n=${cards.length}`); return cards; }
function adminView() { return { ok: true, cards: list(), logos: logoLibrary(), seeded: !Array.isArray(cfg.get().cards) }; }

function mount(app, deps = {}) {
  log = deps.appendLog || log;
  const ACTIONS = {
    gc_list: async () => adminView(),
    gc_save: async (b) => {
      const cards = list().map((x) => ({ ...x }));
      const name = clip(b.name, 60); const url = clip(b.url, 500); const logo = clip(b.logo, 120) || '/logos/generic-voucher.svg'; const note = clip(b.note, 200);
      if (!name) return { ok: false, status: 400, error: 'Zadajte názov karty.' };
      if (!validUrl(url)) return { ok: false, status: 400, error: 'Odkaz na kúpu musí byť platná https:// adresa.' };
      if (!validLogo(logo)) return { ok: false, status: 400, error: 'Logo vyberte z knižnice log (/logos/…) alebo nahrané logo (/pm-logo/…).' };
      const en = String(b.enabled || '') === '1';
      let id = String(b.id || '').toLowerCase();
      if (id) {
        const c = cards.find((x) => x.id === id); if (!c) return { ok: false, status: 404, error: 'Karta sa nenašla.' };
        Object.assign(c, { name, url, logo, note, enabled: en });
      } else {
        if (cards.length >= MAX) return { ok: false, status: 400, error: `Najviac ${MAX} kariet.` };
        id = slug(name); if (!ID_RE.test(id)) id = 'gc_karta';
        let n = id, i = 2; while (cards.some((x) => x.id === n)) n = id + '_' + i++;
        cards.push({ id: n, name, url, logo, note, enabled: en }); id = n;
      }
      await saveList(cards); return { ...adminView(), id };
    },
    gc_delete: async (b) => {
      const id = String(b.id || '').toLowerCase(); const cards = list().filter((x) => x.id !== id);
      if (cards.length === list().length) return { ok: false, status: 404, error: 'Karta sa nenašla.' };
      await saveList(cards); return adminView();
    },
    gc_move: async (b) => {
      const id = String(b.id || '').toLowerCase(); const cards = list().map((x) => ({ ...x }));
      const i = cards.findIndex((x) => x.id === id); if (i < 0) return { ok: false, status: 404, error: 'Karta sa nenašla.' };
      const j = String(b.dir) === 'up' ? i - 1 : i + 1; if (j < 0 || j >= cards.length) return adminView();
      [cards[i], cards[j]] = [cards[j], cards[i]]; await saveList(cards); return adminView();
    },
    gc_toggle: async (b) => {
      const id = String(b.id || '').toLowerCase(); const cards = list().map((x) => ({ ...x }));
      const c = cards.find((x) => x.id === id); if (!c) return { ok: false, status: 404, error: 'Karta sa nenašla.' };
      c.enabled = c.enabled === false; await saveList(cards); return adminView();
    },
    gc_reset: async () => { await cfg.save({ cards: null }); log('GIFTCARDS_RESET'); return adminView(); },
  };
  require('./payMethods').serveSigned(app, '/api/admin-bridge/giftcards', ACTIONS, 'GIFTCARDS');
}
async function init(appendLog) { if (appendLog) log = appendLog; await cfg.load(); }

module.exports = { SEED, list, enabled, get, items, inject, mount, init, logoLibrary, _validUrl: validUrl, _validLogo: validLogo, _set: (c) => cfg.set(c) };

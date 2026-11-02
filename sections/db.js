'use strict';
// site_sections storage: schema migration, 30 s cache, one-time seed of home blocks in the current live order.
const crypto = require('crypto');
const { KINDS } = require('./types');

module.exports = function db(ctx) {
  const { pool, getSettings, setSettings } = ctx;
  let cache = null;
  const COLS = 'id,pos,slug,title,title_en,icon,kind,body,body_en,videos,visible,in_nav,img_ver,updated_at,place,cfg';
  const all = async () => {
    if (cache && cache.t > Date.now() - 30000) return cache.rows;
    const r = await pool.query(`SELECT ${COLS},(SELECT COALESCE(json_agg(json_build_object('id',g.id,'alt',g.alt,'ver',g.ver) ORDER BY g.pos,g.id),'[]') FROM site_section_imgs g WHERE g.sec_id=s.id) AS gal FROM site_sections s ORDER BY pos,id`);
    cache = { t: Date.now(), rows: r.rows }; return r.rows;
  };
  const drop = () => { cache = null; };
  const pages = async () => (await all()).filter((x) => x.place !== 'home');
  const home = async () => (await all()).filter((x) => x.place === 'home');
  const autoSlug = (kind) => `h-${kind}-${crypto.randomBytes(4).toString('hex')}`;

  async function migrate() {
    await pool.query(`CREATE TABLE IF NOT EXISTS site_sections (
      id serial PRIMARY KEY, pos int NOT NULL DEFAULT 0, slug text UNIQUE NOT NULL, title text NOT NULL, title_en text NOT NULL DEFAULT '', icon text NOT NULL DEFAULT '',
      kind text NOT NULL DEFAULT 'text', body text NOT NULL DEFAULT '', body_en text NOT NULL DEFAULT '', body_raw text NOT NULL DEFAULT '', body_en_raw text NOT NULL DEFAULT '',
      videos jsonb NOT NULL DEFAULT '[]'::jsonb, visible boolean NOT NULL DEFAULT true, in_nav boolean NOT NULL DEFAULT true,
      img_mime text, img_data bytea, img_ver text, updated_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`ALTER TABLE site_sections ADD COLUMN IF NOT EXISTS place text NOT NULL DEFAULT 'page'`);
    await pool.query(`ALTER TABLE site_sections ADD COLUMN IF NOT EXISTS cfg jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await pool.query(`CREATE TABLE IF NOT EXISTS site_section_imgs (id serial PRIMARY KEY, sec_id int NOT NULL REFERENCES site_sections(id) ON DELETE CASCADE, pos int NOT NULL DEFAULT 0, alt text NOT NULL DEFAULT '', mime text NOT NULL, data bytea NOT NULL, ver text NOT NULL)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS site_section_imgs_sec ON site_section_imgs(sec_id)`);
    await seed();
  }

  // Seed = exactly what the home page shows today, so nothing changes visually until the admin edits it.
  async function seed() {
    const s = await getSettings();
    if (s.sec_home_seeded === '1') return;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('LOCK TABLE site_sections IN SHARE ROW EXCLUSIVE MODE');
      const has = await c.query(`SELECT 1 FROM site_sections WHERE place='home' LIMIT 1`);
      if (!has.rowCount) {
        const rows = [
          ['banner', 1], ['evhero', 1], ['hero', 1], ['events', 1], ['dnes', 1], ['buttons', 1], ['social', 1, 'Sociálne siete (ikony)', { grp: 'all', style: 'icons' }],
          ['pricing', s.cen_home !== '0', 'Cenník', { why: 1, notes: 1, intro: 1, plans: [] }],
          ['channels', 0, 'Kanály', { status: 1, limit: 20 }], ['social', 0, 'Kontakty – Skupiny / Priame', { grp: 'all', style: 'groups' }],
          ['payments', 0, 'Platobné metódy', { methods: [], btn: 1 }], ['auth', 0], ['why', 0], ['affiliate', 0], ['subcheck', 0],
          ['chat', s.chat_enabled !== '0'],
        ];
        let pos = 1;
        for (const [kind, vis, title, cfg] of rows) {
          await c.query(`INSERT INTO site_sections (slug,title,icon,kind,place,cfg,visible,in_nav,pos) VALUES ($1,$2,$3,$4,'home',$5::jsonb,$6,false,$7)`,
            [autoSlug(kind), title || KINDS[kind].l, KINDS[kind].i, kind, JSON.stringify(Object.assign({ seed: 1 }, cfg || {})), !!vis, pos++]);
        }
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    await setSettings({ sec_home_seeded: '1' }); drop();
  }

  // Rewrite pos for one place in the given id order (ids of other places untouched).
  async function setOrder(place, order) {
    const rows = (await all()).filter((x) => (place === 'home' ? x.place === 'home' : x.place !== 'home'));
    const known = rows.map((x) => x.id), want = order.map(Number).filter((id, i, a) => known.includes(id) && a.indexOf(id) === i);
    const fin = want.concat(known.filter((id) => !want.includes(id)));
    const c = await pool.connect();
    try { await c.query('BEGIN'); for (let k = 0; k < fin.length; k++) await c.query(`UPDATE site_sections SET pos=$1 WHERE id=$2`, [k + 1, fin[k]]); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); drop(); }
  }
  async function insert({ slug, title, icon, kind, place, cfg, visible, in_nav, after }) {
    const r = await pool.query(`INSERT INTO site_sections (slug,title,icon,kind,place,cfg,visible,in_nav,pos) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,(SELECT COALESCE(MAX(pos),0)+1 FROM site_sections)) ON CONFLICT (slug) DO NOTHING RETURNING id`,
      [slug || autoSlug(kind), title, icon, kind, place, JSON.stringify(cfg || {}), visible !== false, !!in_nav]);
    drop(); if (!r.rowCount) return null;
    const id = r.rows[0].id;
    if (after !== undefined && after !== 'end') {
      const ord = (await all()).filter((x) => (place === 'home' ? x.place === 'home' : x.place !== 'home')).map((x) => x.id).filter((x) => x !== id);
      const i = after === 'start' ? 0 : ord.indexOf(Number(after)) + 1;
      if (after === 'start' || i > 0) { ord.splice(i, 0, id); await setOrder(place, ord); }
    }
    return id;
  }
  return Object.assign(ctx, { secAll: all, secDrop: drop, secPages: pages, secHome: home, secMigrate: migrate, secSetOrder: setOrder, secInsert: insert, secAutoSlug: autoSlug, sectionsDrop: drop });
};

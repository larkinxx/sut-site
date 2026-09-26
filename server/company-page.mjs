// Страницы компаний для поисковиков: fin-check.shop/organizacii/<ИНН>/ и карта сайта со всеми организациями.
// Страница собирается на сервере из шаблона сайта (dist/organizacii/index.html) и бесплатных данных:
// открытых данных ФНС (fns.db: название, режим, численность, налоги, долги) и DaData, если есть в кеше или
// не исчерпан дневной лимит. Для человека страница затем сама запускает полную проверку (суды, учредители и т. д.).
import fs from 'node:fs';
import path from 'node:path';
import { ogSvg, ogFacts, svgToPng } from './og-image.mjs';

const PER_SITEMAP = 50000;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = { ACTIVE: 'Действует', LIQUIDATING: 'Ликвидируется', LIQUIDATED: 'Ликвидирована', BANKRUPT: 'Банкротство', REORGANIZING: 'Реорганизация' };
const dateRu = (ms) => new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
export function money(n) {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n), sign = n < 0 ? '−' : '';
  if (a >= 1e9) return sign + (a / 1e9).toFixed(1).replace('.', ',') + ' млрд ₽';
  if (a >= 1e6) return sign + (a / 1e6).toFixed(1).replace('.', ',') + ' млн ₽';
  if (a >= 1e3) return sign + Math.round(a / 1e3) + ' тыс. ₽';
  return sign + Math.round(a) + ' ₽';
}
// «ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "РОМАШКА"» → «ООО "РОМАШКА"»
export function shortName(n) {
  return String(n || '').replace(/^ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ/i, 'ООО').replace(/^НЕПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО/i, 'АО')
    .replace(/^ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО/i, 'ПАО').replace(/^АКЦИОНЕРНОЕ ОБЩЕСТВО/i, 'АО').replace(/\s+/g, ' ').trim();
}

// Данные из fns.db одним объектом (или null, если компании там нет)
export function fnsRow(db, inn) {
  if (!db) return null;
  const q = (t) => { try { return db.prepare(`SELECT * FROM ${t} WHERE inn = ?`).get(inn); } catch { return undefined; } };
  const name = q('fns_name'), r = q('fns_regime'), st = q('fns_staff'), tx = q('fns_tax'), dt = q('fns_debt');
  if (!name && !r && !st && !tx && !dt) return null;
  const regime = r ? [['usn', 'УСН'], ['ausn', 'АУСН'], ['eshn', 'ЕСХН'], ['srp', 'СРП']].filter(([k]) => r[k]).map(([, n]) => n) : [];
  return {
    name: name ? shortName(name.name) : null,
    regime: regime.length ? regime.join(', ') : 'общая система',
    staff: st ? { n: st.n, year: Number(String(st.asof).slice(0, 4)) } : null,
    tax: tx ? { total: tx.total, year: Number(String(tx.asof).slice(0, 4)), items: JSON.parse(tx.items || '[]').slice(0, 5) } : null,
    debt: dt ? dt.total : 0
  };
}

// Собираем страницу из шаблона сайта: заголовок, описание, канонический адрес, краткая сводка и JSON-LD
export function renderCompany(tpl, { inn, siteUrl, f, party, more = null }) {
  const d = (party && party.data) || {};
  const name = (d.name && d.name.short_with_opf) || (f && f.name) || `Организация ИНН ${inn}`;
  const url = `${siteUrl}/organizacii/${inn}/`;
  const st = d.state || {};
  const facts = [
    ['ИНН', inn], ['ОГРН', d.ogrn], ['КПП', d.kpp],
    ['Статус', STATUS[st.status] || null],
    ['Зарегистрирована', st.registration_date ? dateRu(st.registration_date) : null],
    ['Адрес', d.address && d.address.value],
    ['Основной вид деятельности', d.okved],
    ['Налоговый режим', f && f.regime],
    ['Сотрудников', f && f.staff ? `${f.staff.n} в ${f.staff.year} году` : null],
    ['Уплачено налогов и взносов', f && f.tax ? `${money(f.tax.total)} за ${f.tax.year} год` : null],
    ['Налоговая задолженность', f ? (f.debt > 0 ? money(f.debt) : 'нет') : null]
  ].filter(([, v]) => v);
  const descParts = [`${name}: ИНН ${inn}`, d.ogrn ? `ОГРН ${d.ogrn}` : '', d.address ? d.address.value : '',
    f && f.tax ? `налоги за ${f.tax.year} год — ${money(f.tax.total)}` : '', f && f.staff ? `сотрудников: ${f.staff.n}` : '',
    more && more.arbitration ? `арбитражных дел: ${more.arbitration.total}` : '', more && more.card ? (more.card.flags.length ? `отметок в реестрах: ${more.card.flags.length}` : 'отметок в реестрах нет') : ''].filter(Boolean);
  const desc = (descParts.join(', ') + '. Суды, арбитраж, учредители, финансы и советы — бесплатная проверка.').slice(0, 300);
  const title = `${name} — ИНН ${inn}: проверка, налоги, суды`;
  const ld = { '@context': 'https://schema.org', '@type': 'Organization', name, taxID: inn, url,
    ...(d.address ? { address: d.address.value } : {}), ...(st.registration_date ? { foundingDate: new Date(st.registration_date).toISOString().slice(0, 10) } : {}) };
  const summary = `<section class="dcard ssr-card"><h2>${esc(name)}</h2>
<div class="result cols">${facts.map(([k, v]) => `<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')}</div>
${f && f.tax && f.tax.items.length ? `<p class="fns-sub">Крупнейшие налоги за ${f.tax.year} год</p><ul>${f.tax.items.map((x) => `<li>${esc(x.name)}: ${esc(money(x.sum))}</li>`).join('')}</ul>` : ''}
<p class="note-sm">Сведения из открытых данных ФНС${party ? ' и ЕГРЮЛ' : ''}. Суды, арбитраж, приставы, учредители, отчётность и советы загружаются ниже.</p></section>`;

  let h = tpl
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)} — Суть</title>`)
    .replace(/(<meta name="description" content=")[^"]*"/, `$1${esc(desc)}"`)
    .replace(/(<meta property="og:description" content=")[^"]*"/, `$1${esc(desc)}"`)
    .replace(/(<meta property="og:title" content=")[^"]*"/, `$1${esc(title)}"`)
    .replace(/(<link rel="canonical" href=")[^"]*"/, `$1${esc(url)}"`)
    .replace(/(<meta property="og:url" content=")[^"]*"/, `$1${esc(url)}"`)
    .replace(/(<meta property="og:image" content=")[^"]*"/, `$1${esc(url)}og.png"`)
    .replace(/<!--ssr:intro-->[\s\S]*?<!--\/ssr:intro-->/, `<h1 class="page">${esc(name)}</h1><p class="lede">Проверка по ИНН ${esc(inn)}: реквизиты, налоги, суды и учредители. Проверить другую организацию можно в форме ниже.</p>`)
    .replace('<div id="org-out" aria-live="polite"></div>', `<div id="org-out" aria-live="polite" class="dash">${summary}</div>`)
    .replace('<section class="calc" id="org"', `<section class="calc" id="org" data-inn="${esc(inn)}"`)
    .replace('</head>', `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>\n</head>`);
  return h;
}

export function createCompanyPages({ env, fdb, getParty, cachedParty, getMore = () => null, toPng = svgToPng, now = () => Date.now() }) {
  const dist = env.SITE_DIST || '/var/www/fin-check.shop';
  const siteUrl = (env.SITE_URL || 'https://fin-check.shop').replace(/\/$/, '');
  const dadataDaily = Number(env.SSR_DADATA_DAILY || 2000);   // DaData на бесплатном тарифе — 10 000 запросов в сутки на всё
  let tpl = null, tplMtime = 0, day = { key: '', n: 0 };
  let sitemapCount = null, sitemapAt = 0;
  const ogCache = new Map();   // ИНН+содержимое → PNG, не больше 500 штук
  const template = () => {
    const file = path.join(dist, 'organizacii', 'index.html');
    const m = fs.statSync(file).mtimeMs;
    if (!tpl || m !== tplMtime) { tpl = fs.readFileSync(file, 'utf8'); tplMtime = m; }
    return tpl;
  };
  const html = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': code === 200 ? 'public, max-age=3600' : 'no-store' }); res.end(body); };
  const xml = (res, body) => { res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' }); res.end(body); };

  // список ИНН для карты сайта — компании, которые платили налоги (действующие), с названием
  const count = () => {
    if (sitemapCount == null || now() - sitemapAt > 864e5) {
      try { sitemapCount = fdb.prepare('SELECT COUNT(*) AS n FROM fns_tax t JOIN fns_name n ON n.inn = t.inn').get().n; } catch { sitemapCount = 0; }
      sitemapAt = now();
    }
    return sitemapCount;
  };

  return async function handle(req, res, url, innValid) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const p = url.pathname;
    if (!/^\/(organizacii\/\d|sitemap-companies)/.test(p)) return false;
    if (!fs.existsSync(path.join(dist, 'organizacii', 'index.html'))) return false;   // сайт ещё не собран на этом сервере
    // картинка-превью для мессенджеров
    let m = /^\/organizacii\/(\d{10}|\d{12})\/og\.png$/.exec(p);
    if (m) {
      const inn = m[1];
      if (!innValid(inn)) { res.writeHead(404); res.end(); return true; }
      const f = fnsRow(fdb, inn), party = cachedParty(inn) || null, more = getMore(inn);
      const d = (party && party.data) || {};
      const name = (d.name && d.name.short_with_opf) || (f && f.name) || `Организация ИНН ${inn}`;
      const st = d.state && d.state.status;
      const svg = ogSvg({ name, inn, status: STATUS[st] || null, active: st === 'ACTIVE', facts: ogFacts(f, more, money) });
      const key = inn + ':' + svg.length + ':' + svg.slice(-400);
      let png = ogCache.get(key);
      if (!png) {
        try { png = await toPng(svg); } catch (e) { res.writeHead(302, { Location: '/og.png' }); res.end(); return true; }
        if (ogCache.size >= 500) ogCache.delete(ogCache.keys().next().value);
        ogCache.set(key, png);
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(png);
      return true;
    }
    m = /^\/organizacii\/(\d{10}|\d{12})\/?$/.exec(p);
    if (m) {
      const inn = m[1];
      if (!p.endsWith('/')) { res.writeHead(301, { Location: `/organizacii/${inn}/` }); res.end(); return true; }
      if (!innValid(inn)) { html(res, 404, template().replace('</head>', '<meta name="robots" content="noindex">\n</head>')); return true; }
      const f = fnsRow(fdb, inn);
      let party = cachedParty(inn);
      if (party === undefined) {
        const key = new Date(now()).toISOString().slice(0, 10);
        if (day.key !== key) day = { key, n: 0 };
        if (day.n < dadataDaily) { day.n++; party = await getParty(inn).catch(() => null); } else party = null;
      }
      if (!f && !party) { html(res, 404, renderCompany(template(), { inn, siteUrl, f: null, party: null }).replace('</head>', '<meta name="robots" content="noindex">\n</head>')); return true; }
      html(res, 200, renderCompany(template(), { inn, siteUrl, f, party, more: getMore(inn) }));
      return true;
    }
    if (p === '/sitemap-companies.xml') {
      const files = Math.ceil(count() / PER_SITEMAP);
      xml(res, `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${Array.from({ length: files }, (_, i) => `<sitemap><loc>${siteUrl}/sitemap-companies-${i + 1}.xml</loc></sitemap>`).join('\n')}\n</sitemapindex>\n`);
      return true;
    }
    m = /^\/sitemap-companies-(\d{1,4})\.xml$/.exec(p);
    if (m) {
      let rows = [];
      try { rows = fdb.prepare('SELECT t.inn FROM fns_tax t JOIN fns_name n ON n.inn = t.inn ORDER BY t.inn LIMIT ? OFFSET ?').all(PER_SITEMAP, (Number(m[1]) - 1) * PER_SITEMAP); } catch { rows = []; }
      xml(res, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.map((r) => `<url><loc>${siteUrl}/organizacii/${r.inn}/</loc></url>`).join('\n')}\n</urlset>\n`);
      return true;
    }
    return false;
  };
}

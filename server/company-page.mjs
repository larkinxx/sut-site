// Страницы компаний для поисковиков: <сайт>/organizacii/<ИНН>/ и карта сайта со всеми организациями.
// Страница собирается на сервере из шаблона сайта (dist/organizacii/index.html) и бесплатных данных:
// открытых данных ФНС (fns.db: название, режим, численность, налоги, долги) и DaData, если есть в кеше или
// не исчерпан дневной лимит. Для человека страница затем сама запускает полную проверку (суды, учредители и т. д.).
import fs from 'node:fs';
import path from 'node:path';
import { ogSvg, ogFacts, svgToPng } from './og-image.mjs';
import { orgPeers } from './market.mjs';

const PER_SITEMAP = 50000;
// «$» тоже экранируем: готовый HTML вставляется в шаблон через String.replace, где «$'» и «$&» — спецпоследовательности
export const esc = (s) => String(s ?? '').replace(/[&<>"'$]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', $: '&#36;' }[c]));
// Горизонтальные полосы одной величины (доля, доходы) — HTML и CSS без скриптов: читаются с телефона,
// печатаются и остаются текстом для поиска. rows: [{ label, value, text }], value ≥ 0
export function hbars(caption, rows) {
  const max = Math.max(0, ...rows.map((r) => r.value || 0)) || 1;
  return `<figure class="hbars"><figcaption>${esc(caption)}</figcaption><ol>${rows.map((r) => `<li title="${esc(r.label)}: ${esc(r.text)}"><span class="hb-l">${esc(r.label)}</span><span class="hb-b" aria-hidden="true"><i style="width:${(Math.max(0, r.value || 0) / max * 100).toFixed(1)}%"></i></span><span class="hb-v">${esc(r.text)}</span></li>`).join('')}</ol></figure>`;
}
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

// «Содержательная» страница компании — есть уплаченные налоги и хотя бы численность или бухотчётность (доходы, место
// среди похожих). Остальные открыты людям, но закрыты от индекса (noindex, follow): тысячи почти пустых страниц
// Яндекс считает малополезным контентом и понижает из-за них весь сайт
const RICH_SQL = '(EXISTS (SELECT 1 FROM fns_staff s WHERE s.inn = t.inn) OR EXISTS (SELECT 1 FROM fns_finance f WHERE f.inn = t.inn))';
export function isRich(db, inn, f) {
  if (!f || !f.tax) return false;
  if (f.staff) return true;
  try { return !!db.prepare('SELECT 1 FROM fns_finance WHERE inn = ?').get(inn); } catch { return false; }
}

// Собираем страницу из шаблона сайта: заголовок, описание, канонический адрес, краткая сводка и JSON-LD
// Компания против похожих (та же отрасль, регион и возраст) — своя строка в описании и блок на странице.
// Этого нет у справочников-конкурентов: не только цифры компании, но и где она среди своих.
const pluralRu = (n, a, b, c) => { const m = n % 100, k = n % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };
function peersHtml(pr) {
  if (!pr) return '';
  const g = pr.peers, where = pr.scope === 'region' ? 'в том же регионе' : 'по России';
  const stat = (label, pct) => (pct == null ? '' : `<div class="bigstat"><span class="bs-label">${esc(label)}</span><strong class="bs-val">выше, чем у ${pct}%</strong></div>`);
  const cells = stat(`Доходы ${money(pr.income)}`, pr.incomePercentile) + stat(`Прибыль ${money(pr.profit)}`, pr.profitPercentile);
  return `<p class="fns-sub">Среди похожих компаний</p>
<p class="note-sm">Сравнение с организациями той же отрасли (ОКВЭД ${esc(pr.okved)}) ${where}, которые работают ${esc(pr.ageLabel)}, по доходам и расходам за ${pr.year} год: ${g.withReports} ${pluralRu(g.withReports, 'компания', 'компании', 'компаний')} с отчётностью. Прибыль — доходы минус расходы до налога.</p>
${cells ? `<div class="bigstats">${cells}</div>` : ''}
<div class="result cols"><div><span>Доходы у середины</span><strong>${esc(money(g.income[2]))}</strong></div><div><span>Прибыль у середины</span><strong>${esc(money(g.profit[2]))}</strong></div><div><span>Похожих в плюсе</span><strong>${Math.round(g.profitableShare * 100)}%</strong></div></div>
<p class="note-sm"><a href="/otrasli/${encodeURIComponent(pr.okved)}/${pr.scope === 'region' ? encodeURIComponent(pr.region) + '/' : ''}">Сколько зарабатывает отрасль и крупнейшие компании</a> · <a href="/kalkulyatory/perspektivy-biznesa/#calc=prospects&amp;code=${encodeURIComponent(pr.okved)}&amp;region=${encodeURIComponent(pr.scope === 'region' ? pr.region : '00')}">Перспективы по годам работы</a></p>`;
}

// Похожие компании той же отрасли и региона с близкими доходами — перелинковка для поиска и для человека:
// «с кем ещё сравнить». Только организации из реестра МСП с отчётностью (ИП — без имён).
export function similarCompanies(db, inn, limit = 6) {
  if (!db) return [];
  try {
    const m = db.prepare('SELECT okved, region FROM fns_msp WHERE inn = ?').get(inn);
    const ok = m && (String(m.okved || '').match(/^(\d{2})/) || [])[1];
    if (!ok || !m.region) return [];
    const next = String(Number(ok) + 1).padStart(2, '0');
    const own = db.prepare('SELECT income FROM fns_finance WHERE inn = ?').get(inn);
    const order = own && own.income > 0 ? 'abs(f.income - ?)' : 'f.income DESC';
    const args = [m.region, ok, next, inn, ...(own && own.income > 0 ? [own.income] : []), limit];
    return db.prepare(`SELECT m.inn, n.name, f.income FROM fns_msp m JOIN fns_finance f ON f.inn = m.inn JOIN fns_name n ON n.inn = m.inn
                       WHERE m.region = ? AND m.okved >= ? AND m.okved < ? AND m.inn <> ? AND f.income > 0 ORDER BY ${order} LIMIT ?`).all(...args)
      .map((r) => ({ inn: r.inn, name: shortName(r.name), income: r.income, okved: ok, region: m.region }));
  } catch { return []; }
}
function similarHtml(list) {
  if (!list || !list.length) return '';
  const { okved, region } = list[0];
  return `<p class="fns-sub">Похожие компании</p>
<ul class="similar">${list.map((c) => `<li><a href="/organizacii/${c.inn}/">${esc(c.name)}</a> <span class="note-sm">${esc(money(c.income).replace(/ /g, '\u00a0'))}</span></li>`).join('')}</ul>
<p class="note-sm"><a href="/otrasli/${okved}/${region}/">Все крупные компании этой отрасли в регионе</a></p>`;
}

export function renderCompany(tpl, { inn, siteUrl, f, party, more = null, peers = null, similar = null }) {
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
    f && f.tax ? `налоги за ${f.tax.year} год — ${money(f.tax.total)}` : '',
    peers && peers.incomePercentile != null ? `доходы выше, чем у ${peers.incomePercentile}% похожих компаний` : '', f && f.staff ? `сотрудников: ${f.staff.n}` : '',
    more && more.arbitration ? `арбитражных дел: ${more.arbitration.total}` : '', more && more.card ? (more.card.flags.length ? `отметок в реестрах: ${more.card.flags.length}` : 'отметок в реестрах нет') : ''].filter(Boolean);
  const desc = (descParts.join(', ') + '. Суды, арбитраж, учредители, финансы и советы — бесплатная проверка.').slice(0, 300);
  const title = `${name} — ИНН ${inn}: проверка, налоги, суды`;
  const ld = { '@context': 'https://schema.org', '@type': 'Organization', name, taxID: inn, url,
    ...(d.address ? { address: d.address.value } : {}), ...(st.registration_date ? { foundingDate: new Date(st.registration_date).toISOString().slice(0, 10) } : {}),
    ...(d.ogrn ? { identifier: { '@type': 'PropertyValue', propertyID: 'ОГРН', value: d.ogrn } } : {}),
    ...(f && f.staff ? { numberOfEmployees: { '@type': 'QuantitativeValue', value: f.staff.n } } : {}) };
  const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Проверка организаций', item: `${siteUrl}/organizacii/` },
    { '@type': 'ListItem', position: 2, name, item: url }] };
  const summary = `<section class="dcard ssr-card"><h2>${esc(name)}</h2>
<div class="result cols">${facts.map(([k, v]) => `<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')}</div>
${peersHtml(peers)}
${similarHtml(similar)}
${f && f.tax && f.tax.items.length ? `<p class="fns-sub">Крупнейшие налоги за ${f.tax.year} год</p><ul>${f.tax.items.map((x) => `<li>${esc(x.name)}: ${esc(money(x.sum))}</li>`).join('')}</ul>` : ''}
${inn.length === 10 ? `<p class="note-sm"><a href="/sravnenie/#a=${esc(inn)}">Сравнить с другой компанией</a> · <a href="/prognoz/#inn=${esc(inn)}">Прогноз на три года</a></p>` : ''}
<p class="note-sm">Сведения из открытых данных ФНС${party ? ' и ЕГРЮЛ' : ''}. Суды, арбитраж, приставы, учредители, отчётность и советы загружаются ниже.</p></section>`;

  let h = tpl
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)} — INNSIDER</title>`)
    .replace(/(<meta name="description" content=")[^"]*"/, `$1${esc(desc)}"`)
    .replace(/(<meta property="og:description" content=")[^"]*"/, `$1${esc(desc)}"`)
    .replace(/(<meta property="og:title" content=")[^"]*"/, `$1${esc(title)}"`)
    .replace(/(<link rel="canonical" href=")[^"]*"/, `$1${esc(url)}"`)
    .replace(/(<meta property="og:url" content=")[^"]*"/, `$1${esc(url)}"`)
    .replace(/(<meta property="og:image" content=")[^"]*"/, `$1${esc(url)}og.png"`)
    .replace(/<!--ssr:intro-->[\s\S]*?<!--\/ssr:intro-->/, `<h1 class="page">${esc(name)}</h1><p class="lede">Проверка по ИНН ${esc(inn)}: реквизиты, налоги, суды и учредители. Проверить другую организацию можно в форме ниже.</p>`)
    .replace('<div id="org-out" aria-live="polite"></div>', `<div id="org-out" aria-live="polite" class="dash">${summary}</div>`)
    .replace('<section class="calc" id="org"', `<section class="calc" id="org" data-inn="${esc(inn)}"`)
    .replace('</head>', [ld, crumbs].map((x) => `<script type="application/ld+json">${JSON.stringify(x).replace(/</g, '\\u003c').replace(/\$/g, '\\u0024')}</script>\n`).join('') + '</head>');
  return h;
}

export function createCompanyPages({ env, fdb, getParty, cachedParty, getMore = () => null, toPng = svgToPng, now = () => Date.now() }) {
  const dist = env.SITE_DIST || '/var/www/fin-check.shop';
  const siteUrl = (env.SITE_URL || 'https://inn-sider.ru').replace(/\/$/, '');
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

  // карта сайта — только «содержательные» компании (см. richSql): уплаченные налоги, название и численность или отчётность.
  // Файлы режем по rowid таблицы налогов (по 50 000 строк на файл) — без OFFSET по миллионам строк; после фильтра
  // в файле меньше адресов, это нормально
  const count = () => {
    if (sitemapCount == null || now() - sitemapAt > 864e5) {
      try { sitemapCount = fdb.prepare('SELECT max(rowid) AS n FROM fns_tax').get().n || 0; } catch { sitemapCount = 0; }
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
      const svg = ogSvg({ name, inn, status: STATUS[st] || null, active: st === 'ACTIVE', facts: ogFacts(f, more, money), host: new URL(siteUrl).host });
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
      let party = cachedParty(inn), unsure = false;   // unsure — DaData не спросили (лимит) или она не ответила
      // компания есть в базе ФНС — страница строится из неё, без DaData: страницы в основном открывают роботы поисковиков,
      // и они не должны расходовать дневной лимит, нужный людям для проверки. Статус и адрес человек увидит, нажав «Проверить»
      if (party === undefined && f) party = null;
      if (party === undefined) {
        const key = new Date(now()).toISOString().slice(0, 10);
        if (day.key !== key) day = { key, n: 0 };
        if (day.n < dadataDaily) { day.n++; try { party = await getParty(inn); } catch { party = null; unsure = true; } } else { party = null; unsure = true; }
      }
      if (!f && !party) {
        // 404 — только когда реестр точно ответил «нет». При лимите или сбое — 503: поисковик зайдёт позже и не выкинет страницу из индекса
        const page = renderCompany(template(), { inn, siteUrl, f: null, party: null }).replace('</head>', '<meta name="robots" content="noindex">\n</head>');
        if (unsure) res.setHeader('Retry-After', '3600');
        html(res, unsure ? 503 : 404, page);
        return true;
      }
      let peers = null;
      try { peers = orgPeers(fdb, inn); } catch { peers = null; }
      let page = renderCompany(template(), { inn, siteUrl, f, party, more: getMore(inn), peers, similar: similarCompanies(fdb, inn) });
      if (f && !isRich(fdb, inn, f)) page = page.replace('</head>', '<meta name="robots" content="noindex, follow">\n</head>');
      html(res, 200, page);
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
      const k = Number(m[1]);
      try { rows = fdb.prepare(`SELECT t.inn FROM fns_tax t JOIN fns_name n ON n.inn = t.inn WHERE t.rowid > ? AND t.rowid <= ? AND ${RICH_SQL} ORDER BY t.rowid`).all((k - 1) * PER_SITEMAP, k * PER_SITEMAP); } catch { rows = []; }
      xml(res, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.map((r) => `<url><loc>${siteUrl}/organizacii/${r.inn}/</loc></url>`).join('\n')}\n</urlset>\n`);
      return true;
    }
    return false;
  };
}

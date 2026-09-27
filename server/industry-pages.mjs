// Страницы отраслей для поисковиков: <сайт>/otrasli/ — список, /otrasli/<ОКВЭД>/ — вся Россия, /otrasli/<ОКВЭД>/<регион>/.
// На каждой: сколько зарабатывают компании отрасли, сколько в плюсе, как это меняется с возрастом, сколько новых
// и крупнейшие организации по доходам — из открытых данных ФНС (fns_peers, fns_market, fns_msp + fns_finance + fns_name).
// Этого нет у справочников: они показывают карточки компаний, а не «сколько зарабатывает кафе в Казани».
// Только организации: по ИП ФНС отчётность не публикует, и их имён здесь нет.
import fs from 'node:fs';
import path from 'node:path';
import { marketStats, MIN_GROUP } from './market.mjs';
import { money, shortName } from './company-page.mjs';
import { OKVED_COMMON, REGIONS } from '../src/lib/market-lists.mjs';
import { RUSSIA, ALL_AGES } from '../scripts/fns-peers.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const OKVED = new Map(OKVED_COMMON);
const REGION = new Map(REGIONS);
const TOP = 20;
const pct = (x) => (x == null ? '—' : Math.round(x * 100) + '%');
const int = (n) => new Intl.NumberFormat('ru-RU').format(n || 0);
const nb = (s) => String(s).replace(/ /g, '\u00a0');
// «Кафе, рестораны, доставка еды» → «кафе, рестораны, доставка еды» внутри фразы
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// Крупнейшие организации отрасли (по доходам за последний год отчётности); индексы — в scripts/fns-peers.mjs
export function topCompanies(db, okved, region, limit = TOP) {
  const next = String(Number(okved) + 1).padStart(2, '0');
  const where = region === RUSSIA ? 'm.okved >= ? AND m.okved < ?' : 'm.region = ? AND m.okved >= ? AND m.okved < ?';
  const args = region === RUSSIA ? [okved, next] : [region, okved, next];
  try {
    return db.prepare(`SELECT m.inn, n.name, f.income, f.expense FROM fns_msp m JOIN fns_finance f ON f.inn = m.inn JOIN fns_name n ON n.inn = m.inn
                       WHERE ${where} AND f.income > 0 ORDER BY f.income DESC LIMIT ?`).all(...args, limit)
      .map((r) => ({ inn: r.inn, name: shortName(r.name), income: r.income, profit: r.income - r.expense }));
  } catch { return []; }
}

// Регионы, где у отрасли есть статистика: для списка ссылок и карты сайта
function regionsOf(db, okved) {
  try {
    return db.prepare('SELECT region, n, nfin, profitable FROM fns_peers WHERE okved = ? AND age = ? AND region <> ? ORDER BY n DESC').all(okved, ALL_AGES, RUSSIA)
      .filter((r) => REGION.has(r.region));
  } catch { return []; }
}

export function renderIndustry(db, okved, region) {
  const oname = OKVED.get(okved), rname = region === RUSSIA ? 'Россия' : REGION.get(region);
  if (!oname || !rname) return null;
  const s = marketStats(db, { okved, region });
  if (!s || s.total.scope !== (region === RUSSIA ? 'russia' : 'region')) return null;   // в регионе мало данных — страницы нет, а не «вся Россия» под видом региона
  const t = s.total, where = region === RUSSIA ? 'в России' : `в регионе «${rname}»`;
  const top = topCompanies(db, okved, region);
  const title = `${oname} — ${region === RUSSIA ? 'Россия' : rname}: сколько зарабатывают, крупнейшие компании`;
  const desc = `${oname} ${where}: ${int(s.competition.companies)} организаций, половина получила доходы больше ${money(t.income[2])} за ${t.year} год, в плюсе ${pct(t.profitableShare)}. Крупнейшие компании и статистика по возрасту — по открытым данным ФНС.`;
  const url = region === RUSSIA ? `/otrasli/${okved}/` : `/otrasli/${okved}/${region}/`;

  const stat = (label, value, note) => `<div class="bigstat"><span class="bs-label">${esc(label)}</span><strong class="bs-val">${esc(value)}</strong>${note ? `<span class="bs-delta">${esc(note)}</span>` : ''}</div>`;
  let body = `<div class="bigstats">
${stat('Организаций', int(s.competition.companies), s.competition.newShare != null ? `новых за год: ${pct(s.competition.newShare)}` : '')}
${stat('Доходы у середины', nb(money(t.income[2])), `за ${t.year} год`)}
${stat('В плюсе', pct(t.profitableShare), `из ${int(t.withReports)} с отчётностью`)}
</div>
<h2 class="h">Сколько зарабатывают</h2>
<p>Половина организаций отрасли «${esc(lower(oname))}» ${esc(where)} получила за ${t.year} год доходы больше ${esc(nb(money(t.income[2])))}, четверть — больше ${esc(nb(money(t.income[3])))}, а у каждой десятой — больше ${esc(nb(money(t.income[4])))}. Прибыль (доходы минус расходы до налога) у середины — ${esc(nb(money(t.profit[2])))}; в плюсе закончили год ${pct(t.profitableShare)} компаний${t.marginMedian != null ? `, типичная рентабельность — ${pct(t.marginMedian)}` : ''}.</p>`;
  if (s.byAge.length) {
    body += `<h2 class="h">По возрасту компании</h2>
<div class="tbl-wrap"><table class="fns-table all-cols"><tr><th>Возраст</th><th>С отчётностью</th><th>Доходы у середины</th><th>Прибыль у середины</th><th>В плюсе</th></tr>
${s.byAge.map((a) => `<tr><td>${esc(a.label)}</td><td>${int(a.withReports)}</td><td>${esc(nb(money(a.income[2])))}</td><td>${esc(nb(money(a.profit[2])))}</td><td>${pct(a.profitableShare)}${a.scope === 'russia' && region !== RUSSIA ? '*' : ''}</td></tr>`).join('\n')}
</table></div>${s.byAge.some((a) => a.scope === 'russia') && region !== RUSSIA ? '<p class="note-sm">* В регионе мало компаний этого возраста с отчётностью — показана вся Россия.</p>' : ''}`;
  }
  if (top.length) {
    body += `<h2 class="h">Крупнейшие организации по доходам</h2>
<div class="tbl-wrap"><table class="fns-table all-cols rank"><tr><th>№</th><th>Организация</th><th>Доходы</th><th>Прибыль</th></tr>
${top.map((c, i) => `<tr><td>${i + 1}</td><td><a href="/organizacii/${c.inn}/">${esc(c.name)}</a></td><td>${esc(nb(money(c.income)))}</td><td>${esc(nb(money(c.profit)))}</td></tr>`).join('\n')}
</table></div>
<p class="note-sm">По основному виду деятельности в реестре МСП и бухгалтерской отчётности за ${t.year} год. Крупные компании, не входящие в реестр малого и среднего бизнеса, здесь не учтены.</p>`;
  }
  body += `<p><a class="btn" href="/kalkulyatory/perspektivy-biznesa/#calc=prospects&amp;code=${okved}&amp;region=${region}">Рассчитать перспективы своего бизнеса</a></p>`;
  const regs = regionsOf(db, okved).filter((r) => r.region !== region && r.nfin >= MIN_GROUP);
  if (regs.length) {
    body += `<h2 class="h">${region === RUSSIA ? 'По регионам' : 'Та же отрасль в других регионах'}</h2>
<ul class="cols-list">${region === RUSSIA ? '' : `<li><a href="/otrasli/${okved}/">Вся Россия</a></li>`}${regs.map((r) => `<li><a href="/otrasli/${okved}/${r.region}/">${esc(REGION.get(r.region))}</a> <span class="note-sm">${int(r.n)}</span></li>`).join('')}</ul>`;
  }
  body += `<p class="note-sm">Источник — открытые данные ФНС России: реестр малого и среднего бизнеса и сведения о доходах и расходах организаций. Это статистика прошлого года, а не обещание дохода. <a href="/otrasli/">Все отрасли</a>.</p>`;
  const ld = [
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Отрасли', item: '/otrasli/' },
      { '@type': 'ListItem', position: 2, name: oname, item: `/otrasli/${okved}/` },
      ...(region === RUSSIA ? [] : [{ '@type': 'ListItem', position: 3, name: rname, item: url }])
    ] },
    ...(top.length ? [{ '@context': 'https://schema.org', '@type': 'ItemList', name: `Крупнейшие организации: ${lower(oname)}, ${rname}`,
      itemListElement: top.slice(0, 10).map((c, i) => ({ '@type': 'ListItem', position: i + 1, url: `/organizacii/${c.inn}/`, name: c.name })) }] : [])
  ];
  return { title, desc, url, h1: `${oname}: ${region === RUSSIA ? 'Россия' : rname}`, lede: `Сколько зарабатывают организации отрасли ${where}, сколько из них в плюсе и кто крупнейший — по открытым данным ФНС за ${t.year} год.`, body, ld };
}

export function renderIndex(db) {
  const rows = OKVED_COMMON.map(([ok, name]) => {
    let r = null;
    try { r = db.prepare('SELECT n, profitable, income FROM fns_peers WHERE okved = ? AND region = ? AND age = ?').get(ok, RUSSIA, ALL_AGES); } catch { r = null; }
    return r && { ok, name, n: r.n, profitable: r.profitable, median: (JSON.parse(r.income || 'null') || [])[2] };
  }).filter(Boolean);
  if (!rows.length) return null;
  const body = `<table class="fns-table all-cols"><tr><th>Отрасль</th><th>Организаций</th><th>Доходы у середины</th><th>В плюсе</th></tr>
${rows.map((r) => `<tr><td><a href="/otrasli/${r.ok}/">${esc(r.name)}</a></td><td>${int(r.n)}</td><td>${esc(nb(money(r.median)))}</td><td>${pct(r.profitable)}</td></tr>`).join('\n')}
</table>
<p class="note-sm">По открытым данным ФНС: реестр малого и среднего бизнеса и доходы и расходы организаций. На странице отрасли — регионы, возраст компаний и крупнейшие организации. Любую другую отрасль по коду ОКВЭД можно посмотреть в <a href="/kalkulyatory/perspektivy-biznesa/">калькуляторе перспектив</a>.</p>`;
  return { title: 'Отрасли малого бизнеса: сколько зарабатывают компании', desc: 'Сколько зарабатывают кафе, магазины, салоны красоты, стройка и другие отрасли малого бизнеса в России и по регионам: доходы, доля прибыльных, крупнейшие компании — по открытым данным ФНС.', url: '/otrasli/', h1: 'Отрасли малого бизнеса', lede: 'Сколько зарабатывают компании в разных отраслях, сколько из них в плюсе и кто крупнейший — по России и по регионам.', body, ld: [] };
}

// Все адреса страниц отраслей — для карты сайта
export function industryUrls(db) {
  const urls = ['/otrasli/'];
  for (const [ok] of OKVED_COMMON) {
    const regs = regionsOf(db, ok);
    let all = null;
    try { all = db.prepare('SELECT nfin FROM fns_peers WHERE okved = ? AND region = ? AND age = ?').get(ok, RUSSIA, ALL_AGES); } catch { all = null; }
    if (all && all.nfin >= MIN_GROUP) urls.push(`/otrasli/${ok}/`);
    for (const r of regs) if (r.nfin >= MIN_GROUP) urls.push(`/otrasli/${ok}/${r.region}/`);
  }
  return urls;
}

export function createIndustryPages({ env, fdb, now = () => Date.now() }) {
  const dist = env.SITE_DIST || '/var/www/fin-check.shop';
  const siteUrl = (env.SITE_URL || 'https://inn-sider.ru').replace(/\/$/, '');
  let tpl = null, tplMtime = 0;
  const cache = new Map();   // адрес → { at, page }; страницы меняются раз в месяц с данными ФНС
  const DAY = 864e5;
  const template = () => {
    const file = path.join(dist, 'otrasli', 'index.html');
    const m = fs.statSync(file).mtimeMs;
    if (!tpl || m !== tplMtime) { tpl = fs.readFileSync(file, 'utf8'); tplMtime = m; cache.clear(); }
    return tpl;
  };
  const abs = (u) => siteUrl + u;
  const fill = (p) => {
    const ld = p.ld.map((x) => JSON.parse(JSON.stringify(x), (k, v) => (typeof v === 'string' && v.startsWith('/') && (k === 'item' || k === 'url') ? abs(v) : v)));
    return template()
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(p.title)} — INNSIDER</title>`)
      .replace(/(<meta name="description" content=")[^"]*"/, `$1${esc(p.desc)}"`)
      .replace(/(<meta property="og:description" content=")[^"]*"/, `$1${esc(p.desc)}"`)
      .replace(/(<meta property="og:title" content=")[^"]*"/, `$1${esc(p.title)}"`)
      .replace(/(<link rel="canonical" href=")[^"]*"/, `$1${esc(abs(p.url))}"`)
      .replace(/(<meta property="og:url" content=")[^"]*"/, `$1${esc(abs(p.url))}"`)
      .replace(/<!--ssr:intro-->[\s\S]*?<!--\/ssr:intro-->/, `<h1 class="page">${esc(p.h1)}</h1><p class="lede">${esc(p.lede)}</p>`)
      .replace(/<!--ssr:body-->[\s\S]*?<!--\/ssr:body-->/, p.body)
      .replace('</head>', ld.map((x) => `<script type="application/ld+json">${JSON.stringify(x).replace(/</g, '\\u003c')}</script>\n`).join('') + '</head>');
  };
  const send = (res, code, type, body, maxAge) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': code === 200 ? `public, max-age=${maxAge}` : 'no-store' }); res.end(body); };

  return function handle(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const p = url.pathname;
    if (!fdb || !/^\/(otrasli(\/|$)|sitemap-otrasli\.xml$)/.test(p)) return false;
    if (!fs.existsSync(path.join(dist, 'otrasli', 'index.html'))) return false;
    if (p === '/otrasli') { res.writeHead(301, { Location: '/otrasli/' }); res.end(); return true; }
    const hit = cache.get(p);
    if (hit && now() - hit.at < DAY && tplMtime === fs.statSync(path.join(dist, 'otrasli', 'index.html')).mtimeMs) { send(res, hit.code, hit.type, hit.body, 86400); return true; }
    let code = 200, type = 'text/html; charset=utf-8', body;
    if (p === '/sitemap-otrasli.xml') {
      type = 'application/xml; charset=utf-8';
      body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${industryUrls(fdb).map((u) => `<url><loc>${abs(u)}</loc></url>`).join('\n')}\n</urlset>\n`;
    } else {
      const m = /^\/otrasli\/(?:(\d{2})\/(?:(\d{2})\/)?)?$/.exec(p);
      let page = null;
      if (m && !m[1]) page = renderIndex(fdb);
      else if (m) page = renderIndustry(fdb, m[1], m[2] || RUSSIA);
      if (!m && /^\/otrasli\/\d{2}(\/\d{2})?$/.test(p)) { res.writeHead(301, { Location: p + '/' }); res.end(); return true; }
      if (page) body = fill(page);
      else { code = 404; body = template().replace('</head>', '<meta name="robots" content="noindex">\n</head>'); }
    }
    if (cache.size > 3000) cache.clear();
    cache.set(p, { at: now(), code, type, body });
    send(res, code, type, body, 86400);
    return true;
  };
}

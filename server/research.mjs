// «Исследования INNSIDER» (/issledovaniya/…): обзоры по открытым данным ФНС из нашей базы (fns_peers) — для прессы,
// поиска и тех, кто выбирает, чем заняться. Считаются на лету и меняются вместе с ежемесячным обновлением данных.
// Только сводные цифры по группам компаний — без названий и ИНН.
import fs from 'node:fs';
import path from 'node:path';
import { OKVED_ALL, REGIONS } from '../src/lib/market-lists.mjs';
import { RUSSIA, ALL_AGES } from '../scripts/fns-peers.mjs';
import { money } from './company-page.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const OKVED = new Map(OKVED_ALL), REGION = new Map(REGIONS);
const pct = (x) => (x == null ? '—' : Math.round(x * 100) + '%');
const int = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(n || 0));
const nb = (s) => String(s).replace(/ /g, ' ');
const AGE = { 0: 'Первый год', 1: 'Второй год', 2: 'Третий год', 3: '4–5-й год', 5: 'Старше 5 лет' };

function rows(db, sql, ...args) { try { return db.prepare(sql).all(...args); } catch { return []; } }
const yearOf = (db) => { try { return db.prepare('SELECT max(year) AS y FROM fns_peers').get().y; } catch { return null; } };
const table = (head, body) => `<div class="tbl-wrap"><table class="fns-table all-cols rank"><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>
${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('\n')}</table></div>`;
// пороги: отрасль в рейтинге — если отчётность сдали хотя бы min компаний, регион — если в реестре хотя бы minRegion организаций
const industries = (db, o) => rows(db, 'SELECT okved, n, nfin, profitable, income, margin FROM fns_peers WHERE region = ? AND age = ? AND nfin >= ?', RUSSIA, ALL_AGES, o.min)
  .filter((r) => OKVED.has(r.okved)).map((r) => ({ ...r, median: (JSON.parse(r.income || 'null') || [])[2] }));

export const STUDIES = [
  {
    slug: 'pribylnye-otrasli', title: 'Самые прибыльные отрасли малого бизнеса',
    lede: 'В каких отраслях больше всего компаний закончили год с прибылью — по отчётности всех организаций малого и среднего бизнеса.',
    build(db, y, o) {
      const list = industries(db, o).sort((a, b) => b.profitable - a.profitable);
      if (list.length < o.minList) return null;
      const top = list.slice(0, 15), low = list.slice(-5).reverse();
      return {
        finding: `Чаще всего прибыль по итогам ${y} года получали компании отрасли «${top[0] && OKVED.get(top[0].okved)}» — ${pct(top[0].profitable)} из тех, кто сдал отчётность. Реже всего — «${OKVED.get(low[0].okved)}»: ${pct(low[0].profitable)}.`,
        body: `<h2 class="h">Больше всего прибыльных компаний</h2>${table(['№', 'Отрасль', 'В плюсе', 'Доходы у середины', 'Компаний с отчётностью'],
          top.map((r, i) => [i + 1, `<a href="/otrasli/${r.okved}/">${esc(OKVED.get(r.okved))}</a>`, pct(r.profitable), nb(money(r.median)), int(r.nfin)]))}
<h2 class="h">Меньше всего</h2>${table(['№', 'Отрасль', 'В плюсе', 'Доходы у середины', 'Компаний с отчётностью'],
          low.map((r, i) => [list.length - i, `<a href="/otrasli/${r.okved}/">${esc(OKVED.get(r.okved))}</a>`, pct(r.profitable), nb(money(r.median)), int(r.nfin)]))}`
      };
    }
  },
  {
    slug: 'gde-otkryvayut-biznes', title: 'Где чаще всего открывают бизнес',
    lede: 'Доля компаний первого года среди всех организаций малого и среднего бизнеса региона — показатель того, насколько активно там начинают новое дело.',
    build(db, y, o) {
      const all = rows(db, 'SELECT region, SUM(CASE WHEN age = 0 THEN n ELSE 0 END) AS fresh, SUM(CASE WHEN age = ? THEN n ELSE 0 END) AS total FROM fns_peers WHERE region <> ? GROUP BY region', ALL_AGES, RUSSIA)
        .filter((r) => REGION.has(r.region) && r.total >= o.minRegion).map((r) => ({ ...r, share: r.fresh / r.total })).sort((a, b) => b.share - a.share);
      if (all.length < o.minList) return null;
      const top = all.slice(0, 15);
      return {
        finding: `Больше всего новых компаний — в регионе «${REGION.get(top[0].region)}»: ${pct(top[0].share)} организаций работают первый год. Меньше всего — «${REGION.get(all[all.length - 1].region)}»: ${pct(all[all.length - 1].share)}.`,
        body: `<h2 class="h">Регионы с самой высокой долей новых компаний</h2>${table(['№', 'Регион', 'Новых', 'Организаций всего'],
          top.map((r, i) => [i + 1, esc(REGION.get(r.region)), pct(r.share), int(r.total)]))}
<p class="note-sm">Регионы, где меньше ${int(o.minRegion)} организаций в реестре, не участвуют. Новые — компании, которые на конец отчётного года работали меньше года.</p>`
      };
    }
  },
  {
    slug: 'gde-bolshe-zarabatyvayut', title: 'В каких отраслях у компаний самые большие доходы',
    lede: 'Доходы у середины — половина компаний отрасли получила больше, половина меньше. Так крупные игроки не искажают картину.',
    build(db, y, o) {
      const list = industries(db, o).sort((a, b) => b.median - a.median);
      if (list.length < o.minList) return null;
      const top = list.slice(0, 15);
      return {
        finding: `Самые большие доходы у середины — в отрасли «${OKVED.get(top[0].okved)}»: ${money(top[0].median)} за ${y} год. Для сравнения, у середины всех отраслей в этом списке — ${money(list[Math.floor(list.length / 2)].median)}.`,
        body: `<h2 class="h">Доходы у середины</h2>${table(['№', 'Отрасль', 'Доходы у середины', 'Рентабельность', 'В плюсе'],
          top.map((r, i) => [i + 1, `<a href="/otrasli/${r.okved}/">${esc(OKVED.get(r.okved))}</a>`, nb(money(r.median)), pct(r.margin), pct(r.profitable)]))}`
      };
    }
  },
  {
    slug: 'pribylnost-po-vozrastu', title: 'Как меняется прибыльность с возрастом компании',
    lede: 'Какая доля компаний в плюсе на первом, втором, третьем году и позже — по всем отраслям малого и среднего бизнеса России.',
    build(db, y, o) {
      const list = rows(db, 'SELECT age, SUM(nfin) AS nfin, SUM(nfin * profitable) / SUM(nfin) AS share FROM fns_peers WHERE region = ? AND age >= 0 AND nfin > 0 GROUP BY age ORDER BY age', RUSSIA)
        .filter((r) => AGE[r.age]);
      if (list.length < 4) return null;
      const first = list[0], last = list[list.length - 1];
      return {
        finding: `На первом году с прибылью закончили ${y} год ${pct(first.share)} компаний, у компаний старше пяти лет — ${pct(last.share)}.`,
        body: `<h2 class="h">Доля прибыльных по возрасту</h2>${table(['Возраст', 'В плюсе', 'Компаний с отчётностью'], list.map((r) => [AGE[r.age], pct(r.share), int(r.nfin)]))}
<p>Подробнее по своей отрасли и региону — в <a href="/prognoz/">прогнозе бизнеса</a>.</p>`
      };
    }
  }
];

export function createResearch({ env, fdb, now = () => Date.now(), min = 300, minRegion = 1000, minList = 10 }) {
  const o = { min, minRegion, minList };
  const dist = env.SITE_DIST || '/var/www/fin-check.shop';
  const cache = new Map();
  return function handle(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const m = /^\/issledovaniya\/(?:([a-z-]+)\/)?$/.exec(url.pathname);
    if (!fdb || !url.pathname.startsWith('/issledovaniya')) return false;
    const file = path.join(dist, 'issledovaniya', 'index.html');
    if (!fs.existsSync(file)) return false;
    if (url.pathname === '/issledovaniya') { res.writeHead(301, { Location: '/issledovaniya/' }); res.end(); return true; }
    const hit = cache.get(url.pathname);
    if (hit && now() - hit.at < 864e5) { res.writeHead(hit.code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': hit.code === 200 ? 'public, max-age=86400' : 'no-store' }); res.end(hit.body); return true; }
    const y = yearOf(fdb), tpl = fs.readFileSync(file, 'utf8');
    let code = 200, title, h1, lede, body;
    if (m && !m[1]) {
      const built = STUDIES.map((s) => ({ s, r: s.build(fdb, y, o) })).filter((x) => x.r);
      title = 'Исследования INNSIDER'; h1 = 'Исследования'; lede = `Обзоры малого и среднего бизнеса России по открытым данным ФНС за ${y || 'последний'} год. Цифры обновляются вместе с данными.`;
      body = built.map(({ s, r }) => `<article class="study"><h2 class="h"><a href="/issledovaniya/${s.slug}/">${esc(s.title)}</a></h2><p>${esc(r.finding)}</p></article>`).join('\n') || '<p>Данные ещё загружаются.</p>';
    } else {
      const s = m && STUDIES.find((x) => x.slug === m[1]), r = s && s.build(fdb, y, o);
      if (!r) { code = 404; title = 'Исследование не найдено'; h1 = title; lede = ''; body = '<p><a href="/issledovaniya/">Все исследования</a></p>'; }
      else {
        title = s.title; h1 = s.title; lede = s.lede;
        body = `<p class="study-finding">${esc(r.finding)}</p>${r.body}
<h2 class="h">Для публикации</h2>
<p class="note-sm">При цитировании укажите: «по данным INNSIDER на основе открытых данных ФНС России» и дайте ссылку на эту страницу. Источники — реестр малого и среднего бизнеса и сведения о доходах и расходах организаций за ${y} год. Прибыль — доходы минус расходы до налога. ИП не учитываются: ФНС не публикует их отчётность.</p>
<p><a href="/issledovaniya/">Все исследования</a></p>`;
      }
    }
    const html = tpl.replace(/<title>[^<]*<\/title>/, `<title>${esc(title)} — INNSIDER</title>`)
      .replace(/(<meta name="description" content=")[^"]*"/, `$1${esc(lede)}"`)
      .replace(/(<link rel="canonical" href=")[^"]*"/, `$1${esc((env.SITE_URL || 'https://inn-sider.ru').replace(/\/$/, '') + url.pathname)}"`)
      .replace(/<!--ssr:intro-->[\s\S]*?<!--\/ssr:intro-->/, `<h1 class="page">${esc(h1)}</h1>${lede ? `<p class="lede">${esc(lede)}</p>` : ''}`)
      .replace(/<!--ssr:body-->[\s\S]*?<!--\/ssr:body-->/, body)
      .replace('</head>', code === 404 ? '<meta name="robots" content="noindex">\n</head>' : '</head>');
    cache.set(url.pathname, { at: now(), code, body: html });
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': code === 200 ? 'public, max-age=86400' : 'no-store' });
    res.end(html);
    return true;
  };
}

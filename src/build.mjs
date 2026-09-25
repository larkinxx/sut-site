// Сборка сайта: content/ + config/ + public/  ->  dist/
// Запуск: npm run build          (только проверенные опубликованные новости)
//         npm run preview        (с демо-примерами и локальным просмотром)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, loadSite, loadCards, loadMaterials, readJson } from './lib/content.mjs';
import { AUDIENCES, AUDIENCE_TABS, esc, markTitle, dateRu, agoRu } from './lib/util.mjs';
import { SCHEMES, taxSections } from './lib/taxes.mjs';

const withExamples = process.argv.includes('--examples');
const site = loadSite();
// Налоговые константы для калькуляторов: одно место, где их правят при изменении закона или ставки ЦБ
const FIN = readJson('config/finance.json', {});
// Адрес сайта можно задать снаружи (так делает автодеплой), не трогая config/site.json
if (process.env.SITE_URL) site.siteUrl = process.env.SITE_URL.replace(/\/$/, '');
if (process.env.BASE_PATH !== undefined) site.basePath = process.env.BASE_PATH;
const DIST = path.join(ROOT, 'dist');
const base = (site.basePath || '').replace(/\/$/, '');
const url = (p) => base + p;

const { cards, problems: cardProblems } = loadCards({ withExamples });
const { materials, problems: matProblems } = loadMaterials();

// Проблемы в содержимом не роняют сборку целиком, но не скрываются: печатаем и (в CI) падаем при --strict
const problems = [...cardProblems, ...matProblems];
if (problems.length) {
  console.warn('\nЕсть записи, которые не попали на сайт:');
  problems.forEach((p) => console.warn(' - ' + p));
  if (process.argv.includes('--strict')) process.exit(1);
}

// ---------- файлы ----------
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
const write = (rel, content) => {
  const abs = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};
const hashOf = (f) => crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, 'public', f))).digest('hex').slice(0, 8);
const cssV = hashOf('style.css');
const jsV = hashOf('app.js');
fs.cpSync(path.join(ROOT, 'public'), DIST, { recursive: true });

// ---------- иконки ----------
// Phosphor Icons (regular, MIT, phosphoricons.com): встраиваем SVG прямо в страницу, без шрифта иконок и внешних запросов
const PH = {
  sun: 'M120,40V16a8,8,0,0,1,16,0V40a8,8,0,0,1-16,0Zm72,88a64,64,0,1,1-64-64A64.07,64.07,0,0,1,192,128Zm-16,0a48,48,0,1,0-48,48A48.05,48.05,0,0,0,176,128ZM58.34,69.66A8,8,0,0,0,69.66,58.34l-16-16A8,8,0,0,0,42.34,53.66Zm0,116.68-16,16a8,8,0,0,0,11.32,11.32l16-16a8,8,0,0,0-11.32-11.32ZM192,72a8,8,0,0,0,5.66-2.34l16-16a8,8,0,0,0-11.32-11.32l-16,16A8,8,0,0,0,192,72Zm5.66,114.34a8,8,0,0,0-11.32,11.32l16,16a8,8,0,0,0,11.32-11.32ZM48,128a8,8,0,0,0-8-8H16a8,8,0,0,0,0,16H40A8,8,0,0,0,48,128Zm80,80a8,8,0,0,0-8,8v24a8,8,0,0,0,16,0V216A8,8,0,0,0,128,208Zm112-88H216a8,8,0,0,0,0,16h24a8,8,0,0,0,0-16Z',
  moon: 'M233.54,142.23a8,8,0,0,0-8-2,88.08,88.08,0,0,1-109.8-109.8,8,8,0,0,0-10-10,104.84,104.84,0,0,0-52.91,37A104,104,0,0,0,136,224a103.09,103.09,0,0,0,62.52-20.88,104.84,104.84,0,0,0,37-52.91A8,8,0,0,0,233.54,142.23ZM188.9,190.34A88,88,0,0,1,65.66,67.11a89,89,0,0,1,31.4-26A106,106,0,0,0,96,56,104.11,104.11,0,0,0,200,160a106,106,0,0,0,14.92-1.06A89,89,0,0,1,188.9,190.34Z',
  checkCircle: 'M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z',
  arrowRight: 'M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z',
  arrowLeft: 'M224,128a8,8,0,0,1-8,8H59.31l58.35,58.34a8,8,0,0,1-11.32,11.32l-72-72a8,8,0,0,1,0-11.32l72-72a8,8,0,0,1,11.32,11.32L59.31,120H216A8,8,0,0,1,224,128Z'
};
const icon = (name, cls = 'ph') => `<svg class="${cls}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="${PH[name]}"/></svg>`;

// ---------- шаблон страницы ----------
const OG_IMAGE = site.siteUrl + '/og.png';
const NAV = [
  ['/', 'Новости', 'news'],
  ['/kalkulyatory/', 'Калькуляторы', 'calc'],
  ['/nalogi/', 'Налоги', 'tax'],
  ['/organizacii/', 'Организации', 'org'],
  ['/fizlica/', 'Физлица', 'person']
  // «Как мы работаем» и «О проекте» — в подвале каждой страницы
];

function layout({ title, desc, path: pagePath, current, body, ld }) {
  const full = title === site.name ? `${site.name}: ${site.tagline}` : `${title} — ${site.name}`;
  const canonical = site.siteUrl + pagePath;
  const nav = NAV.map(([href, label, id]) =>
    `<a href="${url(href)}"${id === current ? ' aria-current="page"' : ''}>${label}</a>`).join('\n      ');
  return `<!doctype html>
<html lang="${site.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(desc || site.tagline)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(full)}">
<meta property="og:description" content="${esc(desc || site.tagline)}">
<meta property="og:type" content="${ld ? 'article' : 'website'}">
<meta property="og:locale" content="ru_RU">
<meta property="og:site_name" content="${esc(site.name)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(OG_IMAGE)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#F3EEE1" id="theme-color-meta">
<script>(function(){try{if(localStorage.getItem('theme')==='dark')document.documentElement.setAttribute('data-theme','dark');}catch(e){}})();</script>
<link rel="preload" href="${url('/fonts/pt-serif-400-cyrillic.woff2')}" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${url('/fonts/pt-serif-700-cyrillic.woff2')}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${url('/style.css')}?v=${cssV}">
<link rel="alternate" type="application/rss+xml" title="${esc(site.name)}" href="${url('/rss.xml')}">
${ld ? `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body>
<a class="skip" href="#main">К содержанию</a>
${withExamples ? '<div class="wrap" style="padding:8px 16px 0;font:500 13px var(--font-ui);color:var(--accent)">Режим просмотра: показаны демонстрационные примеры, на настоящий сайт они не попадают.</div>' : ''}
<header>
  <div class="bar">
    <a class="logo" href="${url('/')}">${esc(site.name)}<i>.</i></a>
    <nav aria-label="Основное меню">
      ${nav}
    </nav>
    <button id="theme-toggle" class="theme-btn" type="button" aria-label="Переключить тему оформления" title="Переключить тему">
      ${icon('sun', 'ic-sun')}
      ${icon('moon', 'ic-moon')}
    </button>
  </div>
</header>
<main class="wrap" id="main">
${body}
</main>
<footer class="wrap">
  <p class="fine">${esc(site.disclaimer)} Как мы готовим новости: <a href="${url('/kak-my-rabotaem/')}">как мы работаем</a>. <a href="${url('/o-proekte/')}">О проекте</a>.${site.contactEmail ? ` Нашли ошибку? Напишите: <a href="mailto:${esc(site.contactEmail)}">${esc(site.contactEmail)}</a>.` : ''}</p>
</footer>
${body.includes('data-calc=') || body.includes('id="org"') ? `<script type="application/json" id="fin">${JSON.stringify(FIN).replace(/</g, '\\u003c')}</script>\n` : ''}<script src="${url('/app.js')}?v=${jsV}" defer></script>
<script>
   (function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
   m[i].l=1*new Date();
   for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
   k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})
   (window, document, "script", "https://mc.yandex.ru/metrika/tag.js", "ym");

   ym(113035472, "init", {
        clickmap:true,
        trackLinks:true,
        accurateTrackBounce:true,
        webvisor:true
   });
</script>
<noscript><div><img src="https://mc.yandex.ru/watch/113035472" style="position:absolute; left:-9999px;" alt="" /></div></noscript>
</body>
</html>
`;
}

// ---------- блоки ----------
const ICON_CHECK = icon('checkCircle');
const cardUrl = (c) => url(`/n/${c.id}/`);
const audNames = (c) => c.affects.map((a) => AUDIENCES[a].toLowerCase()).join(', ');

function feedItem(c) {
  const ts = Date.parse(c.publishedAt);
  return `<details class="item${c.critical ? ' crit' : ''}" data-ts="${ts}" data-affects="${esc(c.affects.join(' '))}">
  <summary>
    <span class="av" aria-hidden="true">${esc(c.source.name.charAt(0))}</span>
    <span class="tx"><span class="h">${markTitle(c.title, c.highlight)}</span>
      <span class="subline">${c.critical ? '<span class="lvl">Важно</span>' : ''}<time class="ago" datetime="${esc(c.publishedAt)}">${esc(dateRu(c.publishedAt))}</time></span>
    </span>
  </summary>
  <div class="more-i">
    <p class="gloss">${esc(c.gloss)}</p>
    <p class="tip"><b>Что делать:</b> ${esc(c.tip)}</p>
    <span class="isrc">${esc(c.source.name)} · ${esc(audNames(c))}${c.review && c.review.auto ? ' · подготовлено ИИ' : ''}</span>
    <a class="full" href="${cardUrl(c)}">Полный разбор ${icon('arrowRight')}</a>
  </div>
</details>`;
}

function subscribeBlock() {
  const hasForm = !!site.subscribeFormAction;
  if (!hasForm && !site.telegramUrl) return '';
  return `<section class="subscribe" aria-labelledby="sub-h">
  <h2 id="sub-h">Дайджест недели</h2>
  <p>${esc(site.subscribeNote)}</p>
  ${hasForm ? `<form class="subform" method="post" action="${esc(site.subscribeFormAction)}">
    <input type="email" name="email" required autocomplete="email" placeholder="Ваша почта" aria-label="Ваша почта">
    <button class="btn" type="submit">Подписаться</button>
  </form>` : ''}
  ${site.telegramUrl ? `<div class="sublinks"><a class="full" href="${esc(site.telegramUrl)}" rel="noopener">Читать в Telegram ${icon('arrowRight')}</a></div>` : ''}
</section>`;
}

function materialsFor(topicIds, { max = 1 } = {}) {
  const pick = (kind) => materials
    .filter((m) => m.kind === kind && m.topics.some((t) => topicIds.includes(t)))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, max);
  return [...pick('video'), ...pick('course')];
}
function materialRow(m) {
  const price = m.kind === 'video' ? (m.price || 'бесплатно') : (m.price || '');
  return `<div class="mat"><b class="${m.kind === 'video' ? 'k-video' : 'k-course'}">${m.kind === 'video' ? 'Видео' : 'Курс'}</b>
    <div class="mi"><span>${esc(m.title)}</span>
      <span class="by">${esc(m.author)}${m.duration ? ' · ' + esc(m.duration) : ''}${price ? ' · ' + esc(price) : ''} · обновлено ${esc(m.updatedAt)}</span>
      ${m.affiliate ? '<span class="tag-ad">Партнёрская ссылка</span>' : ''}
      <a class="go" href="${esc(m.url)}" rel="noopener${m.affiliate ? ' sponsored' : ''}">${m.kind === 'video' ? 'Смотреть' : 'Подробнее'}</a>
    </div></div>`;
}

// ---------- калькуляторы ----------
function calcMortgage(id = '') {
  return `<section class="calc" data-calc="mortgage" aria-labelledby="cm${id}">
  <h2 id="cm${id}">Как изменится платёж по кредиту</h2>
  <div class="fields">
    <label class="f">Сумма кредита, ₽<input type="number" name="sum" value="5000000" min="0" step="100000" inputmode="numeric"></label>
    <label class="f">Срок, лет<input type="number" name="years" value="20" min="1" max="40" step="1" inputmode="numeric"></label>
    <label class="f">Ставка сейчас, %<input type="number" name="old" value="16" min="0" step="0.1" inputmode="decimal"></label>
    <label class="f">Ставка после, %<input type="number" name="new" value="15.5" min="0" step="0.1" inputmode="decimal"></label>
  </div>
  <div class="result" aria-live="polite"></div>
  <p class="note-sm">Расчёт аннуитетного платежа. Ваша ставка может измениться иначе: это зависит от условий договора.</p>
</section>`;
}
function calcDeposit(id = '') {
  return `<section class="calc" data-calc="deposit" aria-labelledby="cd${id}">
  <h2 id="cd${id}">Сколько принесёт вклад</h2>
  <div class="fields">
    <label class="f">Сумма, ₽<input type="number" name="sum" value="500000" min="0" step="10000" inputmode="numeric"></label>
    <label class="f">Ставка, % годовых<input type="number" name="rate" value="14" min="0" step="0.1" inputmode="decimal"></label>
    <label class="f">Срок, месяцев<input type="number" name="months" value="12" min="1" max="120" step="1" inputmode="numeric"></label>
    <label class="f">Инфляция, % в год<input type="number" name="infl" value="8" min="0" step="0.1" inputmode="decimal"></label>
  </div>
  <label class="f" style="grid-template-columns:auto 1fr;align-items:center;margin-top:12px"><input type="checkbox" name="cap" checked> Проценты прибавляются к сумме каждый месяц</label>
  <div class="result" aria-live="polite"></div>
  <p class="note-sm">Без учёта налога на доход по вкладам. Последняя строка показывает сумму в сегодняшних ценах при заданной инфляции.</p>
</section>`;
}

const rubFmt = (n) => new Intl.NumberFormat('ru-RU').format(n) + ' ₽';
const years = Object.keys((FIN.depositTax && FIN.depositTax.freeLimit) || {}).sort().reverse();
function calcDepositTax(id = '') {
  return `<section class="calc" data-calc="depositTax" aria-labelledby="ct${id}">
  <h2 id="ct${id}">Налог на проценты по вкладам</h2>
  <div class="fields">
    <label class="f">Сумма на всех вкладах и счетах, ₽<input type="number" name="sum" value="2000000" min="0" step="50000" inputmode="numeric"></label>
    <label class="f">Средняя ставка, % годовых<input type="number" name="rate" value="14" min="0" step="0.1" inputmode="decimal"></label>
    <label class="f">Год, когда получены проценты<select name="year">${years.map((y, i) => `<option value="${y}"${i === 0 ? ' selected' : ''}>${y}</option>`).join('')}</select></label>
  </div>
  <div class="result" aria-live="polite"></div>
  <p class="note-sm">Считаем проценты по всем банкам вместе: лимит без налога один на человека. Не облагается 1 млн ₽ × максимальная ключевая ставка на 1-е число месяцев года (${years.map((y) => `${y}: ${rubFmt(FIN.depositTax.freeLimit[y])}`).join(', ')}). Проценты по счетам со ставкой до 1% не учитываются. Налог приходит в уведомлении от ФНС и платится до 1 декабря следующего года.</p>
</section>`;
}
function calcPrepay(id = '') {
  return `<section class="calc" data-calc="prepay" aria-labelledby="cp${id}">
  <h2 id="cp${id}">Сократить срок или платёж</h2>
  <div class="fields">
    <label class="f">Остаток долга, ₽<input type="number" name="debt" value="4000000" min="0" step="100000" inputmode="numeric"></label>
    <label class="f">Ставка, %<input type="number" name="rate" value="16" min="0" step="0.1" inputmode="decimal"></label>
    <label class="f">Осталось платить, лет<input type="number" name="years" value="18" min="1" max="40" step="1" inputmode="numeric"></label>
    <label class="f">Досрочно вношу, ₽<input type="number" name="extra" value="300000" min="0" step="10000" inputmode="numeric"></label>
  </div>
  <div class="result cmp" aria-live="polite"></div>
  <p class="note-sm">Расчёт для аннуитетного кредита: платёж одинаковый каждый месяц. Выбрать вариант можно в заявлении на досрочное погашение, банк обязан пересчитать график. Для ипотеки можно заявить налоговый вычет по уплаченным процентам, он не учтён.</p>
</section>`;
}
function calcSelfEmployed(id = '') {
  const n = FIN.npd || {}, ip = FIN.ip || {};
  return `<section class="calc" data-calc="selfemployed" aria-labelledby="cs${id}">
  <h2 id="cs${id}">Самозанятый или ИП на упрощёнке</h2>
  <div class="fields">
    <label class="f">Доход в месяц, ₽<input type="number" name="income" value="120000" min="0" step="5000" inputmode="numeric"></label>
    <label class="f">Из них от компаний и ИП, %<input type="number" name="legal" value="50" min="0" max="100" step="5" inputmode="numeric"></label>
  </div>
  <div class="result cmp" aria-live="polite"></div>
  <p class="note-sm">Самозанятый: ${n.rateIndividuals * 100}% с оплат от людей, ${n.rateCompanies * 100}% от компаний и ИП, разовый вычет ${rubFmt(n.deduction)} снижает ставку, пока не израсходован. Лимит дохода ${rubFmt(n.limit)} в год. Пенсионный стаж не идёт, если не платить взносы добровольно. ИП на УСН «Доходы» ${ip.usnRate * 100}%: фиксированные взносы ${rubFmt(ip.fixed)} за ${ip.year} год и ${ip.extraRate * 100}% с дохода сверх ${rubFmt(ip.extraFrom)} (не больше ${rubFmt(ip.extraMax)}). ИП без сотрудников уменьшает налог на всю сумму взносов. В некоторых регионах ставка УСН ниже. Расчёт на ${ip.year} год, без учёта сотрудников и НДС.</p>
</section>`;
}

// ---------- страницы ----------
// Ключевая ставка, инфляция и ближайшее решение ЦБ (цифры обновляет scripts/rates.mjs, дату заседания выбирает app.js)
function macroWidget() {
  if (!FIN.keyRate) return '';
  const d = (iso, opt) => new Date(iso + 'T12:00:00+03:00').toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', ...opt });
  const pct = (n) => String(n).replace('.', ',') + '%';
  const inf = FIN.inflation;
  return `<div class="macro" aria-label="Главные цифры">
  <a href="${url('/kalkulyatory/kredit/')}"><span>Ключевая ставка</span><b>${pct(FIN.keyRate)}</b>${FIN.keyRateSince ? `<small>с ${d(FIN.keyRateSince, { day: 'numeric', month: 'long' })}</small>` : ''}</a>
  ${inf ? `<a href="${url('/kalkulyatory/vklad/')}"><span>Инфляция за год</span><b>${pct(inf.value)}</b><small>на ${d(inf.month + '-01', { month: 'long', year: 'numeric' }).replace(' г.', '')}</small></a>` : ''}
  ${(FIN.cbrMeetings || []).length ? `<div class="next-cbr" data-dates="${esc(FIN.cbrMeetings.join(' '))}"><span>Следующее решение ЦБ</span><b></b><small>в 13:30 МСК</small></div>` : ''}
</div>`;
}

// Главная: лента за 24 часа
{
  const list = cards.map(feedItem).join('\n');
  const body = `${macroWidget()}<h1 class="page">Новости за ${site.windowHours} ${site.windowHours === 24 ? 'часа' : 'часов'}</h1>
<div class="filters" id="filters" role="group" aria-label="Для кого показывать новости">
  <button type="button" class="chip" data-f="*" aria-pressed="true">Все</button>
  <button type="button" class="chip" data-f="borrowers" aria-pressed="false">${AUDIENCES.borrowers}</button>
  <button type="button" class="chip" data-f="savers" aria-pressed="false">${AUDIENCES.savers}</button>
  <button type="button" class="chip" data-f="selfemployed" aria-pressed="false">${AUDIENCES.selfemployed}</button>
  <button type="button" class="chip" data-f="business" aria-pressed="false">${AUDIENCES.business}</button>
</div>
<div class="list" id="feed" data-window="${site.windowHours}">
${list}
<button type="button" class="morebtn" id="more" hidden></button>
<p class="empty" id="empty"${cards.length ? ' hidden' : ''}>За последние ${site.windowHours} часа новостей нет. <a href="${url('/arhiv/')}">Посмотреть архив</a>.</p>
</div>
${subscribeBlock()}`;
  write('index.html', layout({ title: site.name, desc: site.tagline, path: '/', current: 'news', body }));
}

// Архив
{
  const rows = cards.map((c) => `<li><a href="${cardUrl(c)}">${esc(c.title)}</a> <span class="ago" style="display:block">${esc(dateRu(c.publishedAt))} · ${esc(c.source.name)}</span></li>`).join('\n');
  const body = `<h1 class="page">Архив новостей</h1>
<p class="lede">Все проверенные редактором новости.</p>
<div class="prose" style="margin-top:20px">${cards.length ? `<ul style="list-style:none;padding:0;display:grid;gap:14px">${rows}</ul>` : '<p class="empty">Пока здесь ничего нет.</p>'}</div>`;
  write('arhiv/index.html', layout({ title: 'Архив новостей', path: '/arhiv/', current: 'news', body }));
}

// Карточки новостей
for (const c of cards) {
  const ts = Date.parse(c.publishedAt);
  const tabs = AUDIENCE_TABS.filter((k) => c.audiences && c.audiences[k]);
  const sections = tabs.map((k) => {
    const a = c.audiences[k];
    return `<div class="aud" id="aud-${k}" data-aud="${k}">
  <h3>${esc(AUDIENCES[k])}</h3>
  <p>${esc(a.meaning)}</p>
  <h2 class="label">Что можно сделать</h2>
  <ul class="steps">${a.steps.map((s) => `<li>${ICON_CHECK}<span>${esc(s)}</span></li>`).join('')}</ul>
</div>`;
  }).join('\n');
  const tabBtns = tabs.map((k) => `<button type="button" class="tab" data-a="${k}" aria-selected="false">${esc(AUDIENCES[k])}</button>`).join('');
  const CALC_FN = { mortgage: calcMortgage, deposit: calcDeposit, depositTax: calcDepositTax, prepay: calcPrepay, selfemployed: calcSelfEmployed };
  const calc = CALC_FN[c.calc] ? CALC_FN[c.calc](c.id.slice(-4)) : '';
  const conf = {
    high: ['lvl-h', 'Высокая', 'Факт подтверждён первоисточником, цифры сверены редактором.'],
    medium: ['lvl-m', 'Средняя', 'Факт подтверждён, но часть выводов зависит от условий конкретного договора или решения.'],
    low: ['lvl-l', 'Низкая', 'Первоисточник неполный или выводы предварительные: сверяйтесь с оригиналом.']
  }[c.confidence];
  const learn = materialsFor(c.topics || []);
  const body = `<a class="crumb" href="${url('/')}">${icon('arrowLeft')} Все новости</a>
<article>
  <div class="meta">${c.critical ? '<span class="lvl">Важно</span>' : ''}<span>Новость</span><time datetime="${esc(c.publishedAt)}">${esc(dateRu(c.publishedAt))}</time><span class="ago" data-ts="${ts}"></span></div>
  <h1 class="art">${markTitle(c.title, c.highlight)}</h1>
  <p class="source">Источник: ${esc(c.source.name)} · <a href="${esc(c.source.url)}" rel="noopener">открыть первоисточник</a></p>

  <h2 class="label">Что случилось</h2>
  <p class="lead">${esc(c.summary)}</p>

  ${tabs.length ? `<h2 class="label">Что это значит для вас</h2>
  <div class="tabs" id="aud-tabs" role="group" aria-label="Для кого" hidden>${tabBtns}</div>
  ${sections}` : ''}
  ${calc}

  <p class="conf"><b>Уровень уверенности: <span class="${conf[0]}">${conf[1]}.</span></b> ${esc(conf[2])}${c.confidenceNote ? ' ' + esc(c.confidenceNote) : ''}<br>${c.review.auto ? `Подготовлено ИИ и опубликовано автоматически ${esc(dateRu(c.review.at))}: редактор не читал, числа сверены с текстом первоисточника программой. Сверяйтесь с первоисточником.` : `Проверил: ${esc(c.review.by)}, ${esc(dateRu(c.review.at))}.`}</p>
</article>
${learn.length ? `<section class="grp"><h2>Где подучиться</h2><div class="mats" style="margin-top:12px">${learn.map(materialRow).join('')}</div>
<p class="note-sm">Метка «Партнёрская ссылка» значит, что сайт получает комиссию.</p></section>` : ''}
${subscribeBlock()}`;
  const org = { '@type': 'Organization', name: site.name, url: site.siteUrl + '/', logo: { '@type': 'ImageObject', url: site.siteUrl + '/logo.png', width: 512, height: 512 } };
  const ld = {
    '@context': 'https://schema.org', '@type': 'NewsArticle', headline: c.title,
    datePublished: c.publishedAt, dateModified: (c.review && c.review.at) || c.publishedAt,
    inLanguage: 'ru', description: c.gloss, image: [OG_IMAGE],
    mainEntityOfPage: { '@type': 'WebPage', '@id': site.siteUrl + `/n/${c.id}/` },
    author: org, publisher: org, isBasedOn: c.source.url
  };
  write(`n/${c.id}/index.html`, layout({ title: c.title, desc: c.gloss, path: `/n/${c.id}/`, current: 'news', body, ld }));
}

// Калькуляторы: у каждого своя страница (её находят поиском), в разделе — список
const CALCS = [
  { slug: 'kredit', fn: calcMortgage, title: 'Калькулятор платежа по кредиту', short: 'Платёж по кредиту',
    desc: 'Как изменится ежемесячный платёж по кредиту или ипотеке, если ставка вырастет или снизится.',
    lede: 'Подставьте сумму, срок и две ставки: покажем платёж до и после и разницу за весь срок.' },
  { slug: 'dosrochnoe-pogashenie', fn: calcPrepay, title: 'Досрочное погашение: сократить срок или платёж', short: 'Досрочное погашение',
    desc: 'Калькулятор досрочного погашения кредита и ипотеки: сравнение сокращения срока и уменьшения платежа, экономия на процентах.',
    lede: 'Введите остаток долга и сумму, которую хотите внести. Покажем оба варианта и сколько вы сэкономите на процентах.' },
  { slug: 'vklad', fn: calcDeposit, title: 'Калькулятор доходности вклада', short: 'Доход по вкладу',
    desc: 'Сколько принесёт вклад с учётом капитализации и сколько это в сегодняшних ценах при заданной инфляции.',
    lede: 'Доход по вкладу с капитализацией и без, и что останется от него после инфляции.' },
  { slug: 'nalog-na-vklady', fn: calcDepositTax, title: 'Калькулятор налога на проценты по вкладам', short: 'Налог на вклады',
    desc: 'Сколько налога заплатить с процентов по вкладам: необлагаемый лимит, облагаемая часть и сумма НДФЛ.',
    lede: 'Посчитаем, какая часть процентов не облагается, сколько налога придёт в уведомлении и при какой сумме вкладов налога не будет.' },
  { slug: 'samozanyatyj-ili-ip', fn: calcSelfEmployed, title: 'Самозанятый или ИП: что выгоднее', short: 'Самозанятый или ИП',
    desc: 'Сравнение налогов самозанятого (НПД) и ИП на УСН 6% с учётом страховых взносов при вашем доходе.',
    lede: 'Введите доход в месяц и долю оплат от компаний: сравним налог самозанятого и ИП на упрощёнке со взносами.' }
];
for (const c of CALCS) {
  write(`kalkulyatory/${c.slug}/index.html`, layout({
    title: c.title, desc: c.desc, path: `/kalkulyatory/${c.slug}/`, current: 'calc',
    body: `<a class="crumb" href="${url('/kalkulyatory/')}">${icon('arrowLeft')} Все калькуляторы</a>
<h1 class="page">${esc(c.title)}</h1><p class="lede">${esc(c.lede)}</p>${c.fn('p')}
<p class="note-sm">Расчёт идёт у вас в браузере, данные никуда не отправляются. Цифры в правилах сверены ${esc(new Date(FIN.checkedAt + 'T12:00:00+03:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' }))}</p>`
  }));
}
write('kalkulyatory/index.html', layout({
  title: 'Калькуляторы', desc: 'Платёж по кредиту, досрочное погашение, доход и налог по вкладам, самозанятый или ИП.', path: '/kalkulyatory/', current: 'calc',
  body: `<h1 class="page">Калькуляторы</h1><p class="lede">Подставьте свои цифры: расчёт происходит у вас в браузере, данные никуда не отправляются.</p>
<ul class="calcs">${CALCS.map((c) => `<li><a href="${url(`/kalkulyatory/${c.slug}/`)}"><b>${esc(c.short)}</b><span>${esc(c.desc)}</span></a></li>`).join('')}</ul>`
}));

// Проверка организации по ИНН. Если задан ORG_API_URL — страница ходит на наш сервер (server/index.mjs): ключи не попадают
// в браузер, и есть ИИ-разбор. Иначе старый режим: ключ DADATA_TOKEN вшивается в страницу при сборке.
write('organizacii/index.html', layout({
  title: 'Проверка организации по ИНН', desc: 'Проверка организации или ИП по ИНН: статус, реквизиты и руководитель из открытых реестров, памятка о налогах и сроках.', path: '/organizacii/', current: 'org',
  body: `<h1 class="page">Проверка организации по ИНН</h1><p class="lede">Введите ИНН организации или ИП: покажем данные из открытых реестров и памятку, о чём стоит помнить.</p>
<section class="calc" id="org" data-api="${esc(process.env.ORG_API_URL || '')}" data-token="${esc(process.env.ORG_API_URL ? '' : (process.env.DADATA_TOKEN || ''))}">
  <form id="org-form" novalidate>
    <label class="f">ИНН (10 или 12 цифр)<input type="text" id="org-inn" inputmode="numeric" maxlength="12" autocomplete="off" placeholder="7707083893"></label>
    <p><button class="btn" type="submit">Проверить</button></p>
  </form>
  <p class="note-sm" id="org-msg" aria-live="polite"></p>
  <div id="org-out"></div>
  <p class="note-sm">Данные берём из открытых реестров через сервис DaData: ИНН отправляется туда для поиска, мы его не храним.${process.env.ORG_API_URL ? ' Разбор готовит ИИ (Google Gemini): ему передаются только сведения об организации из реестра, без ФИО руководителя и адреса.' : ''}${process.env.ORG_API_URL ? ' Памятка и разбор составлены по общим правилам и не являются' : ' Памятка составлена по общим правилам и не является'} налоговой или юридической консультацией. Сроки и суммы сверяйте на nalog.gov.ru.</p>
</section>
<script src="${url('/org.js')}?v=${hashOf('org.js')}" defer></script>`
}));

// Проверка физлица: без API и без данных на сервере — только памятка со ссылками на официальные бесплатные
// реестры (Федресурс, ФССП, «Прозрачный бизнес», реестр залогов). ФИО никуда не отправляется.
write('fizlica/index.html', layout({
  title: 'Проверка физлица', desc: 'Где бесплатно проверить человека: банкротство, долги у приставов, участие в организациях, дисквалификация, залоги.', path: '/fizlica/', current: 'person',
  body: `<h1 class="page">Проверка физлица</h1><p class="lede">Введите ФИО: получите памятку и прямые ссылки на официальные бесплатные реестры, где это можно проверить вручную.</p>
<section class="calc" id="person">
  <form id="person-form" novalidate>
    <label class="f">ФИО<input type="text" id="person-fio" autocomplete="off" placeholder="Иванов Иван Иванович"></label>
    <p><button class="btn" type="submit">Показать памятку</button></p>
  </form>
  <div id="person-out"></div>
  <p class="note-sm">Мы не ищем данные о человеке сами и никуда не отправляем введённое ФИО — оно остаётся у вас в браузере. Ниже только ссылки на официальные государственные реестры.</p>
</section>
<section class="grp"><h2>Защитите себя</h2><ul class="calcs" style="margin-top:12px"><li><a class="danger" href="${url('/fizlica/dropy/')}"><b>Не становитесь дропом</b><span>«Подработка» с переводами через вашу карту: как её распознать, чем грозит с 2025 года и что делать, если вы уже согласились.</span></a></li></ul></section>
<script src="${url('/person.js')}?v=${hashOf('person.js')}" defer></script>`
}));

// Как мы работаем (публичные правила: доверие)
write('kak-my-rabotaem/index.html', layout({
  title: 'Как мы работаем', desc: 'Откуда берутся новости и кто их проверяет.', path: '/kak-my-rabotaem/', current: 'about',
  body: `<h1 class="page">Как мы работаем</h1>
<div class="prose">
<h2>Откуда берутся новости</h2>
<p>Мы берём новости из официальных источников (Банк России, Минфин, ФНС, Социальный фонд) и деловых СМИ (РБК, Интерфакс, ТАСС, Прайм, Коммерсантъ). У каждой карточки есть ссылка на первоисточник, дата и время. Новости из СМИ мы публикуем автоматически только при высокой уверенности программы, а слухи, мнения и прогнозы не пересказываем.</p>
<h2>Кто пишет и проверяет</h2>
<p>Карточку готовит программа с помощью искусственного интеллекта. Обычные новости публикуются автоматически и помечены «подготовлено ИИ»: программа сверяет числа в карточке с текстом первоисточника и проверяет формулировки по правилам (никаких обещаний дохода и призывов «покупайте» или «продавайте»). Редактор такие карточки заранее не читает, поэтому всегда открывайте ссылку на первоисточник. Важные новости (обязательные платежи, сроки, штрафы) и те, в которых программа не уверена, автоматически не публикуются: они ждут проверки человеком, и на такой карточке указано, кто проверил и когда.</p>
<h2>Что значат пометки</h2>
<ul>
<li><b>Важно</b> (бордовая метка): новость меняет обязательные платежи, сроки или влечёт штрафы.</li>
<li><b>Уровень уверенности</b>: насколько надёжен вывод. Если первоисточник неполный, мы пишем об этом прямо.</li>
<li><b>Партнёрская ссылка</b>: сайт получает комиссию, если вы купите материал. Цена для вас не меняется. Редакционные советы от этого не зависят.</li>
</ul>
<h2>Чего мы не делаем</h2>
<p>Мы не даём индивидуальных инвестиционных рекомендаций и не говорим «покупайте» или «продавайте». Наши материалы объясняют, что произошло и какие шаги можно рассмотреть. Решение остаётся за вами.</p>
${site.editorialContact || site.contactEmail ? `<h2>Нашли ошибку</h2><p>Напишите: <a href="mailto:${esc(site.editorialContact || site.contactEmail)}">${esc(site.editorialContact || site.contactEmail)}</a>. Мы исправим и отметим исправление.</p>` : ''}
</div>`
}));

const schemeBlock = (x, h = 'h2') => `<section class="scheme" id="${x.id}"><${h}>${esc(x.t)}</${h}>
<p><b>В чём суть.</b> ${esc(x.what)}</p>
<p><b>Как находят.</b> ${esc(x.how)}</p>
<p class="risk"><b>Чем заканчивается.</b> ${esc(x.risk)}</p></section>`;

// Раздел «Налоги»: законные способы по видам налогов + предупреждения о схемах этого вида
const TAX = taxSections(FIN.regimes || {});
for (const sec of TAX) {
  const warn = SCHEMES.filter((x) => x.tax.includes(sec.slug));
  write(`nalogi/${sec.slug}/index.html`, layout({
    title: sec.title, desc: sec.desc, path: `/nalogi/${sec.slug}/`, current: 'tax',
    body: `<a class="crumb" href="${url('/nalogi/')}">${icon('arrowLeft')} Налоги</a>
<h1 class="page">${esc(sec.title)}</h1><p class="lede">${esc(sec.lede)}</p>
<h2 class="label" style="margin-top:28px">Законные способы</h2>
<div class="ways">${sec.ways.map((w, i) => `<section class="way"><h3><span class="n">${i + 1}</span>${esc(w.t)}</h3>
<p class="who">${esc(w.who)}</p><p>${esc(w.text)}</p>${w.calc ? `<a class="full" href="${url(`/kalkulyatory/${w.calc}/`)}">Посчитать ${icon('arrowRight')}</a>` : ''}</section>`).join('\n')}</div>
${warn.length ? `<h2 class="label" style="margin-top:36px">Так делать нельзя</h2>
<div class="prose">${warn.map((x) => schemeBlock(x, 'h3')).join('\n')}
<p><a href="${url('/nalogovye-shemy/')}">Все опасные схемы и общие последствия</a></p></div>` : ''}
<p class="note-sm">Правила на ${esc(String((FIN.regimes && FIN.regimes.year) || ''))} год, сверены ${esc(new Date(FIN.checkedAt + 'T12:00:00+03:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' }))}. Это не налоговая консультация: перед сменой режима или учётной политики посчитайте всё вместе с бухгалтером. Советы по данным своей компании — в <a href="${url('/organizacii/')}">проверке по ИНН</a>.</p>`
  }));
}
write('nalogi/index.html', layout({
  title: 'Налоги', path: '/nalogi/', current: 'tax',
  desc: 'Как законно снизить налоги малому бизнесу: режимы, НДС, налог на прибыль, взносы с зарплаты, налоги владельца. И какие схемы опасны.',
  body: `<h1 class="page">Налоги</h1><p class="lede">Законные способы платить меньше, по видам налогов, и схемы, за которые доначисляют налоги и штрафы.</p>
<ul class="calcs">${TAX.map((t) => `<li><a href="${url(`/nalogi/${t.slug}/`)}"><b>${esc(t.short)}</b><span>${esc(t.desc)}</span></a></li>`).join('')}
<li><a href="${url('/nalogi/blokirovka-scheta/')}"><b>Блокировка счёта по 115-ФЗ</b><span>За какие операции банки блокируют счета, как узнать свою зону риска на платформе ЦБ и как снять ограничения.</span></a></li>
<li><a class="danger" href="${url('/nalogovye-shemy/')}"><b>Опасные схемы</b><span>Дробление бизнеса, «технические» компании, зарплата в конвертах и другое: как находят и чем заканчивается.</span></a></li></ul>
<p class="note-sm">Советы для конкретной компании по данным реестра — в <a href="${url('/organizacii/')}">проверке организации по ИНН</a>.</p>`
}));

// Предупреждения: дропы (для людей) и блокировки по 115-ФЗ (для бизнеса). Факты сверены 25.09.2026
const card = (h, items) => `<h2>${h}</h2><ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>`;
write('fizlica/dropy/index.html', layout({
  title: 'Не становитесь дропом: чем грозит «подработка» с вашей картой', path: '/fizlica/dropy/', current: 'person',
  desc: 'Как распознать предложение стать дропом, какая ответственность грозит с 2025 года, что будет с картами и что делать, если вы уже согласились.',
  body: `<a class="crumb" href="${url('/fizlica/')}">${icon('arrowLeft')} Физлица</a>
<h1 class="page">Не становитесь дропом</h1>
<p class="lede">Дроп — человек, через чью карту или счёт мошенники проводят украденные деньги. Чаще всего дропами становятся студенты, пенсионеры и те, кто ищет подработку. С 5 июля 2025 года за это грозит уголовная ответственность.</p>
<div class="prose">
${card('Как выглядит предложение', [
  '«Подработка»: принимать деньги на свою карту и переводить дальше или снимать наличными за процент.',
  '«Сдайте карту в аренду» или «оформите карту на себя и передайте нам» за разовую плату.',
  'Просьба знакомого или человека из чата «помочь с переводом», потому что у него «заблокирован банк».',
  'Работа «оператором обменника» или «процессинга»: принимать переводы от людей и отправлять криптовалюту.',
  '«Вам по ошибке пришли деньги, верните их на другую карту». Это частый способ сделать дропом человека, который ни на что не соглашался.'
])}
${card('Чем это грозит', [
  '<b>Уголовная ответственность</b> по статье 187 УК (части 3–6 добавлены законом № 176-ФЗ от 24.06.2025): за передачу карты или доступа к онлайн-банку за вознаграждение — например, штраф от 100 000 до 300 000 ₽, а по самым тяжёлым составам, например в составе группы, — до 6 лет лишения свободы со штрафом до 1 млн ₽.',
  '<b>База ЦБ.</b> Банки передают сведения о дропах в Банк России. Людям из этой базы ограничивают карты и онлайн-банк: переводить онлайн можно не больше 100 000 ₽ в месяц, остальные операции — только в отделении с паспортом. Ограничения действуют во всех банках сразу.',
  '<b>Долг перед пострадавшими.</b> Пострадавшие через суд взыскивают полученные деньги с владельца карты как неосновательное обогащение, даже если он оставил себе только «процент».'
])}
${card('Если вы уже согласились', [
  'Сразу прекратите: не принимайте и не переводите больше ни рубля.',
  'Позвоните в банк: заблокируйте карту, перевыпустите её, смените пароли и выйдите из онлайн-банка на чужих устройствах.',
  'Сохраните переписку и реквизиты тех, кто вас нанял, и обратитесь в полицию. Тот, кто впервые попал в такую схему, освобождается от уголовной ответственности, если добровольно сообщит о преступлении и поможет его раскрыть.',
  'Поговорите с юристом до того, как вас вызовут на допрос.'
])}
${card('Если деньги пришли по ошибке', [
  'Не переводите их обратно сами, особенно на другую карту или по номеру, который вам продиктовали.',
  'Обратитесь в свой банк: он вернёт перевод отправителю по своим правилам.'
])}
${card('Если вы попали в базу по ошибке', [
  'Обратитесь с документами в свой банк или в интернет-приёмную Банка России на cbr.ru и попросите исключить вас из базы.',
  'Пока ограничения действуют, деньгами можно распоряжаться в отделении банка с паспортом.'
])}
<p class="note-sm">Это не юридическая консультация. Правила сверены ${esc(new Date(FIN.checkedAt + 'T12:00:00+03:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' }))}.</p>
</div>`
}));

write('nalogi/blokirovka-scheta/index.html', layout({
  title: 'Как не попасть под блокировку счёта по 115-ФЗ', path: '/nalogi/blokirovka-scheta/', current: 'tax',
  desc: 'За какие операции банки блокируют счета бизнеса по 115-ФЗ, что такое красная зона платформы «Знай своего клиента» и как снять ограничения.',
  body: `<a class="crumb" href="${url('/nalogi/')}">${icon('arrowLeft')} Налоги</a>
<h1 class="page">Как не попасть под блокировку счёта по 115-ФЗ</h1>
<p class="lede">Закон 115-ФЗ обязывает банки следить за сомнительными операциями. Банк может приостановить платёж, отключить онлайн-банк, отказать в операции и закрыть счёт. Чаще всего под это попадают честные компании и ИП, которые просто не знают, как выглядят их операции со стороны.</p>
<div class="prose">
${card('На что смотрят банки', [
  '<b>Транзит.</b> Деньги пришли и почти сразу ушли дальше, а на счёте ничего не остаётся.',
  '<b>Наличные.</b> Регулярное снятие крупных сумм, особенно сразу после поступлений.',
  '<b>Переводы физлицам.</b> Много платежей на карты людей, в том числе себе как ИП.',
  '<b>Мало налогов.</b> Уплаченные налоги и взносы слишком малы для такого оборота.',
  '<b>Нет обычных расходов.</b> Не видно аренды, зарплаты, коммунальных платежей, закупок, типичных для вашей деятельности.',
  '<b>Операции не по профилю.</b> Платежи не соответствуют видам деятельности (ОКВЭД) в реестре.',
  '<b>Размытое назначение платежа.</b> «Оплата по договору» без номера и предмета, «за товар» без счёта.'
])}
<h2>Светофор ЦБ: платформа «Знай своего клиента»</h2>
<p>С 1 июля 2022 года Банк России относит каждую компанию и ИП к одной из трёх групп риска: низкий («зелёная»), средний («жёлтая») или высокий («красная»). Банки видят эту оценку. С красной зоной банк отключает дистанционное обслуживание и может заблокировать карты и почти все операции, причём одновременно во всех банках.</p>
<p>Узнать свою зону можно по ИНН на сайте Банка России в разделе «Платформа „Знай своего клиента“», а также через свой банк.</p>
${card('Если счёт заблокировали', [
  'Запросите у банка, какие операции вызвали вопросы и какие документы нужны.',
  'Ответьте в срок и с документами: договоры, счета, акты, накладные, переписка, объяснение экономического смысла операции.',
  'Если вы в красной зоне или банк отказал, подайте жалобу в Межведомственную комиссию при Банке России через интернет-приёмную на cbr.ru. Сделать это нужно в течение полугода после того, как вы узнали об ограничениях; комиссия рассматривает обращение до 20 рабочих дней.',
  'Если комиссия поддержала вас, банки снимают ограничения.'
])}
${card('Как не попасть под блокировку', [
  'Пишите в назначении платежа номер и дату договора или счёта и что оплачивается.',
  'Храните первичные документы по каждой операции и отвечайте на запросы банка быстро.',
  'Платите налоги, взносы, зарплату и аренду со своего расчётного счёта, чтобы банк видел обычную деятельность.',
  'Не снимайте наличные без необходимости и не выводите деньги на карты физлиц, включая свою, большими суммами сразу после поступлений.',
  'Проверяйте контрагентов: платежи фирмам из красной зоны ухудшают и вашу оценку.',
  'Держите в реестре те виды деятельности, которыми реально занимаетесь.'
])}
<p>Подробные признаки есть в методических рекомендациях Банка России для предпринимателей. Проверить контрагента по открытым данным можно в <a href="${url('/organizacii/')}">проверке организации по ИНН</a>. Схемы, из-за которых блокируют счета, описаны на странице <a href="${url('/nalogovye-shemy/')}#cash-out">«Опасные налоговые схемы»</a>.</p>
<p class="note-sm">Это не юридическая консультация. Правила сверены ${esc(new Date(FIN.checkedAt + 'T12:00:00+03:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' }))}.</p>
</div>`
}));

// Опасные налоговые схемы: не инструкция, а предупреждение — в чём схема, как её находят и чем она кончается
write('nalogovye-shemy/index.html', layout({
  title: 'Опасные налоговые схемы: чего не делать', path: '/nalogovye-shemy/', current: 'tax',
  desc: 'Дробление бизнеса, «технические» компании, сотрудники-самозанятые, зарплата в конвертах: как налоговая находит схемы и чем они заканчиваются.',
  body: `<a class="crumb" href="${url('/nalogi/')}">${icon('arrowLeft')} Налоги</a>
<h1 class="page">Опасные налоговые схемы</h1>
<p class="lede">Чем заканчиваются популярные способы «сэкономить» на налогах. Здесь нет инструкций: только в чём суть, по каким признакам налоговая это находит и что за это бывает. Законные способы снизить налоги собраны в разделе <a href="${url('/nalogi/')}">«Налоги»</a>.</p>
<div class="prose">
${SCHEMES.map((x) => schemeBlock(x)).join('\n')}
<h2>Общие последствия</h2>
<ul>
<li>Недоимка, пени за каждый день просрочки и штраф: 20% от неуплаченного налога, 40% при умысле (статья 122 НК).</li>
<li>Уголовная ответственность, если неуплата за три года подряд больше 18,75 млн ₽ для организации (статья 199 УК) или 2,7 млн ₽ для ИП и физлиц (статья 198 УК).</li>
<li>Налоги, которые компания не может заплатить, взыскивают с директора и владельцев через субсидиарную ответственность.</li>
</ul>
<h2>Если схема уже есть</h2>
<p>Лучше исправиться до проверки: подать уточнённые декларации и доплатить налог с пенями. Тогда штрафа можно избежать. Поговорите с налоговым консультантом или юристом до того, как придёт требование.</p>
<p class="note-sm">Это не юридическая и не налоговая консультация. Суммы и правила действуют на ${esc(String((FIN.regimes && FIN.regimes.year) || ''))} год.</p>
</div>`
}));

// 404
write('404.html', layout({
  title: 'Страница не найдена', path: '/404.html', current: '',
  body: `<h1 class="page">Страница не найдена</h1><p class="lede">Возможно, адрес изменился. <a href="${url('/')}" style="color:var(--accent)">Вернуться к новостям</a>.</p>`
}));

// О проекте: кто делает сайт и как связаться
write('o-proekte/index.html', layout({
  title: 'О проекте', desc: 'Что такое «Суть», для кого этот сайт и как связаться с редакцией.', path: '/o-proekte/', current: '',
  body: `<h1 class="page">О проекте</h1>
<div class="prose">
<p>«Суть» — сайт об экономических новостях для обычных людей и малого бизнеса. Мы берём новости из официальных источников и деловых СМИ и объясняем простым языком: что случилось, кого это касается и что можно сделать в своих делах.</p>
<h2>Что есть на сайте</h2>
<ul>
<li><b>Новости за сутки</b> с разбором для заёмщиков, вкладчиков, самозанятых и малого бизнеса. У каждой новости есть ссылка на первоисточник.</li>
<li><b>Проверка организации по ИНН</b>: данные из открытых реестров и памятка о налогах и сроках.</li>
<li><b>Калькуляторы</b> платежа по кредиту и дохода по вкладу. Расчёт идёт у вас в браузере.</li>
</ul>
<h2>Кто делает сайт</h2>
<p>Сайт ведёт редакция «Сути». Новости готовит программа с помощью искусственного интеллекта по строгим правилам, важные новости перед публикацией проверяет редакция. Подробно об этом — на странице <a href="${url('/kak-my-rabotaem/')}">«Как мы работаем»</a>.</p>
<h2>Чем мы не являемся</h2>
<p>Мы не банк, не брокер и не финансовый консультант. Материалы сайта носят информационный характер и не являются индивидуальной финансовой, налоговой или юридической рекомендацией.</p>
${site.editorialContact || site.contactEmail ? `<h2>Контакты</h2><p>Вопросы, ошибки в новостях и предложения: <a href="mailto:${esc(site.editorialContact || site.contactEmail)}">${esc(site.editorialContact || site.contactEmail)}</a>.</p>` : ''}
</div>`
}));

// RSS: последние 30 новостей — для Дзена, агрегаторов и читалок
if (!site.siteUrl.includes('example')) {
  const xml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const items = cards.slice(0, 30).map((c) => `<item>
  <title>${xml(c.title)}</title>
  <link>${site.siteUrl}/n/${c.id}/</link>
  <guid isPermaLink="true">${site.siteUrl}/n/${c.id}/</guid>
  <pubDate>${new Date(c.publishedAt).toUTCString()}</pubDate>
  <category>${xml(c.source.name)}</category>
  <description>${xml(c.gloss + ' Что делать: ' + c.tip)}</description>
  <content:encoded><![CDATA[<p>${esc(c.summary)}</p><p><b>Что это значит:</b> ${esc(c.gloss)}</p><p><b>Что делать:</b> ${esc(c.tip)}</p><p>Источник: <a href="${esc(c.source.url)}">${esc(c.source.name)}</a></p>]]></content:encoded>
</item>`).join('\n');
  write('rss.xml', `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${xml(site.name)}: ${xml(site.tagline)}</title>
<link>${site.siteUrl}/</link>
<atom:link href="${site.siteUrl}/rss.xml" rel="self" type="application/rss+xml"/>
<description>${xml(site.tagline)}</description>
<language>ru</language>
${cards.length ? `<lastBuildDate>${new Date(cards[0].publishedAt).toUTCString()}</lastBuildDate>` : ''}
${items}
</channel>
</rss>
`);
}

// robots и sitemap
write('robots.txt', `User-agent: *\nAllow: /\n${site.siteUrl.includes('example') ? '' : `Sitemap: ${site.siteUrl}/sitemap.xml\n`}`);
if (!site.siteUrl.includes('example')) {
  // lastmod: у ленты — время свежей новости, у карточки — время последней правки; у статичных страниц не ставим
  const fresh = cards.length ? cards[0].publishedAt : '';
  const urls = [
    ['/', fresh], ['/arhiv/', fresh], ['/kalkulyatory/'], ...CALCS.map((c) => [`/kalkulyatory/${c.slug}/`]), ['/organizacii/'], ['/fizlica/'], ['/nalogi/'], ...TAX.map((t) => [`/nalogi/${t.slug}/`]), ['/nalogovye-shemy/'], ['/nalogi/blokirovka-scheta/'], ['/fizlica/dropy/'], ['/kak-my-rabotaem/'], ['/o-proekte/'],
    ...cards.map((c) => [`/n/${c.id}/`, (c.review && c.review.at) || c.publishedAt])
  ];
  write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([u, m]) => `<url><loc>${site.siteUrl}${u}</loc>${m ? `<lastmod>${new Date(m).toISOString()}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>\n`);
}

console.log(`Сайт собран: ${cards.length} новостей, ${materials.length} материалов -> dist/`);

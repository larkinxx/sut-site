// Сборка сайта: content/ + config/ + public/  ->  dist/
// Запуск: npm run build          (только проверенные опубликованные новости)
//         npm run preview        (с демо-примерами и локальным просмотром)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, loadSite, loadCards, loadMaterials } from './lib/content.mjs';
import { AUDIENCES, AUDIENCE_TABS, esc, markTitle, dateRu, agoRu } from './lib/util.mjs';

const withExamples = process.argv.includes('--examples');
const site = loadSite();
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
for (const f of fs.readdirSync(path.join(ROOT, 'public'))) {
  fs.copyFileSync(path.join(ROOT, 'public', f), path.join(DIST, f));
}

// ---------- шаблон страницы ----------
const NAV = [
  ['/', 'Новости', 'news'],
  ['/kalkulyatory/', 'Калькуляторы', 'calc'],
  ['/kak-my-rabotaem/', 'Как мы работаем', 'about']
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
<meta name="theme-color" content="#0B1325">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=PT+Serif:wght@400;700&family=Source+Serif+4:wght@400;500;600&family=Source+Sans+3:wght@400;500;600&display=swap">
<link rel="stylesheet" href="${url('/style.css')}?v=${cssV}">
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
  </div>
</header>
<main class="wrap" id="main">
${body}
</main>
<footer class="wrap">
  <p class="fine">${esc(site.disclaimer)} Как мы готовим новости и отбираем курсы: <a href="${url('/kak-my-rabotaem/')}">как мы работаем</a>.${site.contactEmail ? ` Нашли ошибку? Напишите: <a href="mailto:${esc(site.contactEmail)}">${esc(site.contactEmail)}</a>.` : ''}</p>
</footer>
<script src="${url('/app.js')}?v=${jsV}" defer></script>
</body>
</html>
`;
}

// ---------- блоки ----------
const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.8"/></svg>';
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
    <a class="full" href="${cardUrl(c)}">Полный разбор →</a>
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
  ${site.telegramUrl ? `<div class="sublinks"><a class="full" href="${esc(site.telegramUrl)}" rel="noopener">Читать в Telegram →</a></div>` : ''}
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

// ---------- страницы ----------
// Главная: лента за 24 часа
{
  const list = cards.map(feedItem).join('\n');
  const body = `<h1 class="page">Новости за ${site.windowHours} ${site.windowHours === 24 ? 'часа' : 'часов'}</h1>
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
  const calc = c.calc === 'mortgage' ? calcMortgage(c.id.slice(-4)) : c.calc === 'deposit' ? calcDeposit(c.id.slice(-4)) : '';
  const conf = {
    high: ['lvl-h', 'Высокая', 'Факт подтверждён первоисточником, цифры сверены редактором.'],
    medium: ['lvl-m', 'Средняя', 'Факт подтверждён, но часть выводов зависит от условий конкретного договора или решения.'],
    low: ['lvl-l', 'Низкая', 'Первоисточник неполный или выводы предварительные: сверяйтесь с оригиналом.']
  }[c.confidence];
  const learn = materialsFor(c.topics || []);
  const body = `<a class="crumb" href="${url('/')}">← Все новости</a>
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
<p class="note-sm">Материалы отбираются по <a href="${url('/kak-my-rabotaem/')}" style="color:var(--accent)">публичным критериям</a>. Метка «Партнёрская ссылка» значит, что сайт получает комиссию.</p></section>` : ''}
${subscribeBlock()}`;
  const ld = {
    '@context': 'https://schema.org', '@type': 'NewsArticle', headline: c.title,
    datePublished: c.publishedAt, inLanguage: 'ru', description: c.gloss,
    publisher: { '@type': 'Organization', name: site.name }, isBasedOn: c.source.url
  };
  write(`n/${c.id}/index.html`, layout({ title: c.title, desc: c.gloss, path: `/n/${c.id}/`, current: 'news', body, ld }));
}

// Калькуляторы
write('kalkulyatory/index.html', layout({
  title: 'Калькуляторы', desc: 'Платёж по кредиту и доход по вкладу.', path: '/kalkulyatory/', current: 'calc',
  body: `<h1 class="page">Калькуляторы</h1><p class="lede">Подставьте свои цифры: расчёт происходит у вас в браузере, данные никуда не отправляются.</p>${calcMortgage('p')}${calcDeposit('p')}`
}));

// Как мы работаем (публичные правила: доверие)
write('kak-my-rabotaem/index.html', layout({
  title: 'Как мы работаем', desc: 'Откуда берутся новости, кто их проверяет и как мы отбираем курсы.', path: '/kak-my-rabotaem/', current: 'about',
  body: `<h1 class="page">Как мы работаем</h1>
<div class="prose">
<h2>Откуда берутся новости</h2>
<p>Мы берём новости из официальных источников (Банк России) и делового издания РБК. У каждой карточки есть ссылка на первоисточник, дата и время. Новости из СМИ мы публикуем автоматически только при высокой уверенности программы, а слухи, мнения и прогнозы не пересказываем.</p>
<h2>Кто пишет и проверяет</h2>
<p>Карточку готовит программа с помощью искусственного интеллекта. Обычные новости публикуются автоматически и помечены «подготовлено ИИ»: программа сверяет числа в карточке с текстом первоисточника и проверяет формулировки по правилам (никаких обещаний дохода и призывов «покупайте» или «продавайте»). Редактор такие карточки заранее не читает, поэтому всегда открывайте ссылку на первоисточник. Важные новости (обязательные платежи, сроки, штрафы) и те, в которых программа не уверена, автоматически не публикуются: они ждут проверки человеком, и на такой карточке указано, кто проверил и когда.</p>
<h2>Что значат пометки</h2>
<ul>
<li><b>Важно</b> (бордовая метка): новость меняет обязательные платежи, сроки или влечёт штрафы.</li>
<li><b>Уровень уверенности</b>: насколько надёжен вывод. Если первоисточник неполный, мы пишем об этом прямо.</li>
<li><b>Партнёрская ссылка</b>: сайт получает комиссию, если вы купите материал. Цена для вас не меняется. Редакционные советы от этого не зависят.</li>
</ul>
<h2>Как мы отбираем курсы и видео</h2>
<p>Материал попадает на сайт, только если автор письменно согласился на размещение и выполнены условия:</p>
<ul>
<li>у автора есть подтверждаемый опыт в теме;</li>
<li>нет обещаний гарантированного или быстрого дохода;</li>
<li>понятны программа, цена и условия возврата;</li>
<li>указана дата обновления: экономические курсы быстро устаревают.</li>
</ul>
<p>Мы убираем материал по обоснованной жалобе.</p>
<h2>Чего мы не делаем</h2>
<p>Мы не даём индивидуальных инвестиционных рекомендаций и не говорим «покупайте» или «продавайте». Наши материалы объясняют, что произошло и какие шаги можно рассмотреть. Решение остаётся за вами.</p>
${site.editorialContact || site.contactEmail ? `<h2>Нашли ошибку</h2><p>Напишите: <a href="mailto:${esc(site.editorialContact || site.contactEmail)}">${esc(site.editorialContact || site.contactEmail)}</a>. Мы исправим и отметим исправление.</p>` : ''}
</div>`
}));

// 404
write('404.html', layout({
  title: 'Страница не найдена', path: '/404.html', current: '',
  body: `<h1 class="page">Страница не найдена</h1><p class="lede">Возможно, адрес изменился. <a href="${url('/')}" style="color:var(--accent)">Вернуться к новостям</a>.</p>`
}));

// robots и sitemap
write('robots.txt', `User-agent: *\nAllow: /\n${site.siteUrl.includes('example') ? '' : `Sitemap: ${site.siteUrl}/sitemap.xml\n`}`);
if (!site.siteUrl.includes('example')) {
  const urls = ['/', '/arhiv/', '/kalkulyatory/', '/kak-my-rabotaem/', ...cards.map((c) => `/n/${c.id}/`)];
  write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${site.siteUrl}${u}</loc></url>`).join('\n')}\n</urlset>\n`);
}

console.log(`Сайт собран: ${cards.length} новостей, ${materials.length} материалов -> dist/`);

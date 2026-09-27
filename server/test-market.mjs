// Тесты статистики похожих компаний без сети: импорт реестра МСП и доходов/расходов, группы, API.
// Запуск: node server/test-market.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApp } from './index.mjs';
import { openFnsDb, importStream } from '../scripts/fns-import.mjs';
import { buildPeers } from '../scripts/fns-peers.mjs';
import { marketStats, orgPeers, orgForecast, valueAt, percentile, MIN_GROUP } from './market.mjs';
import { renderCompany } from './company-page.mjs';
import { createIndustryPages, topCompanies, industryUrls } from './industry-pages.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok  ', name); };
const file = (docs) => `<?xml version="1.0" encoding="UTF-8"?><Файл ИдФайл="f" ВерсФорм="4.02"><ИдОтпр/>${docs.join('')}</Файл>`;
const chunks = (s) => Readable.from([s.slice(0, 301), s.slice(301)]);
const inn = (i) => String(5400000000 + i);

// Реестр МСП: организация и ИП (ИП пропускаем — по ним нет отчётности)
const msp = (id, okved, region, since) => `<Документ ИдДок="${id}" ДатаСост="10.09.2026" ДатаВклМСП="${since}" ВидСубМСП="1" КатСубМСП="1" ПризНовМСП="2">` +
  `<ОргВклМСП НаимОрг="ООО &quot;КОМПАНИЯ ${id}&quot;" ИННЮЛ="${id}"/><СведМН КодРегион="${region}"><Регион Тип="ОБЛАСТЬ" Наим="НОВОСИБИРСКАЯ"/></СведМН>` +
  `<СвОКВЭД><СвОКВЭДОсн КодОКВЭД="${okved}" НаимОКВЭД="Деятельность ресторанов" ВерсОКВЭД="2014"/><СвОКВЭДДоп КодОКВЭД="47.11"/></СвОКВЭД></Документ>`;
const ip = `<Документ ИдДок="ip" ДатаСост="10.09.2026" ДатаВклМСП="10.01.2020" КатСубМСП="1"><ИПВклМСП ИННФЛ="540000000001"><ФИОИП Фамилия="ИВАНОВ"/></ИПВклМСП>` +
  `<СведМН КодРегион="54"/><СвОКВЭД><СвОКВЭДОсн КодОКВЭД="56.10"/></СвОКВЭД></Документ>`;
const fin = (id, income, expense) => `<Документ ИдДок="${id}" ДатаДок="01.06.2026" ДатаСост="31.12.2025"><СведНП НаимОрг="ООО" ИННЮЛ="${id}"/>` +
  `<СведДохРасх СумДоход="${income}" СумРасход="${expense}"/></Документ>`;

// Новосибирск (54), рестораны (56.10): по 30 компаний возрастом 0, 2 и 6 лет на 31.12.2025, выручка растёт с возрастом.
// Москва (77): 25 компаний, только старые. Отрасль 62 — всего 5 компаний: мало для статистики.
const docs = [], fins = [];
let k = 0;
for (const [since, base] of [['10.06.2025', 1e6], ['10.03.2023', 5e6], ['10.08.2016', 20e6]]) {
  for (let i = 0; i < 30; i++, k++) {
    docs.push(msp(inn(k), '56.10', '54', since));
    const income = base * (1 + i / 10), expense = income * (i < 12 ? 1.1 : 0.9);   // 12 из 30 — в убытке
    fins.push(fin(inn(k), income.toFixed(2), expense.toFixed(2)));
  }
}
for (let i = 0; i < 25; i++, k++) { docs.push(msp(inn(k), '56.10', '77', '10.08.2016')); fins.push(fin(inn(k), '30000000.00', '27000000.00')); }
for (let i = 0; i < 5; i++, k++) { docs.push(msp(inn(k), '62.01', '54', '10.08.2016')); fins.push(fin(inn(k), '1000000.00', '500000.00')); }
docs.push(msp(inn(k++), '56.10', '54', '10.09.2026'));   // зарегистрирована после отчётного года — отчётности нет

const db = openFnsDb(':memory:');
await t('импорт реестра МСП и доходов/расходов; ИП пропускаются', async () => {
  assert.equal(await importStream(db, 'rsmp', chunks(file([...docs, ip]))), docs.length);
  assert.equal(db.prepare('SELECT name FROM fns_name WHERE inn = ?').get(inn(0)).name, 'ООО "КОМПАНИЯ 5400000000"', 'название из ОргВклМСП');
  assert.equal(await importStream(db, 'revexp', chunks(file(fins))), fins.length);
  const m = db.prepare('SELECT * FROM fns_msp WHERE inn = ?').get(inn(0));
  assert.deepEqual({ ...m }, { inn: inn(0), okved: '56.10', region: '54', since: '2025-06-10', category: 1, asof: '2026-09-10' });
  assert.deepEqual({ ...db.prepare('SELECT * FROM fns_finance WHERE inn = ?').get(inn(0)) }, { inn: inn(0), income: 1e6, expense: 1100000, asof: '2025-12-31' });
});

await t('формат изменился (нет ОКВЭД и региона) — импорт падает, а не пишет пустоту', async () => {
  const bad = docs.slice(0, 10).map((d) => d.replace(/<СведМН.*<\/СвОКВЭД>/, ''));
  await assert.rejects(importStream(openFnsDb(':memory:'), 'rsmp', chunks(file(bad))), /нет нужных полей/);
});

await t('статистика по группам: возраст, регион, вся Россия', () => {
  assert.ok(buildPeers(db) > 0);
  const s = marketStats(db, { okved: '56.10', region: '54' });
  assert.equal(s.okved, '56');
  assert.equal(s.total.scope, 'region');
  assert.equal(s.total.companies, 91, '90 с отчётностью + 1 новая без неё');
  assert.equal(s.total.withReports, 90);
  assert.deepEqual(s.byAge.map((x) => x.age), [0, 2, 5], 'только группы, где есть данные');
  const [y0, y2, y5] = s.byAge;
  assert.equal(y0.label, 'первый год');
  assert.equal(y0.profitableShare, 0.6, '18 из 30 в плюсе');
  assert.ok(y0.income[2] < y2.income[2] && y2.income[2] < y5.income[2], 'медиана выручки растёт с возрастом');
  assert.ok(y0.income[0] <= y0.income[1] && y0.income[3] <= y0.income[4], 'квантили по возрастанию');
  assert.equal(s.competition.companies, 91);
  assert.equal(s.competition.newShare, Math.round((31 / 91) * 1000) / 1000, 'новые: 30 первого года + 1 зарегистрированная после отчётного года');
  assert.deepEqual(s.competition.history, [{ month: '2026-09', n: 91 }]);
});

await t('мало компаний в регионе — берётся та же отрасль по России; совсем мало — данных нет', () => {
  const msk = marketStats(db, { okved: '56', region: '77' });
  assert.equal(msk.total.scope, 'region', `в Москве ${MIN_GROUP}+ компаний`);
  assert.deepEqual(msk.byAge.map((x) => `${x.age}:${x.scope}`), ['0:russia', '2:russia', '5:region'], 'молодых компаний в Москве нет — по ним вся Россия, с пометкой');
  const tomsk = marketStats(db, { okved: '56', region: '70' });
  assert.equal(tomsk.total.scope, 'russia');
  assert.equal(tomsk.competition.companies, 0);
  assert.equal(marketStats(db, { okved: '62', region: '54' }), null, '5 компаний — статистику не показываем');
  assert.equal(marketStats(db, { okved: 'рестораны' }), null);
});

await t('компании с кодом региона «00» (в реестре так бывает) — статистика считается, попадают только в «всю Россию»', async () => {
  const db7 = openFnsDb(':memory:');
  const zz = Array.from({ length: 25 }, (_, i) => msp(String(7800000000 + i), '56.10', '00', '10.08.2016'));
  const zf = Array.from({ length: 25 }, (_, i) => fin(String(7800000000 + i), '5000000.00', '4000000.00'));
  await importStream(db7, 'rsmp', chunks(file([...docs, ...zz])));
  await importStream(db7, 'revexp', chunks(file([...fins, ...zf])));
  assert.ok(buildPeers(db7) > 0, 'без UNIQUE constraint failed');
  const rus = db7.prepare("SELECT n FROM fns_peers WHERE okved = '56' AND region = '00' AND age = -1").get().n;
  assert.equal(rus, 91 + 25 + 25, 'Новосибирск, Москва и «00» — все в России');
});

await t('процентиль: между квантилями, за краями, одинаковые квантили', () => {
  const q = [10, 20, 30, 40, 50];
  assert.equal(percentile(30, q), 50);
  assert.equal(percentile(25, q), 38);
  assert.equal(percentile(5, q), 5);
  assert.equal(percentile(60, q), 95);
  assert.equal(percentile(10, [10, 10, 10, 20, 30]), 10);
  assert.equal(percentile(null, q), null);
});

await t('компания против похожих', () => {
  const p = orgPeers(db, inn(59));   // старшая в группе 2 лет: выручка 5 млн × 3.9, в плюсе
  assert.equal(p.age, 2);
  assert.equal(p.scope, 'region');
  assert.ok(p.incomePercentile >= 90 && p.profitPercentile >= 90);
  const low = orgPeers(db, inn(30));  // самая маленькая выручка в той же группе, в убытке
  assert.ok(low.incomePercentile <= 10 && low.profit < 0);
  assert.equal(orgPeers(db, inn(k - 1)), null, 'нет отчётности');
  assert.equal(orgPeers(db, '7700000000'), null);
  assert.equal(orgPeers(openFnsDb(':memory:'), inn(0)), null, 'пустая база');
});

await t('страница компании: сравнение с отраслью видно поисковикам', () => {
  const tpl = '<head><title>x</title><meta name="description" content=""></head><div id="org-out" aria-live="polite"></div>';
  const h = renderCompany(tpl, { inn: inn(59), siteUrl: 'https://inn-sider.ru', f: { name: 'ООО "ТЕСТ"', regime: 'УСН' }, party: null, peers: orgPeers(db, inn(59)) });
  assert.match(h, /Среди похожих компаний/);
  assert.match(h, /"@type":"BreadcrumbList"/);
  assert.match(h, /href="\/otrasli\/56\/54\/"/, 'ссылка на страницу отрасли');
  assert.match(h, /выше, чем у \d+%/);
  assert.match(h, /<meta name="description" content="[^"]*доходы выше, чем у \d+% похожих компаний/);
  assert.match(h, /perspektivy-biznesa\/#calc=prospects&amp;code=/);
  const plain = renderCompany(tpl, { inn: inn(59), siteUrl: 'https://inn-sider.ru', f: { name: 'ООО "ТЕСТ"', regime: 'УСН' }, party: null });
  assert.doesNotMatch(plain, /Среди похожих/, 'без статистики блока нет');
});

await t('страницы отраслей: статистика, крупнейшие компании, карта сайта', async () => {
  const top = topCompanies(db, '56', '54', 5);
  assert.equal(top.length, 5);
  assert.ok(top[0].income >= top[1].income, 'по убыванию доходов');
  assert.equal(topCompanies(db, '56', '00').length, 20, 'по России — топ-20');
  const urls = industryUrls(db);
  assert.ok(urls.includes('/otrasli/') && urls.includes('/otrasli/56/') && urls.includes('/otrasli/56/54/'));
  assert.ok(!urls.includes('/otrasli/62/54/'), 'мало данных — страницы нет');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otr-'));
  fs.mkdirSync(path.join(dir, 'otrasli'));
  fs.writeFileSync(path.join(dir, 'otrasli', 'index.html'), '<head><title>x</title><meta name="description" content=""><link rel="canonical" href="x"></head><!--ssr:intro--><h1>x</h1><!--/ssr:intro--><!--ssr:body--><p>…</p><!--/ssr:body-->');
  const handle = createIndustryPages({ env: { SITE_DIST: dir, SITE_URL: 'https://inn-sider.ru' }, fdb: db });
  const get = (p) => { let code, body = '', hdr; const res = { writeHead: (c, h) => { code = c; hdr = h; }, end: (b) => { body = b || ''; } }; const ok = handle({ method: 'GET' }, res, new URL('https://x' + p)); return { ok, code, body, hdr }; };
  const r = get('/otrasli/56/54/');
  assert.equal(r.code, 200);
  assert.match(r.body, /<title>Кафе, рестораны, доставка еды — Республика|<title>Кафе, рестораны, доставка еды — [^<]+: сколько зарабатывают/);
  assert.match(r.body, /Крупнейшие организации по доходам/);
  assert.match(r.body, /href="\/organizacii\/54000000\d\d\/"/);
  assert.match(r.body, /"@type":"BreadcrumbList"/);
  assert.match(r.body, /<link rel="canonical" href="https:\/\/inn-sider.ru\/otrasli\/56\/54\/"/);
  assert.equal(get('/otrasli/62/54/').code, 404, 'мало данных — 404 с noindex');
  assert.equal(get('/otrasli/99/54/').code, 404, 'нет такой отрасли в списке');
  assert.equal(get('/otrasli/').code, 200);
  assert.equal(get('/otrasli/56').code, 301);
  assert.match(get('/sitemap-otrasli.xml').body, /<loc>https:\/\/inn-sider.ru\/otrasli\/56\/54\/<\/loc>/);
  assert.equal(get('/organizacii/').ok, false, 'чужие адреса не трогаем');
  fs.rmSync(dir, { recursive: true });
});

await t('прогноз компании: то же место среди сверстников через 1–3 года', async () => {
  assert.equal(valueAt(50, [10, 20, 50, 80, 100]), 50);
  assert.equal(valueAt(37.5, [10, 20, 50, 80, 100]), 35);
  const f = orgForecast(db, inn(59));   // сильная компания третьего года
  assert.equal(f.ageNow, 2);
  assert.ok(f.steps.length >= 1, 'есть хотя бы один следующий год с данными');
  const last = f.steps[f.steps.length - 1];
  assert.equal(last.age, 5);
  assert.ok(last.income.mid > f.income, 'у старших компаний доходы выше — прогноз растёт');
  assert.ok(last.income.low <= last.income.mid && last.income.mid <= last.income.high);
  assert.equal(orgForecast(db, '7700000000'), null);
  const srv = http.createServer(createApp({ env: {}, fnsDb: db })); await new Promise((r) => srv.listen(0, r));
  try {
    const post = (body) => fetch(`http://127.0.0.1:${srv.address().port}/api/forecast`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
    assert.equal((await post({ inn: '123' }))[0], 400);
    assert.equal((await post({ inn: '540000000001' }))[0], 400, 'ИНН ИП — нет отчётности');
  } finally { srv.close(); }
});

await t('API /api/market: без DaData, проверка ввода, пустая база', async () => {
  const call = async (app, body) => {
    const srv = http.createServer(app); await new Promise((r) => srv.listen(0, r));
    try {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/market`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return [r.status, await r.json()];
    } finally { srv.close(); }
  };
  const [s1, b1] = await call(createApp({ env: {}, fnsDb: db }), { okved: '56.10', region: '54' });
  assert.equal(s1, 200);
  assert.equal(b1.available, true);
  assert.equal(b1.byAge.length, 3);
  assert.equal((await call(createApp({ env: {}, fnsDb: db }), { okved: 'кафе' }))[0], 400);
  assert.deepEqual((await call(createApp({ env: {}, fnsDb: openFnsDb(':memory:') }), { okved: '56' }))[1], { available: false });
  assert.deepEqual((await call(createApp({ env: {}, fnsDb: null }), { okved: '56' }))[1], { available: false });
  assert.equal((await call(createApp({ env: {}, fnsDb: db }), null))[0], 400, 'тело null — 400, а не 502');
  const app = createApp({ env: {}, fnsDb: db }), srv = http.createServer(app); await new Promise((r) => srv.listen(0, r));
  try {
    const codes = [];
    for (let i = 0; i < 122; i++) codes.push((await fetch(`http://127.0.0.1:${srv.address().port}/api/market`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"okved":"56"}' })).status);
    assert.equal(codes.filter((c) => c === 429).length, 2, 'после 120 запросов за 10 минут — 429');
  } finally { srv.close(); }
});

console.log(`\nВсе тесты статистики прошли: ${n}`);

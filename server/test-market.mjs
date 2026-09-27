// Тесты статистики похожих компаний без сети: импорт реестра МСП и доходов/расходов, группы, API.
// Запуск: node server/test-market.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApp } from './index.mjs';
import { openFnsDb, importStream } from '../scripts/fns-import.mjs';
import { buildPeers } from '../scripts/fns-peers.mjs';
import { marketStats, orgPeers, percentile, MIN_GROUP } from './market.mjs';

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
});

console.log(`\nВсе тесты статистики прошли: ${n}`);

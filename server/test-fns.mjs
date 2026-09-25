// Тесты данных ФНС без сети: импорт открытых данных, ГИР БО и «Прозрачный бизнес» на заглушках.  Запуск: node server/test-fns.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApp } from './index.mjs';
import { openFnsDb, importStream } from '../scripts/fns-import.mjs';
import { openData, fnsData, pbSummary } from './fns.mjs';

const doc = (asof, inn, inner) => `<Документ ИдДок="x" ДатаДок="25.09.2026" ДатаСост="${asof}"><СведНП НаимОрг="ООО &quot;ПЕКАРНЯ&quot;" ИННЮЛ="${inn}"/>${inner}</Документ>`;
const file = (docs) => `<?xml version="1.0" encoding="UTF-8"?><Файл ИдФайл="f"><ИдОтпр/>${docs.join('')}</Файл>`;
// два файла подряд, как отдаёт `unzip -p`, и разрыв посреди документа между кусками потока
const stream = (xml) => { const s = xml + xml.replace(/2804011398/g, '7700000000'); return Readable.from([s.slice(0, 137), s.slice(137)]); };

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok  ', name); };

const db = openFnsDb(':memory:');
await t('импорт: спецрежимы, численность, налоги, долги', async () => {
  assert.equal(await importStream(db, 'snr', stream(file([doc('01.09.2026', '2804011398', '<СведСНР ПризнЕСХН="0" ПризнУСН="1" ПризнАУСН="0" ПризнСРП="0"/>')]))), 2);
  await importStream(db, 'sshr2019', stream(file([doc('31.12.2025', '2804011398', '<СведССЧР КолРаб="7"/>')])));
  await importStream(db, 'paytax', stream(file([doc('31.12.2025', '2804011398', '<СвУплСумНал НаимНалог="Страховые взносы" СумУплНал="519000.50"/><СвУплСумНал НаимНалог="УСН" СумУплНал="32748.00"/><СвУплСумНал НаимНалог="НДС" СумУплНал="0.00"/>')])));
  await importStream(db, 'debtam', stream(file([doc('01.09.2026', '2804011398', '<СведНедоим НаимНалог="НДФЛ" СумНедНалог="40817.89" СумПени="0.00" СумШтраф="0.00" ОбщСумНедоим="40817.89"/><СведНедоим НаимНалог="Страховые взносы" СумНедНалог="90196.12" СумПени="4609.82" СумШтраф="0.00" ОбщСумНедоим="94805.94"/>')])));
  const r = openData('2804011398', db);
  assert.deepEqual(r.regime, { known: true, names: ['УСН'], code: 'USN', period: '01.09.2026' });
  assert.deepEqual(r.employees, [{ year: 2025, n: 7 }]);
  assert.equal(r.taxesPaid.total, 551748.5);
  assert.deepEqual(r.taxesPaid.items.map((x) => x.name), ['Страховые взносы', 'УСН'], 'нулевые налоги отброшены, по убыванию');
  assert.equal(r.arrears.total, 135623.83);
  assert.equal(r.arrears.items[0].name, 'Страховые взносы');
});

await t('компании нет в наборе спецрежимов → общая система; нет в долгах → долга нет', async () => {
  const db2 = openFnsDb(':memory:');
  await importStream(db2, 'sshr2019', stream(file([doc('31.12.2025', '2804011398', '<СведССЧР КолРаб="3"/>')])));
  const r = openData('2804011398', db2);
  assert.equal(r.regime.names.length, 0);
  assert.equal(r.arrears.total, 0);
  assert.equal(openData('1234567890', db2), null, 'совсем нет данных — null');
});

await t('повторный импорт заменяет данные целиком', async () => {
  await importStream(db, 'debtam', stream(file([doc('01.10.2026', '7700000001', '<СведНедоим НаимНалог="НДФЛ" СумНедНалог="10" СумПени="0" СумШтраф="0" ОбщСумНедоим="10"/>')])));
  assert.equal(openData('2804011398', db).arrears.total, 0, 'долг погашен — в новом наборе его нет');
});

const PB_CARD = {
  vyp: { usn: 1, psn: 0, npd: 0, ausn: 0, eshn: 0, hastaxmode: 1, rsmpcategory: 1, rsmpdate: '10.06.2018 00:00:00', masruk: [{ cnt: '3', inn: '1', name: 'ИВАНОВ' }], masuchr: [{ cnt: '1', inn: '2', name: 'ПЕТРОВ' }] },
  taxmode: [{ yearcode: 2026, periodcode: 9, usn: 1 }], masaddress: [{}], offense: [{ yearcode: 2024 }], vestnik: []
};
await t('«Прозрачный бизнес»: сводка без ФИО и ИНН людей', () => {
  const s = pbSummary(PB_CARD, true);
  assert.deepEqual(s.regime.names, ['УСН']);
  assert.equal(s.msp.category, 'микропредприятие');
  assert.equal(s.managerOtherCompanies, 2);
  assert.equal(s.massAddress, true);
  assert.ok(!JSON.stringify(s).includes('ИВАНОВ') && !JSON.stringify(s).includes('ПЕТРОВ'), 'персональные данные не утекают');
});

let pbCalls = 0, captcha = false;
async function fake(url, opts = {}) {
  const u = String(url);
  if (u.includes('bo.nalog.gov.ru/advanced-search')) return new Response(JSON.stringify({ content: [{ id: 42, inn: '<strong>2804011398</strong>' }] }));
  if (u.includes('/nbo/organizations/42/bfo/')) return new Response(JSON.stringify([
    { period: '2025', typeCorrections: [{ correction: { financialResult: { current2110: 10391, current2400: 240 }, balance: { current1600: 4700, current1300: 4504, current1400: 0, current1500: 1122 } } }] },
    { period: '2024', typeCorrections: [{ correction: { financialResult: { current2110: 12475, current2400: 24 }, balance: {} } }] }
  ]));
  if (u.includes('pb.nalog.ru')) {
    pbCalls++;
    if (captcha) return new Response(JSON.stringify({ ERRORS: { pbSearchCaptcha: ['Требуется ввести цифры с картинки'] } }), { status: 400 });
    const b = new URLSearchParams(opts.body);
    if (u.endsWith('search-proc.json') && b.get('mode')) return new Response(JSON.stringify({ id: 's1' }));
    if (u.endsWith('search-proc.json')) return new Response(JSON.stringify({ ip: { data: [{ inn: '760313108264', token: 'tk' }] } }));
    if (b.get('method') === 'get-request') return new Response(JSON.stringify({ id: 'c1' }));
    return new Response(JSON.stringify(PB_CARD));
  }
  throw new Error('неожиданный запрос ' + u);
}

await t('юрлицо: открытые данные + ГИР БО, в «Прозрачный бизнес» не ходим', async () => {
  const f = await fnsData('7700000001', fake, 0, db);
  assert.equal(pbCalls, 0);
  assert.equal(f.pb.arrears.total, 10);
  const g = await fnsData('2804011398', fake, 0, db);
  assert.deepEqual(g.bo.years.map((y) => [y.year, y.revenue, y.profit]), [[2024, 12475000, 24000], [2025, 10391000, 240000]]);
  assert.equal(g.bo.years[1].liabilities, 1122000);
});

await t('ИП: «Прозрачный бизнес»; при капче — пауза, повторно не ходим', async () => {
  const now = Date.now();
  const f = await fnsData('760313108264', fake, 0, db, () => now);
  assert.deepEqual(f.pb.regime.names, ['УСН']);
  assert.equal(f.bo, null, 'у ИП нет бухотчётности');
  captcha = true; pbCalls = 0;
  const g = await fnsData('760313108264', fake, 0, db, () => now + 1000);
  assert.equal(g.pb, null);
  assert.equal(pbCalls, 1, 'одна попытка, дальше пауза');
  await fnsData('760313108264', fake, 0, db, () => now + 2000);
  assert.equal(pbCalls, 1, 'во время паузы запросов нет');
  captcha = false;
  const h = await fnsData('760313108264', fake, 0, db, () => now + 3 * 3600e3);
  assert.ok(h.pb, 'через 2 часа пробуем снова');
});

await t('/api/org/fns: ответ и кеш', async () => {
  const srv = http.createServer(createApp({ env: { DADATA_TOKEN: 't' }, fetchImpl: fake, fnsPause: 0, fnsDb: db }));
  await new Promise((r) => srv.listen(0, r));
  const go = () => fetch(`http://127.0.0.1:${srv.address().port}/api/org/fns`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://fin-check.shop' }, body: JSON.stringify({ inn: '2804011398' }) }).then((r) => r.json());
  try {
    const j = await go();
    assert.equal(j.bo.years.length, 2);
    assert.equal(j.pb.type, 'ul');
    const bad = await fetch(`http://127.0.0.1:${srv.address().port}/api/org/fns`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://fin-check.shop' }, body: JSON.stringify({ inn: '123' }) });
    assert.equal(bad.status, 400);
  } finally { srv.close(); }
});

console.log(`\nВсе тесты ФНС прошли: ${n}`);

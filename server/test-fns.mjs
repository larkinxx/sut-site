// Тесты данных ФНС без сети: импорт открытых данных, ГИР БО и «Прозрачный бизнес» на заглушках.  Запуск: node server/test-fns.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApp } from './index.mjs';
import { openFnsDb, importStream, download, importZip } from '../scripts/fns-import.mjs';
import { openData, fnsData, pbSummary } from './fns.mjs';
import { ogSvg } from './og-image.mjs';

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

await t('страницы компаний: название из ФНС, налоги, мета-теги, JSON-LD, карта сайта, 404 для неизвестных', async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'sut-dist-'));
  fs.mkdirSync(path.join(dist, 'organizacii'));
  fs.writeFileSync(path.join(dist, 'organizacii', 'index.html'), '<html><head><title>Проверка</title><meta name="description" content="x"><link rel="canonical" href="https://inn-sider.ru/organizacii/"><meta property="og:title" content="x"><meta property="og:url" content="x"><meta property="og:image" content="x"></head><body><!--ssr:intro--><h1 class="page">Проверка организации по ИНН</h1><!--/ssr:intro--><section class="calc" id="org" data-pages="1"></section><div id="org-out" aria-live="polite"></div></body></html>');
  const srv = http.createServer(createApp({ env: { DADATA_TOKEN: 't', SITE_DIST: dist, SSR_DADATA_DAILY: '0' }, fetchImpl: fake, fnsPause: 0, fnsDb: db }));
  await new Promise((r) => srv.listen(0, r));
  const get = (p) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, { redirect: 'manual' });
  try {
    const r = await get('/organizacii/2804011398/');
    assert.equal(r.status, 200);
    const h = await r.text();
    assert.match(h, /<title>ООО &quot;ПЕКАРНЯ&quot; — ИНН 2804011398: проверка, налоги, суды — INNSIDER<\/title>/);
    assert.match(h, /<h1 class="page">ООО &quot;ПЕКАРНЯ&quot;<\/h1>/);
    assert.match(h, /<link rel="canonical" href="https:\/\/inn-sider.ru\/organizacii\/2804011398\/">/);
    assert.match(h, /data-inn="2804011398"/);
    assert.match(h, /Уплачено налогов и взносов<\/span><strong>552 тыс. ₽ за 2025 год/);
    assert.match(h, /"@type":"Organization"/);
    assert.match(h, /<meta property="og:image" content="https:\/\/inn-sider.ru\/organizacii\/2804011398\/og.png"/);
    assert.equal((await get('/organizacii/2804011398')).headers.get('location'), '/organizacii/2804011398/');
    const og = await get('/organizacii/2804011398/og.png');
    assert.ok(og.status === 200 ? og.headers.get('content-type') === 'image/png' : og.headers.get('location') === '/og.png', 'PNG или общая картинка, если нет rsvg-convert');
    const svg = ogSvg({ name: 'ООО "<script>" ОЧЕНЬ ДЛИННОЕ НАЗВАНИЕ КОМПАНИИ, КОТОРОЕ НЕ ПОМЕЩАЕТСЯ В ДВЕ СТРОКИ НИКАК ВООБЩЕ СОВСЕМ', inn: '2804011398', status: 'Действует', active: true, facts: [['Сотрудников', '7']] });
    assert.ok(!svg.includes('<script>'), 'название экранировано');
    assert.equal((svg.match(/class="name"/g) || []).length, 2, 'не больше двух строк');
    const nf = await get('/organizacii/7707083893/');
    assert.equal(nf.status, 404, 'нет ни в ФНС, ни в DaData');
    assert.match(await nf.text(), /noindex/);
    const idx = await (await get('/sitemap-companies.xml')).text();
    assert.match(idx, /sitemap-companies-1\.xml/);
    const sm = await (await get('/sitemap-companies-1.xml')).text();
    assert.deepEqual([...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]), ['https://inn-sider.ru/organizacii/2804011398/', 'https://inn-sider.ru/organizacii/7700000000/']);
  } finally { srv.close(); fs.rmSync(dist, { recursive: true }); }
});

await t('скачивание архива: обрывы — докачка того же файла с места остановки; иначе заново', async () => {
  let data = crypto.randomBytes(3 * 1024 * 1024), etag = '"v1"', drops = 2, shift = 0, log = [];
  const srv = http.createServer((req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    const ok = m && req.headers['if-range'] === etag;         // If-Range не совпал — отдаём файл целиком
    const from = ok ? Number(m[1]) + shift : 0;               // shift — «сервер продолжил не с того байта»
    log.push([m ? Number(m[1]) : 0, req.headers['if-range'] || null, ok ? 206 : 200]);
    res.writeHead(ok ? 206 : 200, { etag, 'content-length': data.length - from, ...(ok ? { 'content-range': `bytes ${from}-${data.length - 1}/${data.length}` } : {}) });
    if (drops-- > 0) { res.write(data.subarray(from, from + 256 * 1024)); setTimeout(() => res.destroy(), 20); }
    else res.end(data.subarray(from));
  });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')), f = (x) => path.join(dir, x);
  try {
    // 1) два обрыва: каждая попытка продолжает с места обрыва и присылает версию файла
    assert.equal(await download(base + 'a', f('a.zip'), { wait: 0 }), true);
    assert.deepEqual(log.map((x) => x[2]), [200, 206, 206]);
    assert.ok(log[1][0] > 0 && log[2][0] > log[1][0] && log[1][1] === '"v1"', 'Range с места обрыва и If-Range');
    assert.ok(fs.readFileSync(f('a.zip')).equals(data), 'файл собран без искажений');
    assert.ok(!fs.existsSync(f('a.zip.part')) && !fs.existsSync(f('a.zip.part.v')));
    assert.equal(await download('http://127.0.0.1:1/never', f('a.zip')), false, 'уже скачан — не качаем');
    // 2) между попытками файл на сервере поменялся — докачивать нельзя, приходит целиком
    log = []; drops = 1;
    const p2 = download(base + 'b', f('b.zip'), { wait: 50 });
    await new Promise((r) => setTimeout(r, 25)); data = crypto.randomBytes(2 * 1024 * 1024); etag = '"v2"';
    assert.equal(await p2, true);
    assert.deepEqual(log.map((x) => x[2]), [200, 200], 'версия не совпала — второй раз целиком');
    assert.ok(fs.readFileSync(f('b.zip')).equals(data), 'в файле только новая версия, без склейки');
    // 3) сервер продолжил не с того байта — всё заново
    log = []; drops = 1; shift = 100;
    assert.equal(await download(base + 'c', f('c.zip'), { wait: 0 }), true);
    assert.deepEqual(log.map((x) => x[2]), [200, 206, 200], 'после неверного продолжения — с нуля');
    assert.ok(fs.readFileSync(f('c.zip')).equals(data));
    shift = 0;
    // 4) недокачанный .part от старой версии скрипта (без .part.v) — не доверяем, качаем с нуля
    log = []; drops = 0;
    fs.writeFileSync(f('d.zip.part'), crypto.randomBytes(1000));
    assert.equal(await download(base + 'd', f('d.zip'), { wait: 0 }), true);
    assert.deepEqual(log, [[0, null, 200]]);
    assert.ok(fs.readFileSync(f('d.zip')).equals(data));
    // 5) все попытки неудачны — недокачанное остаётся для следующего запуска вместе с версией
    log = []; drops = 5;
    await assert.rejects(download(base + 'e', f('e.zip'), { wait: 0, attempts: 2 }));
    assert.ok(fs.statSync(f('e.zip.part')).size > 0 && fs.readFileSync(f('e.zip.part.v'), 'utf8') === etag);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true }); }
});

// zip без сжатия, собранный вручную (без внешних утилит): несколько XML-файлов, как в архивах ФНС
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function makeZip(files) {
  const parts = [], dir = []; let off = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text), fn = Buffer.from(name), crc = crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(fn.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(fn.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, fn, data); dir.push(c, fn); off += 30 + fn.length + data.length;
  }
  const cd = Buffer.concat(dir), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}
await t('импорт из zip: несколько файлов; битый архив и неверный формат — ошибка, таблица прежняя, процесс не виснет', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-')), db3 = openFnsDb(':memory:');
  const staff = (inn, n) => file([doc('31.12.2025', inn, `<СведССЧР КолРаб="${n}"/>`)]);
  try {
    const ok = path.join(dir, 'ok.zip');
    fs.writeFileSync(ok, makeZip([['a.xml', staff('2804011398', 7)], ['b.xml', staff('7700000000', 3)]]));
    assert.equal(await importZip(db3, 'sshr2019', ok), 2);
    // второй файл битый (не сходится контрольная сумма): unzip отдаёт первый и падает посередине — таблицу не трогаем
    const broken = makeZip([['a.xml', staff('2804011398', 9)], ['b.xml', staff('7700000000', 4)]]);
    broken[broken.indexOf(Buffer.from('КолРаб="4"')) + 14] ^= 1;
    const cut = path.join(dir, 'broken.zip');
    fs.writeFileSync(cut, broken);
    await assert.rejects(importZip(db3, 'sshr2019', cut), /архив повреждён/);
    assert.ok(!fs.existsSync(cut), 'повреждённый архив удалён — следующий запуск скачает заново');
    assert.equal(openData('2804011398', db3).employees[0].n, 7, 'после сбоя таблица прежняя, а не 9 из недораспакованного архива');
    // база занята другим процессом (как на сервере): импорт падает сразу, распаковщик не должен держать процесс живым
    const dbFile = path.join(dir, 'lock.db'), a = openFnsDb(dbFile), holder = openFnsDb(dbFile);
    a.exec('PRAGMA busy_timeout = 0');
    holder.exec('BEGIN IMMEDIATE');
    const large = path.join(dir, 'large.zip');
    fs.writeFileSync(large, makeZip([['a.xml', staff('2804011398', 1).repeat(3000)]]));
    await assert.rejects(importZip(a, 'sshr2019', large), /locked/);
    holder.exec('ROLLBACK'); holder.close(); a.close();
    // формат изменился: импорт падает, а распаковщик не держит процесс (иначе тест бы не завершился)
    const bad = path.join(dir, 'bad.zip');
    fs.writeFileSync(bad, makeZip([['a.xml', file(Array.from({ length: 3000 }, (_, i) => doc('01.09.2026', String(7700000100 + i), '<Другое/>')))]]));
    await assert.rejects(importZip(db3, 'rsmp', bad), /нет нужных полей/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

console.log(`\nВсе тесты ФНС прошли: ${n}`);

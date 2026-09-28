// Тесты данных ФНС без сети: импорт открытых данных, ГИР БО и «Прозрачный бизнес» на заглушках.  Запуск: node server/test-fns.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApp } from './index.mjs';
import { openFnsDb, importStream, download, importZip, etagCheck, downloadRanged } from '../scripts/fns-import.mjs';
import zlib from 'node:zlib';
import { openData, fnsData, pbSummary } from './fns.mjs';
import { ogSvg } from './og-image.mjs';
import { openDb } from './accounts.mjs';

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

await t('поток режется посреди русской буквы — записи не теряются и не портятся', async () => {
  const db5 = openFnsDb(':memory:');
  const bytes = Buffer.from(file(Array.from({ length: 60 }, (_, i) => doc('31.12.2025', String(7700000200 + i), `<СведССЧР КолРаб="${i + 1}"/>`))));
  const pieces = []; for (let o = 0; o < bytes.length; o += 7) pieces.push(bytes.subarray(o, o + 7));   // байтами, не строками
  assert.equal(await importStream(db5, 'sshr2019', Readable.from(pieces)), 60);
  assert.equal(db5.prepare("SELECT name FROM fns_name WHERE inn = '7700000259'").get().name, 'ООО "ПЕКАРНЯ"', 'кириллица не испорчена');
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
    assert.equal(nf.status, 503, 'DaData не спрашивали (лимит) — не 404, чтобы поисковик не выкинул страницу');
    assert.equal(nf.headers.get('retry-after'), '3600');
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
function makeZip(files, { deflate = false } = {}) {
  const parts = [], dir = []; let off = 0;
  for (const [name, text] of files) {
    const raw = Buffer.from(text), data = deflate ? zlib.deflateRawSync(raw) : raw, fn = Buffer.from(name), crc = crc32(raw);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(deflate ? 8 : 0, 8); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(fn.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(deflate ? 8 : 0, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(fn.length, 28); c.writeUInt32LE(off, 42);
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
    // 200 файлов, у двух испорчены данные и заголовок (как в архиве реестра МСП): битых ≤ 1% — загружаем остальные 198
    const many = Array.from({ length: 200 }, (_, i) => [`f${i}.xml`, staff(String(7700000100 + i).slice(0, 10), i + 1)]);
    const zipMany = makeZip(many);
    zipMany[zipMany.indexOf(Buffer.from('КолРаб="51"')) + 13] ^= 1;                    // контрольная сумма не сходится
    zipMany.write('XX', zipMany.indexOf(Buffer.from('f120.xml')) - 30, 'latin1');       // «bad zipfile offset»: нет сигнатуры
    const partly = path.join(dir, 'partly.zip');
    fs.writeFileSync(partly, zipMany);
    const db4 = openFnsDb(':memory:');
    assert.equal(await importZip(db4, 'sshr2019', partly), 198, 'битые 2 из 200 пропущены, остальные загружены');
    assert.equal(db4.prepare("SELECT n FROM fns_staff WHERE inn = '7700000100'").get().n, 1);
    assert.equal(db4.prepare("SELECT count(*) AS c FROM fns_staff WHERE n IN (51, 121)").get().c, 0, 'из битых файлов ничего не попало');
    assert.ok(fs.existsSync(partly), 'годный архив не удаляется');
    // сжатые файлы, у одного испорчены сжатые данные (на сервере: zlib «invalid code lengths set») — пропускается он один
    const packed = makeZip(Array.from({ length: 150 }, (_, i) => [`p${i}.xml`, staff(String(7700000400 + i), i + 1)]), { deflate: true });
    const at = packed.indexOf(Buffer.from('p70.xml')) + 7;                         // начало сжатых данных файла p70
    for (let k = 0; k < 12; k++) packed[at + 2 + k] ^= 0x5a;
    const zp = path.join(dir, 'packed.zip');
    fs.writeFileSync(zp, packed);
    const db6 = openFnsDb(':memory:');
    assert.equal(await importZip(db6, 'sshr2019', zp), 149, 'испорченное сжатие одного файла — пропущен только он');
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

await t('скачанный файл сверяется с ETag хранилища: испорченный при передаче — качается заново', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etag-')), f = path.join(dir, 'x.bin');
  const MiB = 1024 * 1024, data = crypto.randomBytes(40 * MiB + 12345);   // 41 часть по 1 МиБ — размер части однозначен, как у архива ФНС (254 × 8 МиБ)
  const md5 = (b) => crypto.createHash('md5').update(b).digest();
  const multipart = (b, part) => { const hs = []; for (let o = 0; o < b.length; o += part) hs.push(md5(b.subarray(o, o + part))); return `"${md5(Buffer.concat(hs)).toString('hex')}-${hs.length}"`; };
  try {
    fs.writeFileSync(f, data);
    assert.equal(await etagCheck(f, multipart(data, MiB)), true, 'составной ETag');
    assert.equal(await etagCheck(f, `"${md5(data).toString('hex')}"`), true, 'ETag целого файла');
    assert.equal(await etagCheck(f, '"v1"'), null, 'ETag не контрольная сумма — сверить нельзя');
    const bad = Buffer.from(data); bad[15 * MiB] ^= 1; fs.writeFileSync(f, bad);
    assert.equal(await etagCheck(f, multipart(data, MiB)), false, 'один испорченный байт');
    assert.equal(await etagCheck(f, `"${md5(data).toString('hex')}-3"`), null, 'размер части не определить однозначно — не гадаем');
    // сервер отдаёт испорченный файл один раз, затем правильный
    const etag = multipart(data, MiB); let hits = 0;
    const srv = http.createServer((req, res) => { hits++; res.writeHead(200, { etag, 'content-length': data.length }); res.end(hits === 1 ? bad : data); });
    await new Promise((r) => srv.listen(0, r));
    try {
      assert.equal(await download(`http://127.0.0.1:${srv.address().port}/x`, path.join(dir, 'y.zip'), { wait: 0 }), true);
      assert.equal(hits, 2, 'испорченный файл отброшен и скачан заново');
      assert.ok(fs.readFileSync(path.join(dir, 'y.zip')).equals(data));
    } finally { srv.close(); }
  } finally { fs.rmSync(dir, { recursive: true }); }
});

await t('скачивание частями: испорченные при передаче части находятся и заменяются, ETag сходится', async () => {
  const MiB = 1024 * 1024, data = crypto.randomBytes(40 * MiB + 12345);            // 41 часть по 1 МиБ
  const md5 = (b) => crypto.createHash('md5').update(b).digest();
  const hs = []; for (let o = 0; o < data.length; o += MiB) hs.push(md5(data.subarray(o, o + MiB)));
  const etag = `"${md5(Buffer.concat(hs)).toString('hex')}-${hs.length}"`;
  let spoil = () => false, ranges = true, gets = 0;
  const srv = http.createServer((req, res) => {
    if (req.method === 'HEAD') { res.writeHead(200, { etag, 'content-length': data.length, ...(ranges ? { 'accept-ranges': 'bytes' } : {}) }); return res.end(); }
    gets++;
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    if (!m) { res.writeHead(200, { etag, 'content-length': data.length }); return res.end(data); }
    const a = Number(m[1]), b = Number(m[2]);
    let chunk = Buffer.from(data.subarray(a, b + 1));
    if (spoil(a / MiB)) chunk[100] ^= 1;                                               // тот же размер, другие байты
    res.writeHead(206, { etag, 'content-length': chunk.length, 'content-range': `bytes ${a}-${b}/${data.length}` });
    res.end(chunk);
  });
  await new Promise((r) => srv.listen(0, r));
  const url = `http://127.0.0.1:${srv.address().port}/rsmp.zip`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rng-')), f = (x) => path.join(dir, x);
  try {
    // 1) без порчи: 41 запрос, файл совпадает
    assert.equal(await downloadRanged(url, f('a.zip'), { wait: 0 }), true);
    assert.equal(gets, 41);
    assert.ok(fs.readFileSync(f('a.zip')).equals(data));
    assert.equal(await downloadRanged(url, f('a.zip')), false, 'уже скачан');
    // 2) части 3 и 17 испорчены при первой передаче — перепроверка заменяет только их
    const seen = new Map(); gets = 0;
    spoil = (i) => { const n = (seen.get(i) || 0) + 1; seen.set(i, n); return (i === 3 || i === 17) && n === 1; };
    assert.equal(await downloadRanged(url, f('b.zip'), { wait: 0 }), true);
    assert.ok(fs.readFileSync(f('b.zip')).equals(data), 'после замены частей файл цел');
    assert.equal(gets, 41 + 41 + 2, 'первый проход, перепроверка всех частей и третья копия двух разошедшихся');
    // 3) часть 5 всегда приходит испорченной — копии совпадают, ETag не сходится: понятная ошибка, мусор не остаётся
    spoil = (i) => i === 5;
    await assert.rejects(downloadRanged(url, f('c.zip'), { wait: 0, rounds: 2 }), /испорчен у ФНС/);
    assert.ok(!fs.existsSync(f('c.zip')) && !fs.existsSync(f('c.zip.part')));
    // 4) сервер не отдаёт частями — null, импорт качает обычным способом
    spoil = () => false; ranges = false;
    assert.equal(await downloadRanged(url, f('d.zip'), { wait: 0 }), null);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true }); }
});

await t('скачивание частями: неоднозначный размер части и оборванный HEAD не ломают загрузку, ошибка части останавливает остальные', async () => {
  const MiB = 1024 * 1024, data = crypto.randomBytes(3 * MiB + 7);
  const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
  let etag = `"${md5(data)}-2"`, failPart = -1, afterFail = 0, failed = false, head = true;
  const srv = http.createServer((req, res) => {
    if (req.method === 'HEAD') { if (!head) return req.socket.destroy(); res.writeHead(200, { etag, 'content-length': data.length, 'accept-ranges': 'bytes' }); return res.end(); }
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    if (!m) { res.writeHead(200, { etag, 'content-length': data.length }); return res.end(data); }
    const a = Number(m[1]), b = Number(m[2]);
    if (failed) afterFail++;
    if (a === failPart * 8 * MiB) { failed = true; res.writeHead(500); return res.end(); }
    res.writeHead(206, { etag, 'content-length': b - a + 1, 'content-range': `bytes ${a}-${b}/${data.length}` });
    res.end(data.subarray(a, b + 1));
  });
  await new Promise((r) => srv.listen(0, r));
  const url = `http://127.0.0.1:${srv.address().port}/x.zip`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rng2-')), f = (x) => path.join(dir, x);
  try {
    // ETag «md5-2» при 3 МиБ: подходят части 2 и 3 МиБ — сверить нельзя, целый файл не должен считаться битым
    assert.equal(await downloadRanged(url, f('a.zip'), { wait: 0 }), true);
    assert.ok(fs.readFileSync(f('a.zip')).equals(data));
    // HEAD оборвался — null, импорт качает обычным способом
    head = false;
    assert.equal(await downloadRanged(url, f('b.zip'), { wait: 0 }), null);
    head = true;
  } finally { srv.close(); fs.rmSync(dir, { recursive: true }); }
  // часть не качается: ошибка, после неё новые части не запрашиваются
  const big = crypto.randomBytes(40 * MiB), parts = [];
  for (let o = 0; o < big.length; o += MiB) parts.push(crypto.createHash('md5').update(big.subarray(o, o + MiB)).digest());
  const etag2 = `"${crypto.createHash('md5').update(Buffer.concat(parts)).digest('hex')}-40"`;
  let asked = 0, broken = false;
  const srv2 = http.createServer((req, res) => {
    if (req.method === 'HEAD') { res.writeHead(200, { etag: etag2, 'content-length': big.length, 'accept-ranges': 'bytes' }); return res.end(); }
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(req.headers.range).map(Number);
    asked++;
    if (a === 2 * MiB) { broken = true; res.writeHead(500); return res.end(); }
    res.writeHead(206, { etag: etag2, 'content-length': b - a + 1, 'content-range': `bytes ${a}-${b}/${big.length}` });
    setTimeout(() => res.end(big.subarray(a, b + 1)), 5);
  });
  await new Promise((r) => srv2.listen(0, r));
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rng3-'));
  try {
    await assert.rejects(downloadRanged(`http://127.0.0.1:${srv2.address().port}/y.zip`, path.join(dir2, 'y.zip'), { wait: 0, concurrency: 2 }), /часть 3 из 40/);
    assert.ok(asked < 40, `после ошибки остальные части не качаются (запросов ${asked})`);
    assert.ok(!fs.existsSync(path.join(dir2, 'y.zip.part')));
  } finally { srv2.close(); fs.rmSync(dir2, { recursive: true }); }
});

await t('нечитаемый архив удаляется, даже когда из него не прочиталось ни одной записи', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-')), z = path.join(dir, 'x.zip');
  try {
    fs.writeFileSync(z, crypto.randomBytes(5000));
    await assert.rejects(importZip(openFnsDb(':memory:'), 'sshr2019', z), /архив повреждён/);
    assert.ok(!fs.existsSync(z), 'следующий запуск скачает заново');
  } finally { fs.rmSync(dir, { recursive: true }); }
});

await t('страница компании: 404 — только если DaData ответила «нет», при сбое — 503', async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'sut-dist-'));
  fs.mkdirSync(path.join(dist, 'organizacii'));
  fs.writeFileSync(path.join(dist, 'organizacii', 'index.html'), '<html><head><title>x</title></head><body><!--ssr:intro--><h1>x</h1><!--/ssr:intro--></body></html>');
  let down = false;
  const dadata = async (url, opts) => (String(url).includes('dadata') ? (down ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ suggestions: [] }))) : fake(url, opts));
  const srv = http.createServer(createApp({ env: { DADATA_TOKEN: 't', SITE_DIST: dist }, fetchImpl: dadata, fnsPause: 0, fnsDb: db }));
  await new Promise((r) => srv.listen(0, r));
  const get = (p) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, { redirect: 'manual' });
  try {
    assert.equal((await get('/organizacii/7707083893/')).status, 404, 'DaData ответила: такой организации нет');
    down = true;
    const r = await get('/organizacii/7736207543/');
    assert.equal(r.status, 503, 'DaData недоступна');
    assert.equal(r.headers.get('retry-after'), '3600');
  } finally { srv.close(); fs.rmSync(dist, { recursive: true }); }
});

await t('карточка организации из DaData переживает перезапуск сервера (неделю), ИП — нет', async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'sut-dist-'));
  fs.mkdirSync(path.join(dist, 'organizacii'));
  fs.writeFileSync(path.join(dist, 'organizacii', 'index.html'), '<html><head><title>x</title></head><body><!--ssr:intro--><h1>x</h1><!--/ssr:intro--></body></html>');
  let calls = 0, clock = Date.UTC(2026, 8, 28);
  const card = (inn) => ({ value: 'ООО "КЕШ"', data: { inn, name: { short_with_opf: 'ООО "КЕШ"' }, state: { status: 'ACTIVE' }, type: inn.length === 10 ? 'LEGAL' : 'INDIVIDUAL' } });
  const dadata = async (url, opts) => { if (!String(url).includes('dadata')) return fake(url, opts); calls++; return new Response(JSON.stringify({ suggestions: [card(JSON.parse(opts.body).query)] })); };
  const accDb = openDb(':memory:');
  const up = async () => { const srv = http.createServer(createApp({ env: { DADATA_TOKEN: 't', SITE_DIST: dist }, fetchImpl: dadata, fnsPause: 0, fnsDb: db, db: accDb, now: () => clock })); await new Promise((r) => srv.listen(0, r)); return srv; };
  const get = (srv, p) => fetch(`http://127.0.0.1:${srv.address().port}${p}`);
  let srv = await up();
  try {
    assert.equal((await get(srv, '/organizacii/7707083893/')).status, 200);
    assert.equal((await get(srv, '/organizacii/500100732259/')).status, 200);
    assert.equal(calls, 2);
    srv.close(); srv = await up();   // «перезапуск»: память пуста, база та же
    assert.equal((await get(srv, '/organizacii/7707083893/')).status, 200);
    assert.equal(calls, 2, 'организация — из базы, без запроса к DaData');
    await get(srv, '/organizacii/500100732259/');
    assert.equal(calls, 3, 'ИП на диске не храним');
    srv.close(); clock += 8 * 864e5; srv = await up();
    await get(srv, '/organizacii/7707083893/');
    assert.equal(calls, 4, 'через неделю — снова из DaData');
  } finally { srv.close(); fs.rmSync(dist, { recursive: true }); }
});

await t('лимит DaData: страницы из базы ФНС её не тратят, проверка без DaData и DataNewton берёт название из базы', async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'sut-dist-'));
  fs.mkdirSync(path.join(dist, 'organizacii'));
  fs.writeFileSync(path.join(dist, 'organizacii', 'index.html'), '<html><head><title>x</title></head><body><!--ssr:intro--><h1>x</h1><!--/ssr:intro--></body></html>');
  let calls = 0;
  const dadata = async (url, opts) => { if (!String(url).includes('dadata')) return fake(url, opts); calls++; return new Response('{}', { status: 429 }); };
  const srv = http.createServer(createApp({ env: { DADATA_TOKEN: 't', SITE_DIST: dist }, fetchImpl: dadata, fnsPause: 0, fnsDb: db }));
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const page = await fetch(base + '/organizacii/2804011398/');
    assert.equal(page.status, 200);
    assert.equal(calls, 0, 'страница компании из базы ФНС — без запроса к DaData');
    const j = await (await fetch(base + '/api/org', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://fin-check.shop', 'user-agent': 'Mozilla/5.0' }, body: JSON.stringify({ inn: '2804011398' }) })).json();
    assert.equal(calls, 1, 'человек — DaData спросили');
    assert.equal(j.suggestion.source, 'fns', 'DaData не ответила — название из базы ФНС');
    assert.match(j.suggestion.value, /ПЕКАРНЯ/);
    await fetch(base + '/api/org', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://fin-check.shop', 'user-agent': 'Mozilla/5.0' }, body: JSON.stringify({ inn: '2804011398' }) });
    assert.equal(calls, 2, 'урезанную карточку не запоминаем — в следующий раз снова спрашиваем DaData');
  } finally { srv.close(); fs.rmSync(dist, { recursive: true }); }
});

await t('тонкие страницы компаний: открыты людям, закрыты от индекса и не попадают в карту сайта', async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'sut-dist-'));
  fs.mkdirSync(path.join(dist, 'organizacii'));
  fs.writeFileSync(path.join(dist, 'organizacii', 'index.html'), '<html><head><title>x</title></head><body><!--ssr:intro--><h1>x</h1><!--/ssr:intro--></body></html>');
  const thin = '7707083893';   // только налоги и название — ни численности, ни отчётности
  db.prepare('INSERT OR REPLACE INTO fns_tax (inn, total, items, asof) VALUES (?, ?, ?, ?)').run(thin, 1000, '[]', '2025-12-31');
  db.prepare('INSERT OR REPLACE INTO fns_name (inn, name) VALUES (?, ?)').run(thin, 'ООО "ТОНКАЯ"');
  const srv = http.createServer(createApp({ env: { DADATA_TOKEN: 't', SITE_DIST: dist, SSR_DADATA_DAILY: '0' }, fetchImpl: fake, fnsPause: 0, fnsDb: db }));
  await new Promise((r) => srv.listen(0, r));
  const get = (p) => fetch(`http://127.0.0.1:${srv.address().port}${p}`);
  try {
    const t1 = await get(`/organizacii/${thin}/`);
    assert.equal(t1.status, 200, 'людям страница открыта');
    assert.match(await t1.text(), /<meta name="robots" content="noindex, follow">/);
    assert.doesNotMatch(await (await get('/organizacii/2804011398/')).text(), /noindex/, 'содержательная — в индексе');
    const sm = await (await get('/sitemap-companies-1.xml')).text();
    assert.match(sm, /2804011398/);
    assert.doesNotMatch(sm, new RegExp(thin), 'тонкой нет в карте сайта');
  } finally {
    srv.close(); fs.rmSync(dist, { recursive: true });
    db.prepare('DELETE FROM fns_tax WHERE inn = ?').run(thin); db.prepare('DELETE FROM fns_name WHERE inn = ?').run(thin);
  }
});

console.log(`\nВсе тесты ФНС прошли: ${n}`);

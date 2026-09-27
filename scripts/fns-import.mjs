// Импорт открытых данных ФНС по всем организациям России в SQLite (без капчи и лимитов, в отличие от pb.nalog.ru):
//   snr      — специальные налоговые режимы (УСН, АУСН, ЕСХН, СРП)
//   sshr2019 — среднесписочная численность
//   paytax   — уплаченные налоги и взносы за год
//   debtam   — налоговая задолженность, пени и штрафы
//   revexp   — доходы и расходы по бухгалтерской отчётности за год
//   rsmp     — реестр МСП: основной ОКВЭД, регион, дата включения в реестр (≈ возраст компании), категория
// После загрузки считается статистика похожих компаний (scripts/fns-peers.mjs → fns_peers, fns_market).
// Источник: https://www.nalog.gov.ru/opendata/  (наборы 7707329152-*). ФНС обновляет их раз в месяц, около 25 числа.
// Запуск на сервере: node scripts/fns-import.mjs /var/lib/sut/fns.db   (нужен python3 — распаковка архивов, scripts/unzip-stream.py)
// Данные только по юрлицам: по ИП ФНС такие наборы не публикует.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { buildPeers } from './fns-peers.mjs';

const DB = process.argv[2] || '/var/lib/sut/fns.db';
const DIR = process.env.FNS_OPENDATA_DIR || path.join(path.dirname(DB), 'opendata');
const UA = { 'User-Agent': 'Mozilla/5.0 (inn-sider.ru opendata import)' };
const ENT = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" };
const unxml = (s) => s.replace(/&(quot|amp|lt|gt|apos);/g, (_, e) => ENT[e]);
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\p{L}\d_]+)="([^"]*)"/gu)].map((m) => [m[1], unxml(m[2])]));
const date = (d) => (d ? d.split('.').reverse().join('-') : null);        // 31.12.2025 → 2025-12-31
const money = (v) => Math.round(Number(v || 0) * 100) / 100;

export const DATASETS = {
  snr: {
    table: 'fns_regime', columns: 'inn, usn, ausn, eshn, srp, asof',
    row: (doc, asof) => {
      const a = attrs(doc.match(/<СведСНР[^>]*>/)?.[0] || '');
      return [+(a.ПризнУСН === '1'), +(a.ПризнАУСН === '1'), +(a.ПризнЕСХН === '1'), +(a.ПризнСРП === '1'), asof];
    }
  },
  sshr2019: {
    table: 'fns_staff', columns: 'inn, n, asof',
    row: (doc, asof) => [Number(attrs(doc.match(/<СведССЧР[^>]*>/)?.[0] || '').КолРаб || 0), asof]
  },
  paytax: {
    table: 'fns_tax', columns: 'inn, total, items, asof',
    row: (doc, asof) => {
      const items = [...doc.matchAll(/<СвУплСумНал[^>]*>/g)].map((m) => attrs(m[0])).map((a) => ({ name: a.НаимНалог, sum: money(a.СумУплНал) })).filter((x) => x.sum > 0);
      return [money(items.reduce((s, x) => s + x.sum, 0)), JSON.stringify(items.sort((a, b) => b.sum - a.sum)), asof];
    }
  },
  debtam: {
    table: 'fns_debt', columns: 'inn, total, items, asof',
    row: (doc, asof) => {
      const items = [...doc.matchAll(/<СведНедоим[^>]*>/g)].map((m) => attrs(m[0]))
        .map((a) => ({ name: a.НаимНалог, arrear: money(a.СумНедНалог), penalty: money(a.СумПени), fine: money(a.СумШтраф), total: money(a.ОбщСумНедоим) })).filter((x) => x.total > 0);
      return [money(items.reduce((s, x) => s + x.total, 0)), JSON.stringify(items.sort((a, b) => b.total - a.total)), asof];
    }
  },
  revexp: {
    table: 'fns_finance', columns: 'inn, income, expense, asof', required: [0, 1],
    row: (doc, asof) => {
      const a = attrs(doc.match(/<СведДохРасх[^>]*>/)?.[0] || '');
      return [a.СумДоход != null ? money(a.СумДоход) : null, a.СумРасход != null ? money(a.СумРасход) : null, asof];
    }
  },
  // В реестре МСП и организации, и ИП; берём только организации (как и остальные наборы)
  rsmp: {
    table: 'fns_msp', columns: 'inn, okved, region, since, category, asof', required: [0, 1, 2],
    row: (doc, asof) => {
      const d = attrs(doc.match(/<Документ [^>]*>/)[0]);
      return [
        attrs(doc.match(/<СвОКВЭДОсн[^>]*>/)?.[0] || '').КодОКВЭД || null,
        attrs(doc.match(/<СведМН[^>]*>/)?.[0] || '').КодРегион || null,
        date(d.ДатаВклМСП), Number(d.КатСубМСП) || null, asof
      ];
    }
  }
};

const SCHEMA = {
  fns_regime: '(inn TEXT PRIMARY KEY, usn INT, ausn INT, eshn INT, srp INT, asof TEXT)',
  fns_staff: '(inn TEXT PRIMARY KEY, n INT, asof TEXT)',
  fns_tax: '(inn TEXT PRIMARY KEY, total REAL, items TEXT, asof TEXT)',
  fns_debt: '(inn TEXT PRIMARY KEY, total REAL, items TEXT, asof TEXT)',
  fns_finance: '(inn TEXT PRIMARY KEY, income REAL, expense REAL, asof TEXT)',
  fns_msp: '(inn TEXT PRIMARY KEY, okved TEXT, region TEXT, since TEXT, category INT, asof TEXT)',
  fns_name: '(inn TEXT PRIMARY KEY, name TEXT)'           // названия организаций — для страниц компаний и карты сайта
};
export function openFnsDb(file, readOnly = false) {
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 60000; CREATE TABLE IF NOT EXISTS fns_meta (dataset TEXT PRIMARY KEY, file TEXT, rows INT, loaded_at TEXT)');
    for (const [t, cols] of Object.entries(SCHEMA)) db.exec(`CREATE TABLE IF NOT EXISTS ${t} ${cols}`);
  }
  return db;
}

// Разбор потока XML по документам: <Документ ...>…</Документ>
// check — необязательная проверка перед заменой таблицы (например, что unzip завершился без ошибки)
export async function importStream(db, name, stream, { check } = {}) {
  const ds = DATASETS[name];
  const tmp = ds.table + '_new';
  // та же схема с первичным ключом: одна компания может встретиться в двух файлах выгрузки — оставляем последнюю запись
  db.exec(`DROP TABLE IF EXISTS ${tmp}; CREATE TABLE ${tmp} ${SCHEMA[ds.table]}`);
  const ins = db.prepare(`INSERT OR REPLACE INTO ${tmp} (${ds.columns}) VALUES (${ds.columns.split(',').map(() => '?').join(', ')})`);
  const insName = db.prepare('INSERT OR REPLACE INTO fns_name (inn, name) VALUES (?, ?)');
  let buf = '', rows = 0, missing = 0;
  db.exec('BEGIN');
  const flush = (final) => {
    let end;
    while ((end = buf.indexOf('</Документ>')) !== -1) {
      const start = buf.lastIndexOf('<Документ ', end);
      const doc = buf.slice(start, end);
      buf = buf.slice(end + 11);
      const inn = doc.match(/ИННЮЛ="(\d{10})"/)?.[1];
      if (!inn) continue;
      const vals = ds.row(doc, date(attrs(doc.match(/<Документ [^>]*>/)[0]).ДатаСост));
      if (ds.required?.some((i) => vals[i] == null || vals[i] === '')) missing++;
      ins.run(inn, ...vals);
      const org = attrs(doc.match(/<(?:СведНП|ОргВклМСП)[^>]*>/)?.[0] || '').НаимОрг;
      if (org) insName.run(inn, org);
      if (++rows % 100000 === 0) { db.exec('COMMIT; BEGIN'); process.stdout.write(`  ${name}: ${rows}${process.stdout.isTTY ? '\r' : '\n'}`); }
    }
    if (final) buf = '';
    else if (buf.length > 1e6 && buf.indexOf('<Документ ') === -1) buf = buf.slice(-1000);
  };
  // русская буква — 2 байта в UTF-8, и граница куска может разрезать её пополам: StringDecoder дожидается второй половины
  const dec = new StringDecoder('utf8');
  for await (const chunk of stream) { buf += typeof chunk === 'string' ? chunk : dec.write(chunk); flush(false); }
  buf += dec.end();
  flush(true);
  db.exec('COMMIT');
  if (rows === 0) throw new Error(name + ': ни одной записи — формат изменился?');
  if (missing > rows / 2) throw new Error(`${name}: у ${missing} из ${rows} записей нет нужных полей — формат изменился?`);
  if (check) await check();
  db.exec(`BEGIN; DROP TABLE ${ds.table}; ALTER TABLE ${tmp} RENAME TO ${ds.table}; COMMIT`);
  return rows;
}

// Импорт из zip-архива. Распаковывает scripts/unzip-stream.py: каждый файл архива проверяется по контрольной сумме
// до того, как попасть в поток, битые пропускаются. Если битых не больше 1% — загружаем остальное (в журнал —
// предупреждение со списком), если больше или архив не читается — ошибка до замены таблицы, архив удаляется,
// чтобы следующий запуск скачал его заново. Распаковщик останавливаем при любой ошибке импорта.
const UNZIP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'unzip-stream.py');
export async function importZip(db, name, file) {
  const unzip = spawn('python3', [UNZIP, file], { stdio: ['ignore', 'pipe', 'pipe'] });
  const notes = [];
  unzip.stderr.setEncoding('utf8');
  unzip.stderr.on('data', (t) => { for (const l of t.split('\n')) if (l.trim() && notes.length < 30) notes.push(l.trim()); });
  const exited = new Promise((ok) => unzip.on('close', (code, signal) => ok(signal || code)));
  try {
    return await importStream(db, name, unzip.stdout, {
      check: async () => {
        const c = await exited;
        if (c === 3) { console.warn(`${name}: часть файлов архива повреждена, загружено остальное — ${notes.join('; ')}`); return; }
        if (c !== 0) {
          fs.rmSync(file, { force: true });
          throw new Error(`${name}: архив повреждён (${c}) — удалён, при следующем запуске скачается заново. ${notes.join('; ')}`);
        }
      }
    });
  } finally { if (unzip.exitCode === null && unzip.signalCode === null) unzip.kill(); }
}

async function latestZip(name) {
  const r = await fetch(`https://www.nalog.gov.ru/opendata/7707329152-${name}/`, { headers: UA, signal: AbortSignal.timeout(30000) });
  const html = await r.text();
  const link = html.match(new RegExp(`https?://[^"]+7707329152-${name}/data-[^"]+\\.zip`))?.[0];
  if (!link) throw new Error(name + ': не найдена ссылка на архив');
  return link;
}

// Сверка скачанного файла с ETag хранилища (file.nalog.ru — S3): «md5» для целого файла или «md5-N» для загрузки
// частями — md5 от склеенных md5 N частей одинакового размера (целое число МиБ). true — совпало, false — файл
// испорчен, null — проверить нельзя (ETag другого вида или размер части не подобрать).
export async function etagCheck(file, etag) {
  const m = /^(?:W\/)?"?([0-9a-f]{32})(?:-(\d+))?"?$/i.exec(String(etag || '').trim());
  if (!m) return null;
  const size = fs.statSync(file).size, parts = Number(m[2] || 0);
  const md5 = () => crypto.createHash('md5');
  if (!parts) {
    const h = md5();
    await pipeline(fs.createReadStream(file), h);
    return h.digest('hex') === m[1].toLowerCase();
  }
  // размер части — целое число МиБ, при котором частей ровно N; если подходящих размеров много, сверить нельзя
  const MiB = 1024 * 1024, sizes = [];
  for (let p = 1; p <= 5120; p++) if (Math.ceil(size / (p * MiB)) === parts) sizes.push(p * MiB);
  if (!sizes.length || sizes.length > 3) return null;
  for (const part of sizes) {
    const whole = md5();
    for (let off = 0; off < size; off += part) {
      const h = md5();
      await pipeline(fs.createReadStream(file, { start: off, end: Math.min(off + part, size) - 1 }), h);
      whole.update(h.digest());
    }
    if (whole.digest('hex') === m[1].toLowerCase()) return true;
  }
  return false;
}

// Архивы бывают по несколько гигабайт, а сервер ФНС иногда обрывает соединение посреди скачивания («terminated»).
// Поэтому качаем в .part и при обрыве продолжаем с места остановки (Range), несколько попыток с паузой.
// Докачиваем, только если уверены, что это тот же файл и продолжение ровно с нужного байта: версия файла (ETag или
// Last-Modified) хранится рядом в .part.v и отправляется в If-Range — если файл на сервере поменялся, придёт целиком (200).
// Нет сохранённой версии или сервер начал не с того байта — начинаем заново: склеенный из кусков архив хуже, чем лишняя загрузка.
export async function download(url, file, { fetchImpl = fetch, attempts = 8, wait = 30e3 } = {}) {
  if (fs.existsSync(file)) return false;
  const tmp = file + '.part', ver = tmp + '.v';
  const reset = () => { fs.rmSync(tmp, { force: true }); fs.rmSync(ver, { force: true }); };
  let err;
  for (let i = 1; i <= attempts; i++) {
    if (fs.existsSync(tmp) && !fs.existsSync(ver)) reset();
    const have = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
    try {
      const headers = have ? { ...UA, Range: `bytes=${have}-`, 'If-Range': fs.readFileSync(ver, 'utf8') } : UA;
      const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(60 * 60e3) });
      if (!r.ok) { if (r.status === 416) reset(); throw new Error('скачивание ' + r.status); }
      const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(r.headers.get('content-range') || '');
      const resumed = r.status === 206;
      if (resumed && (!range || Number(range[1]) !== have)) { reset(); throw new Error(`сервер продолжил не с ${have} байта`); }
      if (!resumed) fs.writeFileSync(ver, r.headers.get('etag') || r.headers.get('last-modified') || '');   // файл целиком — с нуля
      if (!fs.readFileSync(ver, 'utf8')) fs.rmSync(ver);                                                  // без версии докачивать нельзя
      const total = resumed ? Number(range[2]) : Number(r.headers.get('content-length')) || 0;
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp, { flags: resumed ? 'a' : 'w' }));
      const size = fs.statSync(tmp).size;
      if (total && size !== total) throw new Error(`скачано ${size} из ${total} байт`);
      const sum = await etagCheck(tmp, fs.existsSync(ver) ? fs.readFileSync(ver, 'utf8') : '');
      if (sum === false) { reset(); throw new Error('контрольная сумма не совпала с ETag — файл испорчен при скачивании, качаю заново'); }
      fs.renameSync(tmp, file);
      fs.rmSync(ver, { force: true });
      return true;
    } catch (e) {
      err = e;
      if (i < attempts) { console.log(`  обрыв (${e.message}), продолжаю с ${fs.existsSync(tmp) ? fs.statSync(tmp).size : 0} байт, попытка ${i + 1} из ${attempts}`); await new Promise((ok) => setTimeout(ok, wait)); }
    }
  }
  throw err;
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const db = openFnsDb(DB);
  let fresh = false;
  for (const name of Object.keys(DATASETS)) {
    try {
      const link = await latestZip(name);
      const file = path.join(DIR, `${name}-${path.basename(link)}`);
      const seen = db.prepare('SELECT file FROM fns_meta WHERE dataset = ?').get(name);
      if (seen && seen.file === path.basename(file) && !process.env.FORCE) { console.log(`${name}: уже загружен ${seen.file}`); continue; }
      console.log(`${name}: ${await download(link, file) ? 'скачан' : 'уже скачан'} ${path.basename(file)}`);
      const rows = await importZip(db, name, file);
      db.prepare('INSERT OR REPLACE INTO fns_meta (dataset, file, rows, loaded_at) VALUES (?, ?, ?, ?)').run(name, path.basename(file), rows, new Date().toISOString());
      console.log(`${name}: загружено ${rows} организаций`);
      if (name === 'revexp' || name === 'rsmp') fresh = true;
      // старые архивы этого набора больше не нужны
      for (const f of fs.readdirSync(DIR)) if (f.startsWith(name + '-') && f !== path.basename(file)) fs.rmSync(path.join(DIR, f));
    } catch (e) { console.error(`${name}: ошибка — ${e.message}`); process.exitCode = 1; }
  }
  if (fresh || process.env.FORCE) {
    try { console.log(`Статистика похожих компаний: ${buildPeers(db)} групп`); }
    catch (e) { console.error(`Статистика похожих компаний: ошибка — ${e.message}`); process.exitCode = 1; }
  }
  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) main();

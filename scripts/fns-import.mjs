// Импорт открытых данных ФНС по всем организациям России в SQLite (без капчи и лимитов, в отличие от pb.nalog.ru):
//   snr      — специальные налоговые режимы (УСН, АУСН, ЕСХН, СРП)
//   sshr2019 — среднесписочная численность
//   paytax   — уплаченные налоги и взносы за год
//   debtam   — налоговая задолженность, пени и штрафы
// Источник: https://www.nalog.gov.ru/opendata/  (наборы 7707329152-*). ФНС обновляет их раз в месяц, около 25 числа.
// Запуск на сервере: node scripts/fns-import.mjs /var/lib/sut/fns.db   (нужна утилита unzip)
// Данные только по юрлицам: по ИП ФНС такие наборы не публикует.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';

const DB = process.argv[2] || '/var/lib/sut/fns.db';
const DIR = process.env.FNS_OPENDATA_DIR || path.join(path.dirname(DB), 'opendata');
const UA = { 'User-Agent': 'Mozilla/5.0 (fin-check.shop opendata import)' };
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
  }
};

const SCHEMA = {
  fns_regime: '(inn TEXT PRIMARY KEY, usn INT, ausn INT, eshn INT, srp INT, asof TEXT)',
  fns_staff: '(inn TEXT PRIMARY KEY, n INT, asof TEXT)',
  fns_tax: '(inn TEXT PRIMARY KEY, total REAL, items TEXT, asof TEXT)',
  fns_debt: '(inn TEXT PRIMARY KEY, total REAL, items TEXT, asof TEXT)'
};
export function openFnsDb(file, readOnly = false) {
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS fns_meta (dataset TEXT PRIMARY KEY, file TEXT, rows INT, loaded_at TEXT)');
    for (const [t, cols] of Object.entries(SCHEMA)) db.exec(`CREATE TABLE IF NOT EXISTS ${t} ${cols}`);
  }
  return db;
}

// Разбор потока XML по документам: <Документ ...>…</Документ>
export async function importStream(db, name, stream) {
  const ds = DATASETS[name];
  const tmp = ds.table + '_new';
  // та же схема с первичным ключом: одна компания может встретиться в двух файлах выгрузки — оставляем последнюю запись
  db.exec(`DROP TABLE IF EXISTS ${tmp}; CREATE TABLE ${tmp} ${SCHEMA[ds.table]}`);
  const ins = db.prepare(`INSERT OR REPLACE INTO ${tmp} (${ds.columns}) VALUES (${ds.columns.split(',').map(() => '?').join(', ')})`);
  let buf = '', rows = 0;
  db.exec('BEGIN');
  const flush = (final) => {
    let end;
    while ((end = buf.indexOf('</Документ>')) !== -1) {
      const start = buf.lastIndexOf('<Документ ', end);
      const doc = buf.slice(start, end);
      buf = buf.slice(end + 11);
      const inn = doc.match(/ИННЮЛ="(\d{10})"/)?.[1];
      if (!inn) continue;
      ins.run(inn, ...ds.row(doc, date(attrs(doc.match(/<Документ [^>]*>/)[0]).ДатаСост)));
      if (++rows % 100000 === 0) { db.exec('COMMIT; BEGIN'); process.stdout.write(`  ${name}: ${rows}\r`); }
    }
    if (final) buf = '';
    else if (buf.length > 1e6 && buf.indexOf('<Документ ') === -1) buf = buf.slice(-1000);
  };
  for await (const chunk of stream) { buf += chunk.toString('utf8'); flush(false); }
  flush(true);
  db.exec('COMMIT');
  if (rows === 0) throw new Error(name + ': ни одной записи — формат изменился?');
  db.exec(`BEGIN; DROP TABLE ${ds.table}; ALTER TABLE ${tmp} RENAME TO ${ds.table}; COMMIT`);
  return rows;
}

async function latestZip(name) {
  const r = await fetch(`https://www.nalog.gov.ru/opendata/7707329152-${name}/`, { headers: UA, signal: AbortSignal.timeout(30000) });
  const html = await r.text();
  const link = html.match(new RegExp(`https?://[^"]+7707329152-${name}/data-[^"]+\\.zip`))?.[0];
  if (!link) throw new Error(name + ': не найдена ссылка на архив');
  return link;
}

async function download(url, file) {
  if (fs.existsSync(file)) return false;
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20 * 60e3) });
  if (!r.ok) throw new Error('скачивание ' + r.status);
  const tmp = file + '.part';
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));   // потоком: архивы до сотен мегабайт
  fs.renameSync(tmp, file);
  return true;
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const db = openFnsDb(DB);
  for (const name of Object.keys(DATASETS)) {
    try {
      const link = await latestZip(name);
      const file = path.join(DIR, `${name}-${path.basename(link)}`);
      const seen = db.prepare('SELECT file FROM fns_meta WHERE dataset = ?').get(name);
      if (seen && seen.file === path.basename(file) && !process.env.FORCE) { console.log(`${name}: уже загружен ${seen.file}`); continue; }
      console.log(`${name}: ${await download(link, file) ? 'скачан' : 'уже скачан'} ${path.basename(file)}`);
      const unzip = spawn('unzip', ['-p', file]);
      const rows = await importStream(db, name, unzip.stdout);
      db.prepare('INSERT OR REPLACE INTO fns_meta (dataset, file, rows, loaded_at) VALUES (?, ?, ?, ?)').run(name, path.basename(file), rows, new Date().toISOString());
      console.log(`${name}: загружено ${rows} организаций`);
      // старые архивы этого набора больше не нужны
      for (const f of fs.readdirSync(DIR)) if (f.startsWith(name + '-') && f !== path.basename(file)) fs.rmSync(path.join(DIR, f));
    } catch (e) { console.error(`${name}: ошибка — ${e.message}`); process.exitCode = 1; }
  }
  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) main();

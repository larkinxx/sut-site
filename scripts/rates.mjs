// Обновляет ключевую ставку и годовую инфляцию в config/finance.json по данным Банка России.
// Запускается при каждом сборе новостей (pipeline.yml). Если cbr.ru не ответил — оставляет прежние значения.
// Запуск: npm run rates
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/lib/content.mjs';

const FILE = path.join(ROOT, 'config', 'finance.json');
const UA = { 'User-Agent': 'Mozilla/5.0 (sut-site rates)' };
const ru = (d) => d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
const num = (s) => parseFloat(s.replace(',', '.'));

async function page(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
  return r.text();
}

// Ключевая ставка: таблица «дата — ставка», новые строки сверху
export function parseKeyRate(html) {
  const rows = [...html.matchAll(/<td>(\d\d)\.(\d\d)\.(\d{4})<\/td>\s*<td>([\d,]+)<\/td>/g)]
    .map((m) => ({ date: `${m[3]}-${m[2]}-${m[1]}`, rate: num(m[4]) }));
  if (!rows.length) return null;
  let since = rows[0].date;
  for (const r of rows) { if (r.rate !== rows[0].rate) break; since = r.date; }
  return { rate: rows[0].rate, since };
}

// Инфляция: «месяц.год — ключевая ставка — инфляция, % г/г — цель»
export function parseInflation(html) {
  const m = html.match(/<td>(\d\d)\.(\d{4})<\/td>\s*<td>[\d,]+<\/td>\s*<td>([\d,]+)<\/td>/);
  return m ? { value: num(m[3]), month: `${m[2]}-${m[1]}` } : null;
}

async function main() {
  const fin = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const to = new Date(), from = new Date(Date.now() - 400 * 864e5);
  const q = `?UniDbQuery.Posted=True&UniDbQuery.From=${ru(from)}&UniDbQuery.To=${ru(to)}`;
  let changed = false;
  try {
    const k = parseKeyRate(await page('https://www.cbr.ru/hd_base/KeyRate/' + q));
    if (k && (k.rate !== fin.keyRate || k.since !== fin.keyRateSince)) { fin.keyRate = k.rate; fin.keyRateSince = k.since; changed = true; }
    console.log('Ключевая ставка:', k ? `${k.rate}% с ${k.since}` : 'не распознана');
  } catch (e) { console.warn('Ключевая ставка не обновлена:', e.message); }
  try {
    const i = parseInflation(await page('https://www.cbr.ru/hd_base/infl/' + q));
    if (i && (!fin.inflation || i.value !== fin.inflation.value || i.month !== fin.inflation.month)) { fin.inflation = i; changed = true; }
    console.log('Инфляция:', i ? `${i.value}% за ${i.month}` : 'не распознана');
  } catch (e) { console.warn('Инфляция не обновлена:', e.message); }
  if (changed) fs.writeFileSync(FILE, JSON.stringify(fin, null, 2) + '\n');
  console.log(changed ? 'config/finance.json обновлён' : 'Изменений нет');
}

if (import.meta.url === `file://${process.argv[1]}`) main();

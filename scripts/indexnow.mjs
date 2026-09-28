// IndexNow: сообщить Яндексу о новых и изменившихся страницах сразу, а не ждать, пока робот зайдёт сам.
// Запускается в конце deploy/site-build.sh. Сравнивает карты сайта с прошлой отправкой (файл состояния) и отправляет
// только разницу. Ключ публичный по протоколу: он же лежит на сайте в /<ключ>.txt. Ошибка отправки сборку не ломает —
// состояние не обновляется, и следующий запуск отправит те же адреса.
// Запуск: node scripts/indexnow.mjs [--dry]   Окружение: SITE_URL, INDEXNOW_STATE, INDEXNOW=0 — выключить.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KEY = '8b8bbce99ea50af58d65819655c5527f';
const ENDPOINT = 'https://yandex.com/indexnow';
const BATCH = 10000;   // предел протокола на один запрос

export function parseSitemap(xml) {
  const out = new Map();
  for (const m of String(xml).matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?/g)) out.set(m[1].trim(), (m[2] || '').trim());
  return out;
}

// новые адреса и те, у которых сменилась дата изменения
export function diffUrls(prev, cur) {
  const list = [];
  for (const [u, lm] of cur) if (!(u in prev) || prev[u] !== lm) list.push(u);
  return list;
}

export async function ping(urls, { site, fetchImpl = fetch }) {
  const host = new URL(site).host;
  for (let i = 0; i < urls.length; i += BATCH) {
    const r = await fetchImpl(ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host, key: KEY, keyLocation: `${site}/${KEY}.txt`, urlList: urls.slice(i, i + BATCH) }),
      signal: AbortSignal.timeout(30000)
    });
    if (r.status !== 200 && r.status !== 202) throw new Error(`IndexNow ответил ${r.status}`);
  }
}

async function main() {
  if (process.env.INDEXNOW === '0') return;
  const dry = process.argv.includes('--dry');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const site = (process.env.SITE_URL || 'https://inn-sider.ru').replace(/\/$/, '');
  const stateFile = process.env.INDEXNOW_STATE || '/var/lib/sut/indexnow.json';
  const cur = parseSitemap(fs.readFileSync(path.join(root, 'dist', 'sitemap.xml'), 'utf8'));
  // страницы отраслей собирает сервер: их карту берём у него
  try {
    const r = await fetch((process.env.API_LOCAL || 'http://127.0.0.1:3000') + '/sitemap-otrasli.xml', { signal: AbortSignal.timeout(20000) });
    if (r.ok) for (const [u, lm] of parseSitemap(await r.text())) cur.set(u, lm);
  } catch { /* сервер недоступен — отправим только статические страницы */ }
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { prev = {}; }
  const urls = diffUrls(prev, cur).filter((u) => u.startsWith(site + '/'));
  if (!urls.length) return;
  if (dry) { console.log(`IndexNow (проба): ${urls.length} адресов, например ${urls.slice(0, 3).join(' ')}`); return; }
  await ping(urls, { site });
  fs.writeFileSync(stateFile, JSON.stringify(Object.fromEntries(cur)));
  console.log(`IndexNow: Яндексу отправлено адресов — ${urls.length}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('IndexNow:', e.message); });
}

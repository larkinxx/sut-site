// Сбор новостей из RSS-лент (config/sources.json) в content/raw/.
// Запуск: npm run fetch
// Для проверки без интернета: node scripts/fetch.mjs --file пример.xml --source cbr-press
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, readJson } from '../src/lib/content.mjs';
import { parseFeed, decodeBody, stripHtml } from '../src/lib/rss.mjs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : null; };
const RAW = path.join(ROOT, 'content/raw');
fs.mkdirSync(RAW, { recursive: true });

const cfg = readJson('config/sources.json');
const maxAge = (cfg.maxAgeHours || 48) * 3600e3;
const UA = 'Mozilla/5.0 (compatible; SutSiteBot/0.1; +news-digest)';

async function get(url, ms = 20000) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/html;q=0.8, */*;q=0.5' }, signal: AbortSignal.timeout(ms), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return decodeBody(new Uint8Array(await res.arrayBuffer()), res.headers.get('content-type') || '');
}

// Полный текст страницы нужен, чтобы черновик не строился на одном заголовке. Ошибка здесь не страшна.
async function articleText(url) {
  try {
    const html = await get(url, 15000);
    const body = (html.match(/<article[\s\S]*?<\/article>/i) || html.match(/<main[\s\S]*?<\/main>/i) || [html])[0];
    return stripHtml(body).slice(0, 6000);
  } catch {
    return '';
  }
}

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

async function loadXml(src) {
  const file = opt('--file');
  if (file) return fs.readFileSync(file, 'utf8');
  return get(src.url);
}

const only = opt('--source');
const sources = cfg.sources.filter((s) => (only ? s.id === only : s.enabled && s.url));
if (opt('--file') && !only) { console.error('С --file укажите --source <id>'); process.exit(1); }

let added = 0;
const failed = [];
for (const src of sources) {
  let xml;
  try {
    xml = await loadXml(src);
  } catch (err) {
    failed.push(`${src.id}: ${err.message}`);
    console.warn(`! Лента ${src.id} недоступна: ${err.message}`);
    continue;
  }
  const items = parseFeed(xml);
  let n = 0;
  for (const it of items) {
    const ts = it.pubDate ? Date.parse(it.pubDate) : Date.now();
    if (Date.now() - ts > maxAge && !opt('--file')) continue;
    const id = `${src.id}-${hash(it.guid || it.link)}`;
    const file = path.join(RAW, `${id}.json`);
    if (fs.existsSync(file)) continue;
    let text = it.text;
    if (text.length < 400 && !opt('--file')) text = (await articleText(it.link)) || text;
    fs.writeFileSync(file, JSON.stringify({
      id, sourceId: src.id, sourceName: src.name, kind: src.kind || '',
      title: it.title, url: it.link, publishedAt: it.pubDate || new Date().toISOString(),
      text, fetchedAt: new Date().toISOString(), drafted: false
    }, null, 2) + '\n');
    n++; added++;
  }
  console.log(`${src.id}: в ленте ${items.length}, новых ${n}`);
}
console.log(`Итого новых материалов: ${added}`);
if (sources.length && failed.length === sources.length) {
  console.error('Ни одна лента не открылась. Если запуск идёт на GitHub, возможно, сайт ведомства блокирует его серверы — см. README, раздел «Если ленты не открываются».');
  process.exit(2);
}

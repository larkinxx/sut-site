// Тесты IndexNow (scripts/indexnow.mjs): разбор карты сайта, разница с прошлой отправкой, запрос к Яндексу
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSitemap, diffUrls, ping, KEY } from './indexnow.mjs';

const xml = '<urlset><url><loc>https://inn-sider.ru/</loc><lastmod>2026-09-28T01:00:00Z</lastmod></url>\n<url><loc>https://inn-sider.ru/yurist/</loc></url></urlset>';
const cur = parseSitemap(xml);
assert.deepEqual([...cur], [['https://inn-sider.ru/', '2026-09-28T01:00:00Z'], ['https://inn-sider.ru/yurist/', '']]);
assert.deepEqual(diffUrls({}, cur), ['https://inn-sider.ru/', 'https://inn-sider.ru/yurist/'], 'первый запуск — всё');
assert.deepEqual(diffUrls(Object.fromEntries(cur), cur), [], 'ничего не поменялось — ничего не шлём');
assert.deepEqual(diffUrls({ 'https://inn-sider.ru/': '2026-09-27T00:00:00Z', 'https://inn-sider.ru/yurist/': '' }, cur), ['https://inn-sider.ru/'], 'сменилась дата — шлём');

let sent = null;
await ping(['https://inn-sider.ru/'], { site: 'https://inn-sider.ru', fetchImpl: async (u, o) => { sent = { u, body: JSON.parse(o.body) }; return new Response('', { status: 202 }); } });
assert.equal(sent.u, 'https://yandex.com/indexnow');
assert.deepEqual(sent.body, { host: 'inn-sider.ru', key: KEY, keyLocation: `https://inn-sider.ru/${KEY}.txt`, urlList: ['https://inn-sider.ru/'] });
await assert.rejects(ping(['https://inn-sider.ru/'], { site: 'https://inn-sider.ru', fetchImpl: async () => new Response('', { status: 403 }) }), /403/);
assert.equal(fs.readFileSync(new URL(`../public/${KEY}.txt`, import.meta.url), 'utf8').trim(), KEY, 'файл ключа на сайте совпадает');
console.log('Все тесты IndexNow прошли: 4');

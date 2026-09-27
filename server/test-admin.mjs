// Тесты панели владельца без сети: доступ по ключу, лимит попыток, счётчики и сводка.  Запуск: node server/test-admin.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { createApp } from './index.mjs';
import { openDb } from './accounts.mjs';
import { openFnsDb } from '../scripts/fns-import.mjs';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok  ', name); };
const KEY = 'k'.repeat(32);
async function serve(app, fn) {
  const srv = http.createServer(app); await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await fn(base); } finally { srv.close(); }
}
const stats = (base, key) => fetch(base + '/api/admin/stats', { headers: key ? { Authorization: 'Bearer ' + key } : {} });

await t('без ключа или с коротким ключом панели нет', async () => {
  await serve(createApp({ env: {} }), async (b) => assert.equal((await stats(b, KEY)).status, 404));
  await serve(createApp({ env: { ADMIN_TOKEN: 'short' } }), async (b) => assert.equal((await stats(b, 'short')).status, 404));
});

await t('неверный ключ — 401, после 10 попыток — 429 даже с верным', async () => {
  await serve(createApp({ env: { ADMIN_TOKEN: KEY } }), async (b) => {
    assert.equal((await stats(b)).status, 401, 'без заголовка');
    for (let i = 0; i < 9; i++) assert.equal((await stats(b, 'x'.repeat(32))).status, 401);
    assert.equal((await stats(b, KEY)).status, 429, 'подбор остановлен');
  });
});

await t('сводка: счётчики по дням, пользователи, подписки, данные ФНС — без ИНН и адресов', async () => {
  const db = openDb(':memory:'), fdb = openFnsDb(':memory:');
  db.prepare('INSERT INTO users (created_at, consent_at, last_seen, email) VALUES (?, ?, ?, ?)').run(Date.now(), Date.now(), Date.now(), 'a@b.ru');
  fdb.prepare('INSERT INTO fns_meta (dataset, file, rows, loaded_at) VALUES (?, ?, ?, ?)').run('rsmp', 'x.zip', 2029230, '2026-09-27T20:43:23Z');
  await serve(createApp({ env: { ADMIN_TOKEN: KEY }, db, fnsDb: fdb }), async (b) => {
    for (let i = 0; i < 3; i++) await fetch(b + '/api/market', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"okved":"56","region":"54"}' });
    const r = await stats(b, KEY);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.usage.length, 30, '30 дней');
    assert.equal(j.usage.at(-1).market, 3, 'сегодня 3 запроса статистики');
    assert.equal(j.users.total, 1);
    assert.equal(j.subscriptions.active, 0);
    assert.deepEqual(j.fns.datasets[0], { dataset: 'rsmp', rows: 2029230, loadedAt: '2026-09-27T20:43:23Z' });
    const text = JSON.stringify(j);
    assert.ok(!text.includes('a@b.ru') && !text.includes('127.0.0.1'), 'ни почты, ни адресов');
  });
});

console.log(`\nВсе тесты панели прошли: ${n}`);

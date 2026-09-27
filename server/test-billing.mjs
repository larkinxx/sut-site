// Тесты подписки без сети: ЮKassa, DaData и DataNewton подменены заглушками.  Запуск: node server/test-billing.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { createApp } from './index.mjs';
import crypto from 'node:crypto';
import { openDb } from './accounts.mjs';
import { createBilling } from './billing.mjs';

const SITE = 'http://localhost:4173';
const INNS = ['7707083893', '7736207543', '7702070139', '7728168971', '7710140679'];
const yk = new Map();           // платежи «в ЮKassa»
let ykN = 0;
const ykCalls = [];
async function fakeFetch(url, opts = {}) {
  const u = new URL(String(url));
  if (u.hostname.includes('dadata')) {
    const q = JSON.parse(opts.body).query;
    return new Response(JSON.stringify({ suggestions: INNS.includes(q) ? [{ value: 'ООО "Т' + q + '"', data: { inn: q, type: 'LEGAL', name: { short_with_opf: 'ООО "Т' + q + '"' }, state: { status: 'ACTIVE' } } }] : [] }));
  }
  if (u.hostname === 'api.datanewton.ru') {
    if (u.pathname === '/v1/arbitration-cases') return new Response(JSON.stringify({ total_cases: 1, data: [] }));
    return new Response(JSON.stringify({ total: 0, data: [] }));
  }
  if (u.hostname === 'api.yookassa.ru') {
    assert.equal(opts.headers.Authorization, 'Basic ' + Buffer.from('shop:sk').toString('base64'));
    ykCalls.push(opts.method + ' ' + u.pathname);
    if (opts.method === 'POST') {
      assert.ok(opts.headers['Idempotence-Key']);
      const b = JSON.parse(opts.body);
      const id = 'pay-000000' + (++ykN);
      const p = { id, status: b.payment_method_id ? 'succeeded' : 'pending', amount: b.amount, metadata: b.metadata,
        confirmation: b.confirmation ? { type: 'redirect', confirmation_url: 'https://yoomoney.ru/checkout/' + id } : undefined,
        payment_method: b.payment_method_id ? { id: b.payment_method_id, saved: true } : { id: 'pm-' + id, saved: !!b.save_payment_method }, _body: b };
      yk.set(id, p); return new Response(JSON.stringify(p));
    }
    const p = yk.get(u.pathname.split('/').pop());
    return p ? new Response(JSON.stringify(p)) : new Response('{}', { status: 404 });
  }
  throw new Error('неожиданный запрос ' + u);
}

const env = { DADATA_TOKEN: 't', DATANEWTON_KEY: 'dn', SITE_URL: SITE, ALLOWED_ORIGINS: SITE, YOOKASSA_SHOP_ID: 'shop', YOOKASSA_SECRET_KEY: 'sk', YOOKASSA_RECURRING: '1' };
let clock = Date.UTC(2026, 8, 26, 9, 0);
const DAY = 864e5;
const db = openDb(':memory:');
const server = http.createServer(createApp({ env, fetchImpl: fakeFetch, db, now: () => clock }));
await new Promise((r) => server.listen(0, r));
const base = 'http://127.0.0.1:' + server.address().port;
async function call(method, p, { body, cookie, origin = SITE, ip } = {}) {
  const r = await fetch(base + p, {
    method, headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...(ip ? { 'x-forwarded-for': ip } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
// пользователь и сессия напрямую в базе (вход проверяется в test-accounts.mjs)
function login(email) {
  const uid = db.prepare('INSERT INTO users (created_at, consent_at, email) VALUES (?, ?, ?)').run(clock, clock, email).lastInsertRowid;
  const tok = 'tok-' + email;
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(crypto.createHash('sha256').update(tok).digest('hex'), uid, clock, clock + 90 * DAY);
  return { uid: Number(uid), cookie: 'sut_s=' + tok };
}

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok  ', name); };
try {
  const a = login('a@example.ru');

  await t('тарифы видны без входа, оплата — только после входа', async () => {
    const r = await call('GET', '/api/billing');
    assert.equal(r.json.enabled, true);
    assert.deepEqual(r.json.plans, { month: { price: 290, title: 'месяц' }, year: { price: 2490, title: 'год' } });
    assert.equal(r.json.pro, false);
    assert.equal((await call('POST', '/api/billing/pay', { body: { plan: 'month' } })).status, 401);
    assert.equal((await call('POST', '/api/billing/pay', { body: { plan: 'forever' }, cookie: a.cookie })).status, 400);
  });

  await t('бесплатно — 3 новые проверки судов в день; повтор того же ИНН и уже загруженные — не считаются', async () => {
    for (const inn of INNS.slice(0, 3)) assert.equal((await call('POST', '/api/org/courts', { body: { inn }, ip: '1.1.1.1' })).json.arbitration.total, 1);
    assert.equal((await call('POST', '/api/org/courts', { body: { inn: INNS[0] }, ip: '1.1.1.1' })).json.arbitration.total, 1, 'из кеша');
    const r = await call('POST', '/api/org/courts', { body: { inn: INNS[3] }, ip: '1.1.1.1' });
    assert.equal(r.json.paywall, true);
    assert.equal(r.json.free, 3);
    assert.equal((await call('POST', '/api/org/courts', { body: { inn: INNS[1] }, ip: '2.2.2.2' })).json.arbitration.total, 1, 'загруженные кем-то — всем бесплатно');
    clock += DAY;
    assert.equal((await call('POST', '/api/org/courts', { body: { inn: INNS[3] }, ip: '1.1.1.1' })).json.arbitration.total, 1, 'на следующий день снова можно');
  });

  await t('бесплатное слежение — 3 компании', async () => {
    for (const inn of INNS.slice(0, 3)) assert.equal((await call('POST', '/api/watch', { body: { inn }, cookie: a.cookie })).status, 200);
    const r = await call('POST', '/api/watch', { body: { inn: INNS[3] }, cookie: a.cookie });
    assert.equal(r.status, 400); assert.equal(r.json.paywall, true);
  });

  let payId;
  await t('оплата: платёж в ЮKassa, возврат на кабинет, до оплаты подписки нет', async () => {
    const r = await call('POST', '/api/billing/pay', { body: { plan: 'month', autorenew: true }, cookie: a.cookie });
    assert.match(r.json.url, /^https:\/\/yoomoney\.ru\/checkout\//);
    payId = r.json.id;
    const b = yk.get(payId)._body;
    assert.deepEqual(b.amount, { value: '290.00', currency: 'RUB' });
    assert.equal(b.save_payment_method, true);
    assert.equal(b.confirmation.return_url, SITE + '/kabinet/?oplata=1');
    assert.equal((await call('POST', '/api/billing/check', { body: {}, cookie: a.cookie })).json.pro, false);
  });

  await t('уведомление ЮKassa: статус перезапрашиваем, поддельная сумма не проходит, повтор не продлевает дважды', async () => {
    // уведомлению с «succeeded» в теле не верим — в ЮKassa платёж ещё pending
    await call('POST', '/billing/yookassa', { origin: null, body: { event: 'payment.succeeded', object: { id: payId, status: 'succeeded' } } });
    assert.equal((await call('GET', '/api/billing', { cookie: a.cookie })).json.pro, false);
    yk.get(payId).status = 'succeeded';
    yk.get(payId).amount = { value: '2.00', currency: 'RUB' };
    await call('POST', '/billing/yookassa', { origin: null, body: { object: { id: payId } } });
    assert.equal((await call('GET', '/api/billing', { cookie: a.cookie })).json.pro, false, 'сумма не совпала');
    yk.get(payId).amount = { value: '290.00', currency: 'RUB' };
    await call('POST', '/billing/yookassa', { origin: null, body: { object: { id: payId } } });
    await call('POST', '/billing/yookassa', { origin: null, body: { object: { id: payId } } });
    const s = (await call('GET', '/api/billing', { cookie: a.cookie })).json;
    assert.equal(s.pro, true); assert.equal(s.plan, 'month'); assert.equal(s.autorenew, true);
    assert.equal(s.paid_until, clock + 30 * DAY);
    assert.equal((await call('POST', '/billing/yookassa', { origin: null, body: { object: { id: 'pay-чужой-неизвестный' } } })).status, 200);
  });

  await t('с подпиской: суды без дневного лимита, слежение до 50', async () => {
    for (const inn of INNS) assert.ok(!(await call('POST', '/api/org/courts', { body: { inn }, cookie: a.cookie, ip: '3.3.3.3' })).json.paywall);
    assert.equal((await call('POST', '/api/watch', { body: { inn: INNS[3] }, cookie: a.cookie })).status, 200);
    assert.equal((await call('POST', '/api/org', { body: { inn: INNS[0] }, cookie: a.cookie })).json.pro, true);
  });

  await t('автопродление: предупреждение за 3 дня, списание в последние сутки', async () => {
    const sent = [];
    const bill = createBilling({ env, db, fetchImpl: fakeFetch, now: () => clock, notify: async (u, text) => sent.push(text) });
    const until = db.prepare('SELECT paid_until FROM subscriptions WHERE user_id = ?').get(a.uid).paid_until;
    clock = until - 2.5 * DAY;
    await bill.runRenew();
    assert.equal(sent.length, 1); assert.match(sent[0], /290 ₽/);
    await bill.runRenew();
    assert.equal(sent.length, 1, 'предупреждаем один раз');
    clock = until - 0.5 * DAY;
    assert.equal((await bill.runRenew()).charged, 1);
    assert.equal(db.prepare('SELECT paid_until FROM subscriptions WHERE user_id = ?').get(a.uid).paid_until, until + 30 * DAY);
    assert.equal((await bill.runRenew()).charged, 0, 'второй раз не списываем');
  });

  await t('отключение автопродления и удаление аккаунта', async () => {
    const r = await call('POST', '/api/billing/autorenew', { body: { on: false }, cookie: a.cookie });
    assert.equal(r.json.autorenew, false); assert.equal(r.json.pro, true);
    assert.equal(db.prepare('SELECT method_id FROM subscriptions WHERE user_id = ?').get(a.uid).method_id, null, 'карта забыта');
    await call('DELETE', '/api/me', { cookie: a.cookie });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments WHERE user_id IS NULL').get().n, 2, 'платежи остаются для учёта, без привязки к человеку');
  });

  await t('без ключей ЮKassa всё бесплатно, как раньше', async () => {
    const db2 = openDb(':memory:');
    const b = createBilling({ env: { SITE_URL: SITE }, db: db2, fetchImpl: fakeFetch });
    assert.equal(b.enabled, false);
    assert.equal(b.watchLimit({ id: 1 }), 50);
    for (let i = 0; i < 10; i++) assert.equal(b.allowCourts(null, 'x', String(i)), true);
  });

  console.log(`\nВсе тесты подписки прошли: ${n}`);
} finally {
  server.close();
}

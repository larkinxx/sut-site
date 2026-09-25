// Тесты аккаунтов без сети: DaData, Яндекс, Telegram и почта подменены заглушками.  Запуск: node server/test-accounts.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createApp } from './index.mjs';
import { openDb, telegramCheck, diffSnapshots } from './accounts.mjs';

const SITE = 'http://localhost:4173';
const BOT = '123:TEST';
let party = { status: 'ACTIVE', debt: 0 };
const PARTY = () => ({
  value: 'ООО "РОМАШКА"',
  data: { inn: '7707083893', type: 'LEGAL', branch_type: 'MAIN', name: { short_with_opf: 'ООО "РОМАШКА"' },
    state: { status: party.status }, management: { name: 'Иванов И. И.' }, address: { value: 'г Москва' }, finance: { debt: party.debt, penalty: 0 } }
});
const mails = [], tgSent = [], tgQueue = [];
async function fakeFetch(url, opts = {}) {
  const u = String(url);
  if (u.includes('dadata')) {
    const q = JSON.parse(opts.body).query;
    return new Response(JSON.stringify({ suggestions: q === '7707083893' ? [PARTY()] : [] }));
  }
  if (u === 'https://oauth.yandex.ru/token') {
    assert.equal(new URLSearchParams(opts.body).get('code'), 'good-code');
    return new Response(JSON.stringify({ access_token: 'yt' }));
  }
  if (u.startsWith('https://login.yandex.ru/info')) {
    assert.equal(opts.headers.Authorization, 'OAuth yt');
    return new Response(JSON.stringify({ id: '555', default_email: 'Ivan@Example.ru', real_name: 'Иван Петров' }));
  }
  if (u.startsWith('https://api.telegram.org/')) {
    if (u.endsWith('/getUpdates')) return new Response(JSON.stringify({ ok: true, result: tgQueue.splice(0) }));
    tgSent.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ ok: true, result: {} }));
  }
  throw new Error('неожиданный запрос ' + u);
}
const mailer = async (m) => { mails.push(m); };

const env = {
  DADATA_TOKEN: 't', SITE_URL: SITE, PUBLIC_API_URL: 'http://api.localhost', ALLOWED_ORIGINS: SITE,
  YANDEX_CLIENT_ID: 'yid', YANDEX_CLIENT_SECRET: 'ysec', TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_BOT_NAME: 'sut_bot'
};
let clock = Date.UTC(2026, 8, 25, 6, 0);
const db = openDb(':memory:');
const server = http.createServer(createApp({ env, fetchImpl: fakeFetch, db, mailer, now: () => clock }));
await new Promise((r) => server.listen(0, r));
const base = 'http://127.0.0.1:' + server.address().port;

async function call(method, p, { body, cookie, origin = SITE } = {}) {
  const r = await fetch(base + p, {
    method, redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, location: r.headers.get('location'), setCookie: r.headers.getSetCookie() };
}
const sessionOf = (setCookie) => (setCookie.find((c) => c.startsWith('sut_s=')) || '').split(';')[0];

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok  ', name); };

try {
  let emailCookie;
  await t('без входа: /api/me → user null, список способов входа', async () => {
    const r = await call('GET', '/api/me');
    assert.equal(r.status, 200);
    assert.equal(r.json.user, null);
    assert.deepEqual(r.json.methods, { yandex: true, telegram: 'sut_bot', email: true });
    assert.equal((await call('GET', '/api/history')).status, 401);
  });

  await t('вход по почте: код, неверный код, согласие, сессия', async () => {
    assert.equal((await call('POST', '/auth/email/start', { body: { email: 'плохо' } })).status, 400);
    assert.equal((await call('POST', '/auth/email/start', { body: { email: 'Ivan@Example.ru' } })).status, 200);
    const code = mails.at(-1).subject.match(/\d{6}/)[0];
    assert.equal(mails.at(-1).to, 'ivan@example.ru');
    assert.equal((await call('POST', '/auth/email/start', { body: { email: 'ivan@example.ru' } })).status, 429, 'повтор через минуту');
    assert.equal((await call('POST', '/auth/email/verify', { body: { email: 'ivan@example.ru', code: '000000', consent: true } })).json.error, 'Неверный код.');
    assert.equal((await call('POST', '/auth/email/verify', { body: { email: 'ivan@example.ru', code } })).status, 400, 'без согласия нельзя');
    const ok = await call('POST', '/auth/email/verify', { body: { email: 'ivan@example.ru', code, consent: true } });
    assert.equal(ok.status, 200);
    const c = ok.setCookie.find((x) => x.startsWith('sut_s='));
    assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Lax/);
    emailCookie = sessionOf(ok.setCookie);
    const me = await call('GET', '/api/me', { cookie: emailCookie });
    assert.equal(me.json.user.email, 'ivan@example.ru');
    assert.equal(me.json.user.notify, 'email');
    assert.equal((await call('POST', '/auth/email/verify', { body: { email: 'ivan@example.ru', code, consent: true } })).status, 400, 'код одноразовый');
  });

  await t('подбор кода ограничен 5 попытками', async () => {
    clock += 2 * 60e3;
    await call('POST', '/auth/email/start', { body: { email: 'b@example.ru' } });
    const code = mails.at(-1).subject.match(/\d{6}/)[0];
    const wrong = code === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i++) await call('POST', '/auth/email/verify', { body: { email: 'b@example.ru', code: wrong, consent: true } });
    assert.equal((await call('POST', '/auth/email/verify', { body: { email: 'b@example.ru', code, consent: true } })).status, 429);
  });

  await t('история: проверка с входом сохраняется, без входа — нет', async () => {
    await call('POST', '/api/org', { body: { inn: '7707083893' } });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history').get().n, 0);
    const r = await call('POST', '/api/org', { body: { inn: '7707083893' }, cookie: emailCookie });
    assert.equal(r.json.signedIn, true);
    const h = await call('GET', '/api/history', { cookie: emailCookie });
    assert.deepEqual(h.json.items.map((i) => [i.inn, i.name]), [['7707083893', 'ООО "РОМАШКА"']]);
  });

  await t('моя компания: неверный ИНН отклоняется, верный сохраняется', async () => {
    assert.equal((await call('PATCH', '/api/me', { body: { company_inn: '123' }, cookie: emailCookie })).status, 400);
    const r = await call('PATCH', '/api/me', { body: { company_inn: '7707083893' }, cookie: emailCookie });
    assert.equal(r.json.user.company_inn, '7707083893');
  });

  await t('расчёты: только ссылки на свой сайт', async () => {
    assert.equal((await call('POST', '/api/calcs', { body: { calc: 'prepay', title: 'x', link: 'https://evil.example/' }, cookie: emailCookie })).status, 400);
    const ok = await call('POST', '/api/calcs', { body: { calc: 'prepay', title: 'Ипотека', link: SITE + '/kalkulyatory/dosrochnoe-pogashenie/#calc=prepay&debt=1' }, cookie: emailCookie });
    assert.equal(ok.status, 200);
    const list = await call('GET', '/api/calcs', { cookie: emailCookie });
    assert.equal(list.json.items.length, 1);
    await call('DELETE', '/api/calcs?id=' + list.json.items[0].id, { cookie: emailCookie });
    assert.equal((await call('GET', '/api/calcs', { cookie: emailCookie })).json.items.length, 0);
  });

  let app;
  await t('слежение: добавление, изменения, одно письмо со всеми изменениями', async () => {
    assert.equal((await call('POST', '/api/watch', { body: { inn: '7707083894' }, cookie: emailCookie })).status, 400);
    assert.equal((await call('POST', '/api/watch', { body: { inn: '7707083893' }, cookie: emailCookie })).json.name, 'ООО "РОМАШКА"');
    const { createAccounts } = await import('./accounts.mjs');
    app = createAccounts({ env, db, fetchImpl: fakeFetch, mailer, now: () => clock });
    const getFresh = async () => PARTY();
    const before = mails.length;
    let r = await app.runWatch(getFresh);
    assert.deepEqual(r, { checked: 1, changed: 0, sent: 0 });
    party = { status: 'LIQUIDATING', debt: 150000 };
    r = await app.runWatch(getFresh);
    assert.deepEqual(r, { checked: 1, changed: 1, sent: 1 });
    assert.equal(mails.length, before + 1);
    assert.match(mails.at(-1).text, /действует → ликвидируется/);
    assert.match(mails.at(-1).text, /недоимка выросла до 150\s000 ₽/);
    const w = await call('GET', '/api/watch', { cookie: emailCookie });
    assert.equal(w.json.items[0].status, 'LIQUIDATING');
    assert.match(w.json.items[0].last_change, /ликвидируется/);
  });

  let tgCookie;
  await t('вход через Telegram: подпись, согласие, срок', async () => {
    const auth = { id: '777', first_name: 'Мария', username: 'masha', auth_date: String(Math.floor(clock / 1000)) };
    const check = Object.keys(auth).sort().map((k) => `${k}=${auth[k]}`).join('\n');
    const hash = crypto.createHmac('sha256', crypto.createHash('sha256').update(BOT).digest()).update(check).digest('hex');
    const qs = (extra) => '/auth/telegram/callback?' + new URLSearchParams({ ...auth, hash, ...extra });
    assert.match((await call('GET', qs({}), { origin: null })).location, /oshibka/, 'без согласия');
    assert.match((await call('GET', qs({ consent: '1', first_name: 'Подмена' }), { origin: null })).location, /oshibka/, 'подмена данных');
    const ok = await call('GET', qs({ consent: '1', return: '/kabinet/' }), { origin: null });
    assert.equal(ok.status, 302);
    assert.equal(ok.location, SITE + '/kabinet/');
    tgCookie = sessionOf(ok.setCookie);
    const me = await call('GET', '/api/me', { cookie: tgCookie });
    assert.equal(me.json.user.name, 'Мария');
    assert.equal(me.json.user.notify, 'telegram');
    assert.equal(telegramCheck({ ...auth, hash }, BOT, clock + 2 * 864e5), null, 'подпись старше суток');
  });

  await t('вход через бота: согласие, свой браузер, подтверждение кнопкой', async () => {
    assert.equal((await call('POST', '/auth/telegram/start', { body: {} })).status, 400, 'без согласия');
    const st = await call('POST', '/auth/telegram/start', { body: { consent: true } });
    assert.match(st.json.url, /^https:\/\/t\.me\/sut_bot\?start=[\w-]{22}$/);
    const nonce = st.json.nonce, browser = st.setCookie.find((c) => c.startsWith('sut_tg=')).split(';')[0];
    const status = (cookie) => call('GET', '/auth/telegram/status?nonce=' + nonce, { cookie, origin: null });
    assert.equal((await status()).status, 403, 'чужой браузер не заберёт вход');
    assert.equal((await status(browser)).json.state, 'wait');
    const until = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 30)); assert.ok(fn()); };
    const from = { id: 999, first_name: 'Пётр', last_name: 'Сидоров' };
    tgQueue.push({ update_id: 1, message: { chat: { id: 999, type: 'private' }, from, text: '/start ' + nonce } });
    await until(() => tgSent.some((m) => m.reply_markup && m.chat_id === 999));
    tgQueue.push({ update_id: 2, callback_query: { id: 'c0', from: { id: 111 }, data: 'login:' + nonce } });   // кнопку нажал другой человек
    await until(() => tgSent.some((m) => m.callback_query_id === 'c0'));
    assert.equal((await status(browser)).json.state, 'wait');
    tgQueue.push({ update_id: 3, callback_query: { id: 'c1', from, data: 'login:' + nonce, message: { chat: { id: 999 }, message_id: 5 } } });
    await until(() => tgSent.some((m) => m.message_id === 5));
    const ok = await status(browser);
    assert.equal(ok.json.state, 'ok');
    const me = await call('GET', '/api/me', { cookie: sessionOf(ok.setCookie) });
    assert.equal(me.json.user.name, 'Пётр Сидоров');
    assert.equal((await status(browser)).json.state, 'expired', 'вход забирается один раз');
  });

  await t('привязка Telegram к уже вошедшему по почте: один аккаунт, второй раз — отказ', async () => {
    const auth = { id: '888', first_name: 'Иван', auth_date: String(Math.floor(clock / 1000)) };
    const check = Object.keys(auth).sort().map((k) => `${k}=${auth[k]}`).join('\n');
    const hash = crypto.createHmac('sha256', crypto.createHash('sha256').update(BOT).digest()).update(check).digest('hex');
    const url = '/auth/telegram/callback?' + new URLSearchParams({ ...auth, hash, consent: '1' });
    const before = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const r = await call('GET', url, { cookie: emailCookie, origin: null });
    assert.equal(r.location, SITE + '/kabinet/');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, before, 'новый пользователь не создан');
    const me = await call('GET', '/api/me', { cookie: emailCookie });
    assert.deepEqual(me.json.user.via.sort(), ['email', 'telegram']);
    assert.match((await call('GET', url, { cookie: tgCookie, origin: null })).location, /oshibka/, 'чужой Telegram не перепривязать');
    db.prepare("UPDATE users SET telegram_id = NULL WHERE email = 'ivan@example.ru'").run();   // вернуть как было для следующих тестов
  });

  await t('уведомление в Telegram для вошедших через Telegram', async () => {
    await call('POST', '/api/watch', { body: { inn: '7707083893' }, cookie: tgCookie });
    party = { status: 'LIQUIDATED', debt: 150000 };
    await app.runWatch(async () => PARTY());
    assert.equal(tgSent.at(-1).chat_id, '777');
    assert.match(tgSent.at(-1).text, /ликвидирована/);
  });

  await t('вход через Яндекс ID: state, обмен кода, привязка к той же почте', async () => {
    assert.match((await call('GET', '/auth/yandex', { origin: null })).location, /oshibka/, 'без согласия');
    const start = await call('GET', '/auth/yandex?consent=1&return=/kalkulyatory/', { origin: null });
    assert.match(start.location, /^https:\/\/oauth\.yandex\.ru\/authorize\?/);
    const state = new URL(start.location).searchParams.get('state');
    const st = start.setCookie.find((c) => c.startsWith('sut_st=')).split(';')[0];
    assert.match((await call('GET', '/auth/yandex/callback?code=good-code&state=чужой', { cookie: st, origin: null })).location, /oshibka/);
    const ok = await call('GET', `/auth/yandex/callback?code=good-code&state=${state}`, { cookie: st, origin: null });
    assert.equal(ok.location, SITE + '/kalkulyatory/');
    const me = await call('GET', '/api/me', { cookie: sessionOf(ok.setCookie) });
    assert.equal(me.json.user.email, 'ivan@example.ru', 'тот же пользователь, что вошёл по почте');
    assert.deepEqual(me.json.user.via.sort(), ['email', 'yandex']);
    assert.equal(me.json.user.company_inn, '7707083893');
  });

  await t('возврат только на свой сайт', async () => {
    const r = await call('GET', '/auth/yandex?consent=1&return=//evil.example/', { origin: null });
    const st = r.setCookie.find((c) => c.startsWith('sut_st=')).split(';')[0];
    const ret = Buffer.from(st.split('.')[1], 'base64url').toString();
    assert.equal(ret, '/kabinet/');
  });

  await t('чужой сайт не может менять данные', async () => {
    assert.equal((await call('POST', '/api/watch', { body: { inn: '7707083893' }, cookie: emailCookie, origin: 'https://evil.example' })).status, 403);
  });

  await t('выход закрывает сессию', async () => {
    await call('POST', '/auth/logout', { cookie: tgCookie });
    assert.equal((await call('GET', '/api/me', { cookie: tgCookie })).json.user, null);
  });

  await t('удаление аккаунта стирает всё', async () => {
    const uid = db.prepare("SELECT id FROM users WHERE email = 'ivan@example.ru'").get().id;
    assert.equal((await call('DELETE', '/api/me', { cookie: emailCookie })).status, 200);
    for (const tb of ['sessions', 'history', 'watch', 'calcs']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${tb} WHERE user_id = ?`).get(uid).n, 0, tb);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(uid).n, 0);
  });

  await t('сравнение слепков', () => {
    const a = { name: 'А', status: 'ACTIVE', invalid: false, debt: 0, penalty: 0, manager: 'X', address: 'Y', disqualified: false };
    assert.deepEqual(diffSnapshots(a, { ...a }), []);
    assert.deepEqual(diffSnapshots(null, a), [], 'первый слепок — не изменение');
    assert.equal(diffSnapshots(a, { ...a, manager: 'Z', invalid: true }).length, 2);
  });

  console.log(`\nВсе тесты аккаунтов прошли: ${n}`);
} finally {
  server.close();
}

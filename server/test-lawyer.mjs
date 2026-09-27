// Тесты помощника юриста (server/lawyer.mjs): доступ только по подписке, лимиты, разбор ответа ИИ
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createLawyer, LAWYER_SYSTEM } from './lawyer.mjs';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok  ', name); };
const send = (res, code, body) => { res.code = code; res.body = body; };
const readBody = (req) => new Promise((ok, bad) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { bad(e); } }); });
const call = async (lw, body, { user = { id: 1 }, method = 'POST', path = '/api/lawyer' } = {}) => {
  const req = Readable.from([JSON.stringify(body)]); req.method = method; req.user = user;
  const res = {};
  const handled = await lw.handle(req, res, new URL('https://x' + path), { send, readBody });
  return { handled, ...res };
};
const Q = { question: 'Контрагент не платит 300 тысяч по договору поставки уже два месяца, что делать?' };

await t('чужие адреса не трогает; без входа — 401, без подписки — 403', async () => {
  const lw = createLawyer({ ask: async () => '{}', isPro: (u) => u.id === 1, userOf: (req) => req.user });
  assert.equal((await call(lw, Q, { path: '/api/org' })).handled, false);
  assert.equal((await call(lw, Q, { user: null })).code, 401);
  const r = await call(lw, Q, { user: { id: 2 } });
  assert.equal(r.code, 403); assert.equal(r.body.needPro, true);
  assert.equal((await call(lw, Q, { method: 'GET' })).code, 405);
});

await t('без ИИ — 503; короткий и длинный вопрос — 400', async () => {
  assert.equal((await call(createLawyer({ ask: null, isPro: () => true, userOf: (r) => r.user }), Q)).code, 503);
  const lw = createLawyer({ ask: async () => '{}', isPro: () => true, userOf: (r) => r.user });
  assert.equal((await call(lw, { question: 'что?' })).code, 400);
  assert.equal((await call(lw, { question: 'а'.repeat(2001) })).code, 400);
});

await t('ответ ИИ разбирается: текст, статьи, совет юриста; в запрос уходят правила', async () => {
  let got;
  const lw = createLawyer({
    ask: async (prompt, system) => { got = { prompt, system }; return 'Вот ответ: {"answer":"1. Направьте претензию.","laws":["статья 395 ГК РФ",5],"needLawyer":false}'; },
    isPro: () => true, userOf: (r) => r.user
  });
  const r = await call(lw, Q);
  assert.equal(r.code, 200);
  assert.equal(r.body.answer, '1. Направьте претензию.');
  assert.deepEqual(r.body.laws, ['статья 395 ГК РФ']);
  assert.equal(r.body.needLawyer, false);
  assert.equal(r.body.left, 29);
  assert.equal(got.system, LAWYER_SYSTEM);
  assert.match(got.prompt, /300 тысяч/);
  // не JSON — отдаём текст как есть и советуем юриста
  assert.deepEqual(lw.parse('просто текст'), { answer: 'просто текст', laws: [], needLawyer: true });
});

await t('лимит на человека в день; ошибка ИИ не расходует лимит', async () => {
  let fail = true;
  const lw = createLawyer({ ask: async () => { if (fail) throw new Error('timeout'); return '{"answer":"ок","laws":[]}'; }, isPro: () => true, userOf: (r) => r.user, perUserDay: 2 });
  assert.equal((await call(lw, Q)).code, 502);
  fail = false;
  assert.equal((await call(lw, Q)).code, 200);
  assert.equal((await call(lw, Q)).code, 200);
  assert.equal((await call(lw, Q)).code, 429);
  assert.equal((await call(lw, Q, { user: { id: 7 } })).code, 200, 'у другого подписчика свой лимит');
});

console.log(`\nВсе тесты помощника юриста прошли: ${n}`);

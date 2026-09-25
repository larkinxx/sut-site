// Тесты сервера без сети: DaData и Gemini подменены заглушками.  Запуск: node server/test.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { createApp, innValid, validateAi, factsForAi } from './index.mjs';

const PARTY = {
  value: 'ООО "РОМАШКА"',
  data: {
    inn: '7707083893', ogrn: '1027700132195', type: 'LEGAL', branch_type: 'MAIN',
    name: { short_with_opf: 'ООО "РОМАШКА"' },
    state: { status: 'ACTIVE', registration_date: Date.UTC(2015, 0, 10) },
    management: { name: 'Иванов Иван Иванович', post: 'ГЕНЕРАЛЬНЫЙ ДИРЕКТОР' },
    address: { value: 'г Москва, ул Тестовая, д 1', data: { region_with_type: 'г Москва' } },
    okved: '62.01', employee_count: 12,
    finance: { year: 2025, tax_system: 'USN', income: 5_000_000, debt: 0, penalty: 0 }
  }
};
const GOOD_AI = {
  summary: 'ООО «Ромашка» из Москвы работает с 2015 года, статус — действует. По открытым данным долгов по налогам нет.',
  signals: [{ level: 'ok', text: 'Статус «действует», работает больше 10 лет.' }, { level: 'info', text: 'Финансовые данные за 2025 год, могли измениться.' }],
  next_steps: ['Закажите свежую выписку на egrul.nalog.ru.', 'Проверьте дела в kad.arbitr.ru.'],
  caveat: 'В открытых данных нет сведений о судах и исполнительных производствах.'
};

let calls = { dadata: 0, gemini: 0 };
let geminiReplies = [];
async function fakeFetch(url, opts) {
  const u = String(url);
  if (u.includes('dadata')) {
    calls.dadata++;
    const q = JSON.parse(opts.body).query;
    return new Response(JSON.stringify({ suggestions: ['7707083893', '7736050003'].includes(q) ? [PARTY] : [] }), { status: 200 });
  }
  if (u.includes('generativelanguage')) {
    calls.gemini++;
    assert.ok(!opts.body.includes('Иванов'), 'ФИО руководителя не должно уходить в ИИ');
    assert.ok(!opts.body.includes('Тестовая'), 'точный адрес не должен уходить в ИИ');
    const next = geminiReplies.shift() ?? GOOD_AI;
    if (typeof next === 'number') return new Response('err', { status: next });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(next) }] } }] }), { status: 200 });
  }
  throw new Error('неожиданный запрос ' + u);
}

const env = { DADATA_TOKEN: 't', GEMINI_API_KEY: 'k', AI_PER_IP_HOUR: '2', AI_DAILY_LIMIT: '100' };
const server = http.createServer(createApp({ env, fetchImpl: fakeFetch }));
await new Promise((r) => server.listen(0, r));
const base = 'http://127.0.0.1:' + server.address().port;
const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://fin-check.shop', ...headers }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, headers: r.headers, json: await r.json() }));

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok  ', name); };

try {
  await t('проверка ИНН', () => {
    assert.ok(innValid('7707083893'));
    assert.ok(!innValid('7707083894'));
    assert.ok(!innValid('123'));
  });

  await t('health', async () => {
    const j = await (await fetch(base + '/health')).json();
    assert.deepEqual(j, { ok: true, dadata: true, ai: true, accounts: false });
  });

  await t('/api/org: данные + памятка + CORS', async () => {
    const r = await post('/api/org', { inn: '7707 083 893' });
    assert.equal(r.status, 200);
    assert.equal(r.json.suggestion.data.inn, '7707083893');
    assert.ok(r.json.advice.some((a) => /УСН/.test(a.title)));
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://fin-check.shop');
  });

  await t('/api/org: неверный ИНН → 400', async () => {
    assert.equal((await post('/api/org', { inn: '1234567890' })).status, 400);
  });

  await t('/api/org: не найдено → 404', async () => {
    assert.equal((await post('/api/org', { inn: '500100732259' })).status, 404);
  });

  await t('чужой сайт → 403', async () => {
    assert.equal((await post('/api/org', { inn: '7707083893' }, { origin: 'https://evil.example' })).status, 403);
  });

  await t('/api/org/ai: разбор, кеш DaData', async () => {
    const before = calls.dadata;
    const r = await post('/api/org/ai', { inn: '7707083893' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ai.summary, GOOD_AI.summary);
    assert.equal(calls.dadata, before, 'организация уже в кеше, повторно в DaData не ходим');
  });

  await t('/api/org/ai: повтор отдаётся из кеша без ИИ', async () => {
    const before = calls.gemini;
    const r = await post('/api/org/ai', { inn: '7707083893' });
    assert.equal(r.json.cached, true);
    assert.equal(calls.gemini, before);
  });

  await t('ответ с вердиктом «надёжная компания» отклоняется, вторая попытка проходит', async () => {
    assert.ok(validateAi({ ...GOOD_AI, summary: 'Это надёжная компания, покупайте её услуги.' }).length > 0);
    assert.deepEqual(validateAi({ ...GOOD_AI, tax_ideas: ['Доход за 2025 год 5 млн ₽ — проверьте пониженную ставку УСН в регионе на nalog.gov.ru и посчитайте с бухгалтером.'] }), []);
    assert.ok(validateAi({ ...GOOD_AI, tax_ideas: ['Можно сэкономить через дробление бизнеса на два ИП.'] }).length > 0);
    assert.ok(validateAi({ ...GOOD_AI, tax_ideas: ['a', 'b', 'c', 'd'] }).length > 0);
  });

  await t('плохой ответ ИИ → повтор; лимит в час на один адрес', async () => {
    const s2 = http.createServer(createApp({ env: { ...env, AI_PER_IP_HOUR: '1' }, fetchImpl: fakeFetch }));
    await new Promise((r) => s2.listen(0, r));
    const p2 = (inn) => fetch('http://127.0.0.1:' + s2.address().port + '/api/org/ai', { method: 'POST', body: JSON.stringify({ inn }) }).then((r) => r.json());
    geminiReplies = [{ ...GOOD_AI, summary: 'Надёжная компания, без риска.' }, GOOD_AI];
    const first = await p2('7707083893');
    assert.equal(first.ai.summary, GOOD_AI.summary, 'после плохого ответа вторая попытка даёт нормальный');
    const second = await p2('7736050003');
    assert.equal(second.ai, null);
    assert.match(second.reason, /через час/);
    s2.close();
  });

  await t('перегрузка первой модели (503) → берётся следующая', async () => {
    const s3 = http.createServer(createApp({ env, fetchImpl: fakeFetch }));
    await new Promise((r) => s3.listen(0, r));
    geminiReplies = [503, GOOD_AI];
    const j = await fetch('http://127.0.0.1:' + s3.address().port + '/api/org/ai', { method: 'POST', body: JSON.stringify({ inn: '7707083893' }) }).then((r) => r.json());
    assert.ok(j.ai);
    s3.close();
  });

  await t('без ключа ИИ — понятный ответ, не ошибка', async () => {
    const s4 = http.createServer(createApp({ env: { DADATA_TOKEN: 't' }, fetchImpl: fakeFetch }));
    await new Promise((r) => s4.listen(0, r));
    const j = await fetch('http://127.0.0.1:' + s4.address().port + '/api/org/ai', { method: 'POST', body: JSON.stringify({ inn: '7707083893' }) }).then((r) => r.json());
    assert.equal(j.ai, null);
    assert.match(j.reason, /не подключён/);
    s4.close();
  });

  await t('разбор через AI_UPSTREAM_URL: уходит только ИНН, ответ кешируется', async () => {
    const seen = [];
    const upFetch = async (url, opts) => {
      if (String(url).startsWith('https://up.example/')) {
        seen.push({ url: String(url), body: JSON.parse(opts.body), origin: opts.headers.Origin });
        return new Response(JSON.stringify({ ai: GOOD_AI }), { status: 200 });
      }
      return fakeFetch(url, opts);
    };
    const srv = http.createServer(createApp({ env: { DADATA_TOKEN: 't', AI_UPSTREAM_URL: 'https://up.example/' }, fetchImpl: upFetch }));
    await new Promise((r) => srv.listen(0, r));
    const b = 'http://127.0.0.1:' + srv.address().port;
    const go = () => fetch(b + '/api/org/ai', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://fin-check.shop' }, body: JSON.stringify({ inn: '7707083893' }) }).then((r) => r.json());
    try {
      assert.equal((await go()).ai.summary, GOOD_AI.summary);
      assert.equal((await go()).cached, true);
      assert.equal(seen.length, 1, 'второй раз — из кеша');
      assert.deepEqual(seen[0].body, { inn: '7707083893' });
      assert.equal(seen[0].url, 'https://up.example/api/org/ai');
      assert.equal(seen[0].origin, 'https://fin-check.shop');
    } finally { srv.close(); }
  });

  await t('в ИИ не уходят ФИО и адрес', () => {
    const f = factsForAi(PARTY);
    assert.equal(f.region, 'г Москва');
    assert.ok(!JSON.stringify(f).includes('Иванов'));
  });

  console.log(`\nВсе тесты прошли: ${n}`);
} finally {
  server.close();
}

// Тесты сервера без сети: DaData и Gemini подменены заглушками.  Запуск: node server/test.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { createApp, innValid, validateAi, factsForAi, moreFactsForAi } from './index.mjs';
import { normCard, normArbitration, normCourts, normFssp } from './datanewton.mjs';
import { checkSite, siteNotes } from './site-check.mjs';

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
    assert.deepEqual(j, { ok: true, dadata: true, ai: 'gemini', accounts: false, datanewton: false });
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

  await t('Алиса (Yandex AI Studio): ключ, каталог, модель; данные ФНС в запросе; без ФИО', async () => {
    const seen = [];
    const yaFetch = async (url, opts) => {
      const u = String(url);
      if (u === 'https://ai.api.cloud.yandex.net/v1/chat/completions') {
        seen.push({ headers: opts.headers, body: JSON.parse(opts.body) });
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(GOOD_AI) } }] }), { status: 200 });
      }
      if (u.includes('bo.nalog.gov.ru/advanced-search')) return new Response(JSON.stringify({ content: [{ id: 7, inn: '7707083893' }] }));
      if (u.includes('/nbo/organizations/7/bfo/')) return new Response(JSON.stringify([{ period: '2025', typeCorrections: [{ correction: { financialResult: { current2110: 5000, current2400: 300 }, balance: {} } }] }]));
      if (u.includes('generativelanguage')) throw new Error('Gemini не должен вызываться, когда настроена Алиса');
      return fakeFetch(url, opts);
    };
    const srv = http.createServer(createApp({ env: { DADATA_TOKEN: 't', GEMINI_API_KEY: 'g', YANDEX_AI_KEY: 'yk', YANDEX_FOLDER_ID: 'b1gfolder' }, fetchImpl: yaFetch, fnsPause: 0, fnsDb: null }));
    await new Promise((r) => srv.listen(0, r));
    const b = 'http://127.0.0.1:' + srv.address().port;
    try {
      const h = await (await fetch(b + '/health')).json();
      assert.equal(h.ai, 'yandex');
      const j = await fetch(b + '/api/org/ai', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://fin-check.shop' }, body: JSON.stringify({ inn: '7707083893' }) }).then((r) => r.json());
      assert.equal(j.ai.summary, GOOD_AI.summary);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].headers.Authorization, 'Api-Key yk');
      assert.equal(seen[0].headers['OpenAI-Project'], 'b1gfolder');
      assert.equal(seen[0].body.model, 'gpt://b1gfolder/aliceai-llm');
      assert.equal(seen[0].body.messages[0].role, 'system');
      const userMsg = seen[0].body.messages[1].content;
      assert.match(userMsg, /"fns"/, 'данные ФНС переданы');
      assert.match(userMsg, /"revenue": 5000000/);
      assert.ok(!userMsg.includes('Иванов') && !userMsg.includes('Тестовая'), 'ФИО и точный адрес не уходят');
    } finally { srv.close(); }
  });

  await t('поиск по названию: подсказки, кеш, лимит, без филиалов', async () => {
    let calls = 0;
    const sgFetch = async (url, opts) => {
      if (String(url).includes('suggest/party')) {
        calls++;
        assert.equal(JSON.parse(opts.body).query.toLowerCase(), 'ромашка');
        return new Response(JSON.stringify({ suggestions: [
          { value: 'ООО "РОМАШКА"', data: { inn: '7707083893', type: 'LEGAL', branch_type: 'MAIN', state: { status: 'ACTIVE' }, address: { data: { city_with_type: 'г Москва' } }, okved: '62.01' } },
          { value: 'ООО "РОМАШКА" филиал', data: { inn: '7707083893', type: 'LEGAL', branch_type: 'BRANCH', state: { status: 'ACTIVE' } } },
          { value: 'ИП Ромашкин', data: { inn: '500100732259', type: 'INDIVIDUAL', state: { status: 'ACTIVE' }, address: { data: { region_with_type: 'Московская обл' } } } }
        ] }), { status: 200 });
      }
      return fakeFetch(url, opts);
    };
    const srv = http.createServer(createApp({ env: { DADATA_TOKEN: 't' }, fetchImpl: sgFetch }));
    await new Promise((r) => srv.listen(0, r));
    const q = (text) => fetch('http://127.0.0.1:' + srv.address().port + '/api/org/suggest', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://fin-check.shop' }, body: JSON.stringify({ q: text }) });
    try {
      assert.deepEqual((await (await q('ро')).json()).items, [], 'короче 3 символов — пусто, без запроса');
      const j = await (await q('  Ромашка ')).json();
      assert.deepEqual(j.items.map((x) => [x.name, x.type, x.place]), [['ООО "РОМАШКА"', 'ul', 'г Москва'], ['ИП Ромашкин', 'ip', 'Московская обл']]);
      await q('ромашка');
      assert.equal(calls, 1, 'второй раз из кеша');
      let last;
      for (let i = 0; i < 120; i++) last = await q('ромашка');
      assert.equal(last.status, 429, 'лимит с одного адреса');
    } finally { srv.close(); }
  });

  await t('пересылка к Telegram: только методы бота и только разрешённый бот', async () => {
    const seen = [];
    const tgFetch = async (url, opts) => { seen.push([String(url), JSON.parse(opts.body)]); return new Response(JSON.stringify({ ok: true, result: [] })); };
    const srv = http.createServer(createApp({ env: { DADATA_TOKEN: 't', TELEGRAM_RELAY_BOTS: '123' }, fetchImpl: tgFetch }));
    await new Promise((r) => srv.listen(0, r));
    const post = (p) => fetch('http://127.0.0.1:' + srv.address().port + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: 1, text: 'x' }) });
    try {
      const ok = await post('/tg/bot123:AAA-b_c/sendMessage');
      assert.equal(ok.status, 200);
      assert.deepEqual(seen[0], ['https://api.telegram.org/bot123:AAA-b_c/sendMessage', { chat_id: 1, text: 'x' }]);
      assert.equal((await post('/tg/bot123:AAA/deleteWebhook')).status, 404, 'чужие методы не пересылаем');
      assert.equal((await post('/tg/bot999:AAA/sendMessage')).status, 403, 'чужой бот');
      assert.equal(seen.length, 1);
    } finally { srv.close(); }
  });

  await t('DataNewton: карточка без ИНН физлиц и личных контактов, суды, арбитраж, приставы', () => {
    const c = normCard({ inn: '7707083893', company: {
      company_names: { short_name: 'ООО "РОМАШКА"' }, charter_capital: '10000', registration_date: '2010-05-01', years_from_registration: 16,
      status: { active_status: true, status_rus_short: 'Действует' }, address: { line_address: 'г Москва', is_inaccuracy: true },
      managers: [{ fio: 'Иванов Иван Иванович', innfl: '500100732259', position: 'Генеральный директор', date: '2020-01-01' }],
      owners: { fl: [{ name: 'Иванов Иван Иванович', inn: '500100732259', share: '100' }], ul_rus: [{ name: 'АО "ПОЛЕ"', inn: '7700000000', share: '0' }] },
      okveds: [{ code: '47.11', value: 'Торговля', main: false }, { code: '62.01', value: 'Разработка ПО', main: true }],
      workers_count: { 2024: 5, 2025: 7 },
      contacts: { phones: [{ value: '+7 495 000-00-00', weight: 5 }, { value: '+7 900 111-22-33', owner_position: 'Генеральный директор', weight: 9 }], websites: [{ value: 'romashka.ru' }] },
      negative_lists: { address_false_info: { value: true }, in_sanctions_list: false, fssp_debt: true, fssp_debt_remaining_balance: 350000 }
    } });
    assert.equal(c.capital, 10000);
    assert.equal(c.okveds[0].code, '62.01', 'основной ОКВЭД первым');
    assert.deepEqual(c.workers, [{ year: 2024, n: 5 }, { year: 2025, n: 7 }]);
    assert.ok(!JSON.stringify(c).includes('500100732259'), 'ИНН физлиц не отдаём');
    assert.deepEqual(c.contacts.phones.map((x) => x.value), ['+7 495 000-00-00'], 'личный телефон директора не отдаём');
    assert.deepEqual(c.flags.map((f) => f.key), ['address_false_info', 'fssp_debt']);
    const a = normArbitration({ total_cases: 3, data: [
      { first_number: 'А40-1/2025', status: 1, sum: 1000, year: 2025, respondents: [{ inn: '7707083893' }], party_result: 'LOST' },
      { first_number: 'А40-2/2025', status: 0, sum: 500, year: 2025, plaintiffs: [{ inn: '7707083893' }], party_result: 'IN_PROGRESS' },
      { first_number: 'А40-3/2023', status: 1, sum: 0, year: 2023, third_parties: [{ inn: '7707083893' }] }] }, '7707083893');
    assert.deepEqual([a.defendant, a.plaintiff, a.other, a.sum, a.open], [1, 1, 1, 1500, 1]);
    assert.deepEqual(a.outcomes, { LOST: 1, IN_PROGRESS: 1, THIRD: 1 });
    assert.deepEqual(a.years['2025'], { n: 2, sum: 1500 });
    const k = normCourts({ total: 2, data: [{ case_number: '2-1', category: 'Трудовые', participants: [{ inn: '7707083893', role: 'Ответчик' }] }, { case_number: '2-2', participants: [{ inn: '7707083893', role: 'Третье лицо' }] }] }, '7707083893');
    assert.deepEqual([k.total, k.defendant, k.other], [2, 1, 1]);
    const facts = moreFactsForAi({ available: true, card: c, arbitration: a, courts: null, fssp: null, sites: [{ site: 'romashka.ru', opens: true, https: false, innFound: true, created: '2010-01-01', ageYears: 16, socials: [{ name: 'ВКонтакте' }] }] });
    assert.ok(!JSON.stringify(facts).includes('Иванов'), 'ФИО не уходят в ИИ');
    assert.deepEqual(facts.registry.founders, { fl: 1, ul: 1 });
    assert.deepEqual(facts.sites[0].socials, ['ВКонтакте']);
    assert.equal(facts.arbitration.as_defendant, 1);
    const f = normFssp({ total: 2, data: [{ status: 'OPEN', debt_remaining_balance: 300, debtor_inn: '7707083893' }, { status: 'CLOSE', amount_due: 100, debtor_inn: '7707083893' }] }, '7707083893');
    assert.deepEqual([f.total, f.open, f.openSum], [2, 1, 300]);
  });

  await t('/api/org/more: DataNewton через сервер, кеш на сутки, без ключа — недоступно', async () => {
    let calls = 0;
    const dnFetch = async (url) => {
      const u = new URL(String(url));
      if (u.hostname !== 'api.datanewton.ru') return fakeFetch(url);
      calls++;
      assert.equal(u.searchParams.get('key'), 'dn');
      if (u.pathname === '/v1/counterparty') return new Response(JSON.stringify({ inn: '7707083893', company: { company_names: { short_name: 'ООО "РОМАШКА"' }, charter_capital: '10000' }, available_count: 190 }));
      if (u.pathname === '/v1/arbitration-cases') return new Response(JSON.stringify({ total_cases: 0, data: [] }));
      return new Response(JSON.stringify({ total: 0, data: [] }));
    };
    const srv = http.createServer(createApp({ env: { DADATA_TOKEN: 't', DATANEWTON_KEY: 'dn' }, fetchImpl: dnFetch }));
    await new Promise((r) => srv.listen(0, r));
    const post = () => fetch('http://127.0.0.1:' + srv.address().port + '/api/org/more', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://fin-check.shop' }, body: JSON.stringify({ inn: '7707083893' }) }).then((r) => r.json());
    try {
      const j = await post();
      assert.equal(j.available, true);
      assert.equal(j.card.capital, 10000);
      assert.equal(j.left, 190);
      assert.equal(calls, 4, 'карточка, суды, арбитраж, приставы');
      await post();
      assert.equal(calls, 4, 'второй раз из кеша');
    } finally { srv.close(); }
    const r = await fetch(base + '/api/org/more', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://fin-check.shop' }, body: JSON.stringify({ inn: '7707083893' }) });
    assert.deepEqual(await r.json(), { available: false });
  });

  await t('проверка сайта: ИНН на странице, соцсети, возраст домена, внутренние адреса не открываем', async () => {
    const html = '<title>Ромашка</title><p>ИНН 7707 083 893</p><a href="https://vk.com/romashka">vk</a><a href="https://t.me/romashka">tg</a>';
    const fetchImpl = async (u) => ({ ok: true, url: String(u), text: async () => html });
    const c = await checkSite('romashka.ru', '7707083893', { fetchImpl, lookup: async () => ({ address: '93.158.134.3' }), whois: async () => '2010-01-01', now: Date.UTC(2026, 0, 2) });
    assert.deepEqual([c.opens, c.https, c.innFound, c.title, c.ageYears >= 16], [true, true, true, 'Ромашка', true]);
    assert.deepEqual(c.socials.map((x) => x.name), ['ВКонтакте', 'Telegram']);
    assert.match(siteNotes(c).map((n) => n.text).join(' '), /указан ИНН.*Домену 16 лет.*ВКонтакте, Telegram/);
    const inner = await checkSite('intra.example', '7707083893', { fetchImpl, lookup: async () => ({ address: '10.0.0.5' }), whois: async () => null });
    assert.equal(inner.opens, false, 'внутренняя сеть');
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

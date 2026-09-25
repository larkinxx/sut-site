// Суть: сервер для проверки организаций и ИИ-разбора.
// Зачем отдельный сервер: ключи DaData и Gemini нельзя держать в браузере — их увидит любой посетитель.
//
// Маршруты:
//   GET  /health            — проверка, что сервер жив
//   POST /api/org   {inn}   — данные из реестра (DaData) + памятка по правилам. Быстро.
//   POST /api/org/ai {inn}  — ИИ-разбор этой организации простым языком. 5–15 секунд.
//   /auth/*, /api/me, /api/history, /api/watch, /api/calcs — необязательный вход и кабинет (server/accounts.mjs)
//
// Переменные окружения:
//   DADATA_TOKEN      — ключ DaData (обязателен)
//   GEMINI_API_KEY    — ключ Google Gemini (без него /api/org/ai отвечает «ИИ не подключён»)
//   GEMINI_MODEL      — модель, по умолчанию gemini-3.8-flash
//   ALLOWED_ORIGINS   — адреса сайта через запятую (CORS), по умолчанию https://fin-check.shop,https://www.fin-check.shop
//   AI_DAILY_LIMIT    — сколько ИИ-разборов в сутки максимум (защита бюджета), по умолчанию 300
//   AI_PER_IP_HOUR    — сколько ИИ-разборов в час с одного адреса, по умолчанию 15
//   AI_UPSTREAM_URL   — если задан, разбор делает другой наш сервер по этому адресу (например, https://sut-api.onrender.com):
//                       Google не пускает к Gemini с российских адресов. Туда уходит только ИНН организации
//   PORT              — порт, по умолчанию 3000
// Аккаунты (включаются, только если задан ACCOUNTS_DB; по 152-ФЗ — только на сервере в России):
//   ACCOUNTS_DB       — путь к файлу базы SQLite, например /var/lib/sut/sut.db
//   SITE_URL, PUBLIC_API_URL, COOKIE_DOMAIN — https://fin-check.shop, https://api.fin-check.shop, .fin-check.shop
//   YANDEX_CLIENT_ID, YANDEX_CLIENT_SECRET   — приложение на oauth.yandex.ru
//   TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_NAME    — бот для входа и уведомлений (домен задаётся в @BotFather: /setdomain)
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM — почта для кодов входа и уведомлений
//
// Запуск: node server/index.mjs   (зависимостей нет, нужен Node.js 22.13+ — для встроенной SQLite)
import http from 'node:http';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN } from '../src/lib/schema.mjs';
import { openDb, createAccounts, smtpMailer } from './accounts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Проверку ИНН и памятку берём из того же файла, что и сайт, чтобы правила не расходились
function loadOrgRules() {
  const code = fs.readFileSync(path.join(HERE, '../public/org.js'), 'utf8');
  const sandbox = { module: { exports: {} }, Intl, Date, Math, Number, String };
  vm.runInNewContext(code, sandbox);
  return sandbox.module.exports;
}
export const { innValid, advise } = loadOrgRules();

const DADATA_URL = process.env.DADATA_API_URL || 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party';
const DAY = 864e5;

export function config(env = process.env) {
  return {
    dadataToken: env.DADATA_TOKEN || '',
    geminiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || 'gemini-3.8-flash',
    geminiBase: env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com',
    origins: (env.ALLOWED_ORIGINS || 'https://fin-check.shop,https://www.fin-check.shop').split(',').map((s) => s.trim()).filter(Boolean),
    aiDailyLimit: Number(env.AI_DAILY_LIMIT || 300),
    aiPerIpHour: Number(env.AI_PER_IP_HOUR || 15),
    aiUpstream: (env.AI_UPSTREAM_URL || '').replace(/\/$/, ''),
    port: Number(env.PORT || 3000)
  };
}

/* ---------- простой кеш с ограничением размера ---------- */
function makeCache(ttl, max = 5000) {
  const m = new Map();
  return {
    get(k) {
      const v = m.get(k);
      if (!v) return undefined;
      if (Date.now() - v.at > ttl) { m.delete(k); return undefined; }
      return v.value;
    },
    set(k, value) {
      if (m.size >= max) m.delete(m.keys().next().value);
      m.set(k, { at: Date.now(), value });
    }
  };
}

/* ---------- DaData ---------- */
async function findParty(inn, cfg, fetchImpl) {
  const res = await fetchImpl(DADATA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Token ' + cfg.dadataToken },
    body: JSON.stringify({ query: inn }),
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error('DaData ' + res.status);
  const j = await res.json();
  const list = j.suggestions || [];
  if (!list.length) return null;
  return list.find((s) => s.data && s.data.branch_type === 'MAIN') || list[0];
}

/* ---------- ИИ-разбор ---------- */
const STATUS_RU = { ACTIVE: 'действует', LIQUIDATING: 'ликвидируется', LIQUIDATED: 'ликвидирована', BANKRUPT: 'банкротство', REORGANIZING: 'реорганизация' };

// В ИИ отправляем только сведения об организации, без ФИО руководителя и точного адреса
export function factsForAi(s, now = Date.now()) {
  const d = s.data || {};
  const st = d.state || {};
  const fin = d.finance || {};
  const years = st.registration_date ? Math.floor((now - st.registration_date) / (365.25 * DAY) * 10) / 10 : null;
  return {
    name: d.name?.short_with_opf || s.value,
    inn: d.inn || null,
    ogrn: d.ogrn || null,
    kpp: d.kpp || null,
    type: d.type === 'INDIVIDUAL' ? 'ИП' : 'юридическое лицо',
    opf: d.opf?.full || null,
    status: STATUS_RU[st.status] || st.status || null,
    registered: st.registration_date ? new Date(st.registration_date).toISOString().slice(0, 10) : null,
    age_years: years,
    liquidation_date: st.liquidation_date ? new Date(st.liquidation_date).toISOString().slice(0, 10) : null,
    okved: d.okved || null,
    okved_type: d.okved_type || null,
    okveds: Array.isArray(d.okveds) ? d.okveds.slice(0, 5).map((o) => ({ code: o.code, name: o.name, main: !!o.main })) : null,
    region: d.address?.data?.region_with_type || null,
    employee_count: d.employee_count ?? null,
    employee_count_year: fin.year ?? null,
    invalid_flag: !!d.invalid,
    management_post: d.management?.post || null,
    manager_disqualified: d.management?.disqualified ?? null,
    founders_count: Array.isArray(d.founders) ? d.founders.length : null,
    finance: {
      year: fin.year ?? null, tax_system: fin.tax_system ?? null,
      income: fin.income ?? null, expense: fin.expense ?? null, revenue: fin.revenue ?? null,
      debt: fin.debt ?? null, penalty: fin.penalty ?? null
    },
    capital: d.capital?.value ?? null,
    capital_type: d.capital?.type || null,
    branch_count: d.branch_count ?? null,
    branch_type: d.branch_type || null
  };
}

// Лимиты спецрежимов из config/finance.json: те же, что у правил на странице (public/org.js)
const REGIMES = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../config/finance.json', import.meta.url), 'utf8')).regimes || {}; } catch { return {}; }
})();
const mln = (n) => (n / 1e6).toLocaleString('ru-RU') + ' млн ₽';

export const SYSTEM = `Ты — помощник сайта «Суть». Тебе дают сведения об организации или ИП из открытых реестров (через DaData). Твоя задача — дать читателю развёрнутый, содержательный разбор именно этой организации: не общие слова, а то, что конкретно следует из переданных полей. Читатель — предприниматель, бухгалтер или человек, который собирается заключить договор с этой организацией, и ему нужно понять детали, а не шаблон.

ЖЁСТКИЕ ПРАВИЛА
1. Опирайся только на переданные поля. Ничего не выдумывай: ни судов, ни долгов, ни новостей, ни репутации. Если поля нет или оно null — не делай по нему выводов; можешь сказать, что этих сведений в открытых данных нет.
2. Не выноси вердиктов «надёжная/ненадёжная компания», «можно/нельзя доверять», не ставь оценок и баллов. Описывай наблюдения: что в данных и почему это стоит проверить.
3. Не давай инвестиционных советов и не обещай доход. Не пиши «покупайте», «продавайте», «вкладывайте», «гарантированно», «без риска».
4. Это не юридическая и не налоговая консультация.
5. Суммы, коды ОКВЭД, регион, дату регистрации, ИНН/ОГРН и другие числа бери из данных как есть и используй их в тексте (не пересказывай абстрактно, а называй конкретные значения: сумму долга, код и название вида деятельности, регион, возраст компании в годах). Если данные о финансах за старый год — отметь это явно и укажи год.
6. Пиши подробно и по делу, без канцелярита и воды. Отвечай только одним JSON-объектом без markdown.

КАК ВЫБИРАТЬ next_steps (это главное правило)
Не выдавай один и тот же универсальный список проверок для любой организации. Каждый пункт next_steps должен вытекать из конкретных данных этой организации и, где уместно, включать её ИНН/ОГРН и точное название реестра или ресурса:
— если есть долги/пени (fin.debt, fin.penalty) — предложи свериться в личном кабинете налогоплательщика и проверить исполнительные производства на fssp.gov.ru, указав сумму;
— если статус не «действует», есть ликвидация или реорганизация — предложи посмотреть карточку именно по этому ОГРН на egrul.nalog.ru и уточнить причину;
— если manager_disqualified — предложи проверить реестр дисквалифицированных лиц на nalog.gov.ru (ФИО руководителя есть в самой выписке ЕГРЮЛ/ЕГРИП, а не в этих данных);
— если компания моложе 1 года — предложи проверить, подтверждён ли налоговый режим и уточнить сроки первой отчётности исходя из tax_system;
— если oквэды выглядят разнородными или основной ОКВЭД не похож на то, чем по названию занимается организация, — отметь это как повод уточнить фактическую деятельность у самой организации;
— если сумма выручки/капитала большая для заявленного числа сотрудников (или наоборот) — можно отметить это как наблюдение, требующее уточнения, без выводов о причинах;
— если ощутимых поводов для тревоги в данных нет — вместо общих фраз предложи 2–3 точечные проверки, отталкиваясь от суммы капитала, отрасли (okved.name) или региона (например, отраслевые лицензии/членство в СРО, если ОКВЭД на это указывает).
Общие проверки (ЕГРЮЛ/ЕГРИП egrul.nalog.ru, картотека арбитражных дел kad.arbitr.ru, реестр банкротств bankrot.fedresurs.ru, бухотчётность bo.nalog.gov.ru, запрос документов у контрагента) используй точечно и только когда они действительно к месту, а не как обязательный набор.

ФОРМАТ ОТВЕТА
{
  "summary": "до 700 знаков: кто это, чем занимается (по okved.name), сколько лет на рынке, и что главное видно из данных — 3–5 предложений с конкретными цифрами",
  "signals": [ { "level": "warn" | "ok" | "info", "text": "до 320 знаков: одно наблюдение с конкретными числами/фактами из данных и почему оно важно" } ],
  "next_steps": [ "до 320 знаков: одна точечная проверка, привязанная к конкретным данным этой организации (см. правило выше)" ],
  "caveat": "до 260 знаков: чего в открытых данных нет или что могло устареть"
}
signals — от 3 до 6 пунктов, покрывающих разные аспекты (статус и регистрация, финансы, деятельность/ОКВЭД, руководство), warn только для реальных тревожных признаков в данных (статус не «действует», отметка о недостоверности, долги по налогам, дисквалификация руководителя, ликвидация). next_steps — от 2 до 5 пунктов, без повторов и без универсального шаблона.

НАЛОГОВЫЕ ИДЕИ (поле tax_ideas)
Читатель может быть владельцем этой организации. Предложи от 0 до 3 законных способов снизить налоги, которые прямо следуют из её данных (tax_system, finance.income, finance.expense, employee_count, type, okved, region). Если повода в данных нет или организация не действует — верни пустой массив.
Разрешены только эти способы (правила на ${REGIMES.year || 'текущий'} год):
— переход с общей системы на УСН, если проходят лимиты: доход до ${REGIMES.usnIncomeLimit ? mln(REGIMES.usnIncomeLimit) : 'лимита'}, до ${REGIMES.usnEmployees || 130} работников; уведомление до 31 декабря, действует с 1 января; НДС на УСН при доходе больше ${REGIMES.ndsFrom ? mln(REGIMES.ndsFrom) : '20 млн ₽'};
— выбор объекта УСН: «Доходы» 6% или «Доходы минус расходы» 15% (минимальный налог 1% дохода), со сравнением на цифрах finance.income и finance.expense, если они есть;
— пониженная региональная ставка УСН (от 1% и от 5%) — предложи проверить закон своего региона на nalog.gov.ru;
— выбор ставки НДС на УСН (5% или 7% без вычетов либо общая с вычетами) для дохода около порога и выше;
— освобождение от НДС по статье 145 НК на общей системе при выручке до 2 млн ₽ за три месяца;
— для общей системы: амортизационная премия, нелинейная амортизация, налоговые резервы (отпуска, сомнительные долги, ремонт), перечень прямых и косвенных расходов в учётной политике;
— для ИП: патент (до ${REGIMES.psnEmployees || 15} работников, доход до ${REGIMES.psnIncomeLimit ? mln(REGIMES.psnIncomeLimit) : '20 млн ₽'}), налог на профессиональный доход без работников при доходе до 2,4 млн ₽, уменьшение УСН на страховые взносы;
— АУСН при 1–${REGIMES.ausnEmployees || 5} работниках и доходе до ${REGIMES.ausnIncomeLimit ? mln(REGIMES.ausnIncomeLimit) : '60 млн ₽'} (не во всех регионах, до конца 2027 года);
— для работодателей: компенсация за личное имущество сотрудника, аренда имущества сотрудника, ученический договор, разовые работы у самозанятых (не бывших сотрудников и не вместо штата).
Запрещено советовать: делить бизнес на связанные компании или ИП, работать через фирмы без реальной деятельности, переоформлять сотрудников в самозанятых или ИП, открывать филиалы ради ухода с режима, любые схемы. Не обещай процент экономии; можно назвать оценку в рублях, если она посчитана из переданных цифр, и год этих данных. Каждая идея заканчивается советом посчитать вместе с бухгалтером.
Формат: "tax_ideas": [ "до 360 знаков: одна идея, привязанная к конкретным данным этой организации" ]`;

export function validateAi(a) {
  const e = [];
  const txt = (v, name, max) => {
    if (typeof v !== 'string' || !v.trim()) return e.push(name + ': пусто');
    if (v.length > max) e.push(name + ': длиннее ' + max);
    for (const f of FORBIDDEN) if (f.re.test(v)) e.push(name + ': ' + f.why);
    if (/(надёжн|надежн)\p{L}*\s+(компани|организаци|контрагент|партн)/iu.test(v)) e.push(name + ': вердикт о надёжности');
  };
  if (!a || typeof a !== 'object') return ['ответ не объект'];
  txt(a.summary, 'summary', 700);
  if (!Array.isArray(a.signals) || a.signals.length < 2 || a.signals.length > 6) e.push('signals: от 2 до 6');
  else a.signals.forEach((s, i) => {
    if (!['warn', 'ok', 'info'].includes(s?.level)) e.push(`signals[${i}].level`);
    txt(s?.text, `signals[${i}].text`, 320);
  });
  if (!Array.isArray(a.next_steps) || a.next_steps.length < 2 || a.next_steps.length > 5) e.push('next_steps: от 2 до 5');
  else a.next_steps.forEach((s, i) => txt(s, `next_steps[${i}]`, 320));
  if (a.caveat != null && a.caveat !== '') txt(a.caveat, 'caveat', 260);
  if (a.tax_ideas != null) {
    if (!Array.isArray(a.tax_ideas) || a.tax_ideas.length > 3) e.push('tax_ideas: от 0 до 3');
    else a.tax_ideas.forEach((t, i) => {
      txt(t, `tax_ideas[${i}]`, 360);
      if (/дроблен|раздел\p{L}*\s+бизнес|техническ\p{L}*\s+(компани|фирм)|переоформ\p{L}*\s+сотрудник|оптимизаци\p{L}*\s+схем/iu.test(String(t))) e.push(`tax_ideas[${i}]: запрещённый способ`);
    });
  }
  return e;
}

function parseJsonLoose(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('в ответе нет JSON');
  return JSON.parse(text.slice(a, b + 1));
}

async function callGemini(prompt, cfg, fetchImpl) {
  const models = [...new Set([cfg.geminiModel, 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite'])];
  let last;
  for (const m of models) {
    const res = await fetchImpl(`${cfg.geminiBase}/v1beta/models/${m}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': cfg.geminiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 2500 }
      }),
      signal: AbortSignal.timeout(55000)
    });
    if (res.ok) {
      const data = await res.json();
      return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    }
    last = new Error(`Gemini ${res.status}`);
    if (![503, 429, 404].includes(res.status)) throw last; // перегрузка / лимит / модель снята — пробуем следующую
  }
  throw last;
}

export async function analyze(suggestion, cfg, fetchImpl) {
  const facts = factsForAi(suggestion);
  const prompt = 'Сведения из реестра (JSON):\n' + JSON.stringify(facts, null, 1) + '\n\nСегодня: ' + new Date().toISOString().slice(0, 10);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await callGemini(attempt ? prompt + '\n\nПредыдущий ответ не прошёл проверку, строго соблюдай правила и формат.' : prompt, cfg, fetchImpl);
    try {
      const a = parseJsonLoose(text);
      const errs = validateAi(a);
      if (!errs.length) {
        return {
          summary: a.summary.trim(),
          signals: a.signals.map((s) => ({ level: s.level, text: s.text.trim() })),
          next_steps: a.next_steps.map((s) => s.trim()),
          caveat: (a.caveat || '').trim(),
          tax_ideas: Array.isArray(a.tax_ideas) ? a.tax_ideas.map((t) => String(t).trim()).filter(Boolean) : []
        };
      }
      lastErr = new Error('проверка: ' + errs.join('; '));
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/* ---------- HTTP ---------- */
export function createApp({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), db = null, mailer = null } = {}) {
  const cfg = config(env);
  const accounts = db ? createAccounts({ env, db, fetchImpl, mailer, now }) : null;
  const partyCache = makeCache(12 * 3600e3);
  const aiCache = makeCache(DAY);
  const ipHits = new Map();
  let day = { key: '', count: 0 };

  function cors(req, res) {
    const o = req.headers.origin;
    if (o && cfg.origins.includes(o)) {
      res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
  }
  function send(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }
  function readBody(req, limit = 2048) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); } });
      req.on('error', reject);
    });
  }
  const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  function allowAi(ip) {
    const t = now();
    const key = new Date(t).toISOString().slice(0, 10);
    if (day.key !== key) day = { key, count: 0 };
    if (day.count >= cfg.aiDailyLimit) return 'Лимит разборов на сегодня исчерпан. Данные реестра и памятка выше доступны, разбор — завтра.';
    const hits = (ipHits.get(ip) || []).filter((x) => t - x < 3600e3);
    if (hits.length >= cfg.aiPerIpHour) return 'Слишком много разборов подряд. Попробуйте через час.';
    hits.push(t); ipHits.set(ip, hits);
    if (ipHits.size > 20000) ipHits.clear();
    day.count++;
    return null;
  }

  async function getParty(inn) {
    let s = partyCache.get(inn);
    if (s === undefined) { s = await findParty(inn, cfg, fetchImpl); partyCache.set(inn, s); }
    return s;
  }

  return async function handler(req, res) {
    cors(req, res);
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
        return send(res, 200, { ok: true, dadata: !!cfg.dadataToken, ai: !!cfg.geminiKey, accounts: !!accounts });
      }
      if (req.method !== 'GET' && req.headers.origin && !cfg.origins.includes(req.headers.origin)) return send(res, 403, { error: 'Запрос с чужого сайта' });
      if (accounts && await accounts.handle(req, res, url, { send, readBody, getParty, innValid, ip: ipOf(req) })) return;
      if (req.method !== 'POST' || !['/api/org', '/api/org/ai'].includes(url.pathname)) return send(res, 404, { error: 'Не найдено' });
      if (req.headers.origin && !cfg.origins.includes(req.headers.origin)) return send(res, 403, { error: 'Запрос с чужого сайта' });
      if (!cfg.dadataToken) return send(res, 503, { error: 'Проверка организаций не подключена.' });

      const body = await readBody(req);
      const inn = String(body.inn || '').replace(/\s/g, '');
      if (!innValid(inn)) return send(res, 400, { error: 'Проверьте ИНН: у организации 10 цифр, у ИП 12, и контрольные цифры должны сходиться.' });

      const s = await getParty(inn);
      if (!s) return send(res, 404, { error: 'По этому ИНН ничего не найдено.' });

      if (url.pathname === '/api/org') {
        const u = accounts && accounts.userOf(req);
        if (u) accounts.recordHistory(u, inn, s.data?.name?.short_with_opf || s.value);
        return send(res, 200, { suggestion: s, advice: advise(s.data || {}, now()), signedIn: !!u });
      }

      // /api/org/ai
      if (!cfg.geminiKey && !cfg.aiUpstream) return send(res, 200, { ai: null, reason: 'Экспресс-разбор пока не подключён.' });
      const cached = aiCache.get(inn);
      if (cached) return send(res, 200, { ai: cached, cached: true });
      const limited = allowAi(ipOf(req));
      if (limited) return send(res, 200, { ai: null, reason: limited });
      let ai;
      if (cfg.aiUpstream) {
        // Пересылаем на сервер за рубежом: кеш и лимиты остаются здесь, туда уходит только ИНН
        const r = await fetchImpl(cfg.aiUpstream + '/api/org/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: cfg.origins[0], 'X-Forwarded-For': ipOf(req) },
          body: JSON.stringify({ inn }),
          signal: AbortSignal.timeout(90000)   // бесплатный Render засыпает: первый запрос после паузы до минуты
        });
        const j = await r.json().catch(() => ({}));
        if (!j.ai) return send(res, r.ok ? 200 : 502, { ai: null, reason: j.reason || j.error || 'Разбор сейчас недоступен. Попробуйте позже.' });
        ai = j.ai;
      } else {
        ai = await analyze(s, cfg, fetchImpl);
      }
      aiCache.set(inn, ai);
      return send(res, 200, { ai });
    } catch (e) {
      console.error(new Date().toISOString(), req.method, url.pathname, e.message);
      if (/too big|bad json/.test(e.message)) return send(res, 400, { error: 'Некорректный запрос' });
      return send(res, 502, { error: url.pathname === '/api/org/ai' ? 'Разбор сейчас недоступен. Попробуйте позже.' : 'Не получилось получить данные. Попробуйте позже.' });
    }
  };
}

// Запуск как программы (а не импорт из тестов)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = config();
  const env = process.env;
  const db = env.ACCOUNTS_DB ? openDb(env.ACCOUNTS_DB) : null;
  const mailer = env.SMTP_HOST ? smtpMailer({ host: env.SMTP_HOST, port: env.SMTP_PORT || 465, user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.MAIL_FROM || env.SMTP_USER })
    : env.MAIL_DEV_LOG === '1' ? async (m) => console.log(`[письмо для ${m.to}] ${m.subject}`)   // только для локальной разработки
    : null;
  const app = createApp({ db, mailer });
  // HOST=127.0.0.1 на своём сервере за Caddy; на Render и Timeweb Apps — 0.0.0.0
  http.createServer(app).listen(cfg.port, env.HOST || '0.0.0.0', () => {
    console.log(`Суть API: порт ${cfg.port}, DaData ${cfg.dadataToken ? 'есть' : 'НЕТ'}, ИИ ${cfg.geminiKey ? cfg.geminiModel : 'выключен'}, аккаунты ${db ? env.ACCOUNTS_DB : 'выключены'}, сайты: ${cfg.origins.join(', ')}`);
  });
  if (db) {
    // слежение: раз в сутки свежие данные из DaData (без кеша)
    const accounts = createAccounts({ env, db, fetchImpl: globalThis.fetch, mailer });
    accounts.scheduleWatch((inn) => findParty(inn, cfg, globalThis.fetch));
  }
}

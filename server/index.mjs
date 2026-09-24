// Суть: сервер для проверки организаций и ИИ-разбора.
// Зачем отдельный сервер: ключи DaData и Gemini нельзя держать в браузере — их увидит любой посетитель.
//
// Маршруты:
//   GET  /health            — проверка, что сервер жив
//   POST /api/org   {inn}   — данные из реестра (DaData) + памятка по правилам. Быстро.
//   POST /api/org/ai {inn}  — ИИ-разбор этой организации простым языком. 5–15 секунд.
//
// Переменные окружения:
//   DADATA_TOKEN      — ключ DaData (обязателен)
//   GEMINI_API_KEY    — ключ Google Gemini (без него /api/org/ai отвечает «ИИ не подключён»)
//   GEMINI_MODEL      — модель, по умолчанию gemini-3.8-flash
//   ALLOWED_ORIGINS   — адреса сайта через запятую (CORS), по умолчанию https://fin-check.shop,https://www.fin-check.shop
//   AI_DAILY_LIMIT    — сколько ИИ-разборов в сутки максимум (защита бюджета), по умолчанию 300
//   AI_PER_IP_HOUR    — сколько ИИ-разборов в час с одного адреса, по умолчанию 15
//   PORT              — порт, по умолчанию 3000
//
// Запуск: node server/index.mjs   (зависимостей нет, нужен Node.js 20+)
import http from 'node:http';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN } from '../src/lib/schema.mjs';

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
    type: d.type === 'INDIVIDUAL' ? 'ИП' : 'юридическое лицо',
    opf: d.opf?.full || null,
    status: STATUS_RU[st.status] || st.status || null,
    registered: st.registration_date ? new Date(st.registration_date).toISOString().slice(0, 10) : null,
    age_years: years,
    liquidation_date: st.liquidation_date ? new Date(st.liquidation_date).toISOString().slice(0, 10) : null,
    okved: d.okved || null,
    region: d.address?.data?.region_with_type || null,
    employee_count: d.employee_count ?? null,
    invalid_flag: !!d.invalid,
    management_post: d.management?.post || null,
    manager_disqualified: d.management?.disqualified ?? null,
    finance: {
      year: fin.year ?? null, tax_system: fin.tax_system ?? null,
      income: fin.income ?? null, expense: fin.expense ?? null, revenue: fin.revenue ?? null,
      debt: fin.debt ?? null, penalty: fin.penalty ?? null
    },
    capital: d.capital?.value ?? null,
    branch_count: d.branch_count ?? null
  };
}

export const SYSTEM = `Ты — помощник сайта «Суть». Тебе дают сведения об организации или ИП из открытых реестров (через DaData). Твоя задача — объяснить обычному человеку простым языком, что видно из этих данных и что стоит проверить дальше. Читатель — предприниматель, бухгалтер или человек, который собирается заключить договор с этой организацией.

ЖЁСТКИЕ ПРАВИЛА
1. Опирайся только на переданные поля. Ничего не выдумывай: ни судов, ни долгов, ни новостей, ни репутации. Если поля нет или оно null — не делай по нему выводов; можешь сказать, что этих сведений в открытых данных нет.
2. Не выноси вердиктов «надёжная/ненадёжная компания», «можно/нельзя доверять», не ставь оценок и баллов. Описывай наблюдения: что в данных и почему это стоит проверить.
3. Не давай инвестиционных советов и не обещай доход. Не пиши «покупайте», «продавайте», «вкладывайте», «гарантированно», «без риска».
4. Это не юридическая и не налоговая консультация. Шаги — конкретные проверки: выписка ЕГРЮЛ/ЕГРИП на egrul.nalog.ru, картотека арбитражных дел kad.arbitr.ru, реестр банкротств bankrot.fedresurs.ru, бухотчётность bo.nalog.gov.ru, реестр дисквалифицированных лиц на nalog.gov.ru, запрос документов у контрагента.
5. Суммы и даты бери из данных как есть. Если данные о финансах за старый год — отметь это.
6. Пиши коротко, без канцелярита. Отвечай только одним JSON-объектом без markdown.

ФОРМАТ ОТВЕТА
{
  "summary": "до 400 знаков: кто это и что главное видно из данных, 2–3 предложения",
  "signals": [ { "level": "warn" | "ok" | "info", "text": "до 220 знаков: одно наблюдение из данных и почему оно важно" } ],
  "next_steps": [ "до 220 знаков: одна конкретная проверка" ],
  "caveat": "до 200 знаков: чего в открытых данных нет или что могло устареть"
}
signals — от 2 до 5 пунктов, warn только для реальных тревожных признаков в данных (статус не «действует», отметка о недостоверности, долги по налогам, дисквалификация руководителя, ликвидация). next_steps — от 2 до 4 пунктов.`;

export function validateAi(a) {
  const e = [];
  const txt = (v, name, max) => {
    if (typeof v !== 'string' || !v.trim()) return e.push(name + ': пусто');
    if (v.length > max) e.push(name + ': длиннее ' + max);
    for (const f of FORBIDDEN) if (f.re.test(v)) e.push(name + ': ' + f.why);
    if (/(надёжн|надежн)\p{L}*\s+(компани|организаци|контрагент|партн)/iu.test(v)) e.push(name + ': вердикт о надёжности');
  };
  if (!a || typeof a !== 'object') return ['ответ не объект'];
  txt(a.summary, 'summary', 400);
  if (!Array.isArray(a.signals) || a.signals.length < 1 || a.signals.length > 5) e.push('signals: от 1 до 5');
  else a.signals.forEach((s, i) => {
    if (!['warn', 'ok', 'info'].includes(s?.level)) e.push(`signals[${i}].level`);
    txt(s?.text, `signals[${i}].text`, 220);
  });
  if (!Array.isArray(a.next_steps) || a.next_steps.length < 1 || a.next_steps.length > 4) e.push('next_steps: от 1 до 4');
  else a.next_steps.forEach((s, i) => txt(s, `next_steps[${i}]`, 220));
  if (a.caveat != null && a.caveat !== '') txt(a.caveat, 'caveat', 200);
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
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 1500 }
      }),
      signal: AbortSignal.timeout(40000)
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
          caveat: (a.caveat || '').trim()
        };
      }
      lastErr = new Error('проверка: ' + errs.join('; '));
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/* ---------- HTTP ---------- */
export function createApp({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const cfg = config(env);
  const partyCache = makeCache(12 * 3600e3);
  const aiCache = makeCache(DAY);
  const ipHits = new Map();
  let day = { key: '', count: 0 };

  function cors(req, res) {
    const o = req.headers.origin;
    if (o && cfg.origins.includes(o)) {
      res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
  }
  function send(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > 2048) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); } });
      req.on('error', reject);
    });
  }
  const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  function allowAi(ip) {
    const t = now();
    const key = new Date(t).toISOString().slice(0, 10);
    if (day.key !== key) day = { key, count: 0 };
    if (day.count >= cfg.aiDailyLimit) return 'Лимит ИИ-разборов на сегодня исчерпан. Данные реестра и памятка выше доступны, разбор — завтра.';
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
        return send(res, 200, { ok: true, dadata: !!cfg.dadataToken, ai: !!cfg.geminiKey });
      }
      if (req.method !== 'POST' || !['/api/org', '/api/org/ai'].includes(url.pathname)) return send(res, 404, { error: 'Не найдено' });
      if (req.headers.origin && !cfg.origins.includes(req.headers.origin)) return send(res, 403, { error: 'Запрос с чужого сайта' });
      if (!cfg.dadataToken) return send(res, 503, { error: 'Проверка организаций не подключена.' });

      const body = await readBody(req);
      const inn = String(body.inn || '').replace(/\s/g, '');
      if (!innValid(inn)) return send(res, 400, { error: 'Проверьте ИНН: у организации 10 цифр, у ИП 12, и контрольные цифры должны сходиться.' });

      const s = await getParty(inn);
      if (!s) return send(res, 404, { error: 'По этому ИНН ничего не найдено.' });

      if (url.pathname === '/api/org') {
        return send(res, 200, { suggestion: s, advice: advise(s.data || {}, now()) });
      }

      // /api/org/ai
      if (!cfg.geminiKey) return send(res, 200, { ai: null, reason: 'ИИ-разбор пока не подключён.' });
      const cached = aiCache.get(inn);
      if (cached) return send(res, 200, { ai: cached, cached: true });
      const limited = allowAi(ipOf(req));
      if (limited) return send(res, 200, { ai: null, reason: limited });
      const ai = await analyze(s, cfg, fetchImpl);
      aiCache.set(inn, ai);
      return send(res, 200, { ai });
    } catch (e) {
      console.error(new Date().toISOString(), req.method, url.pathname, e.message);
      if (/too big|bad json/.test(e.message)) return send(res, 400, { error: 'Некорректный запрос' });
      return send(res, 502, { error: url.pathname === '/api/org/ai' ? 'ИИ сейчас не ответил. Попробуйте позже.' : 'Не получилось получить данные. Попробуйте позже.' });
    }
  };
}

// Запуск как программы (а не импорт из тестов)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = config();
  http.createServer(createApp()).listen(cfg.port, '0.0.0.0', () => {
    console.log(`Суть API: порт ${cfg.port}, DaData ${cfg.dadataToken ? 'есть' : 'НЕТ'}, ИИ ${cfg.geminiKey ? cfg.geminiModel : 'выключен'}, сайты: ${cfg.origins.join(', ')}`);
  });
}

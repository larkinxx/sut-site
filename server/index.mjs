// INNSIDER: сервер для проверки организаций и ИИ-разбора.
// Зачем отдельный сервер: ключи DaData и Gemini нельзя держать в браузере — их увидит любой посетитель.
//
// Маршруты:
//   GET  /health            — проверка, что сервер жив
//   POST /api/org   {inn}   — данные из реестра (DaData) + памятка по правилам. Быстро.
//   POST /api/org/ai {inn}  — ИИ-разбор этой организации простым языком. 5–15 секунд.
//   POST /api/org/fns {inn} — бесплатные данные ФНС: отчётность, налоговый режим, налоги, долги (server/fns.mjs)
//   POST /api/org/suggest {q} — поиск по названию, ИНН, адресу или руководителю (подсказки DaData)
//   POST /api/market {okved, region} — статистика похожих компаний: выручка и прибыль по годам, конкуренция (server/market.mjs)
//   /auth/*, /api/me, /api/history, /api/watch, /api/calcs — необязательный вход и кабинет (server/accounts.mjs)
//
// Переменные окружения:
//   DADATA_TOKEN      — ключ DaData (обязателен)
//   GEMINI_API_KEY    — ключ Google Gemini (без него /api/org/ai отвечает «ИИ не подключён»)
//   GEMINI_MODEL      — модель, по умолчанию gemini-3.8-flash
//   YANDEX_AI_KEY, YANDEX_FOLDER_ID — разбор через Yandex AI Studio (Алиса AI); если заданы — вместо Gemini, прямо из России
//   YANDEX_AI_MODEL   — модель, по умолчанию aliceai-llm (дешевле: aliceai-llm-flash)
//   ALLOWED_ORIGINS   — адреса сайта через запятую (CORS), по умолчанию inn-sider.ru и старые innfact.ru, fin-check.shop с www
//   AI_DAILY_LIMIT    — сколько ИИ-разборов в сутки максимум (защита бюджета), по умолчанию 300
//   AI_PER_IP_HOUR    — сколько ИИ-разборов в час с одного адреса, по умолчанию 15
//   AI_UPSTREAM_URL   — если задан, разбор делает другой наш сервер по этому адресу (например, https://sut-api.onrender.com):
//                       Google не пускает к Gemini с российских адресов. Туда уходит только ИНН организации
//   DATANEWTON_KEY    — ключ DataNewton: подробная карточка (POST /api/org/more, 1 единица), суды, арбитраж и приставы
//                       по кнопке (POST /api/org/courts, 3 единицы)
//   DATANEWTON_DAILY_UNITS — сколько единиц DataNewton тратить в сутки, по умолчанию 100 (пакет 3 000 в месяц)
//   DATANEWTON_CACHE_DAYS  — сколько дней хранить ответы (по умолчанию 7); DATANEWTON_CACHE_DB — файл кеша,
//                       по умолчанию dn-cache.db рядом с FNS_DB (без FNS_DB — в памяти)
//   SITE_DIST         — где лежит собранный сайт (deploy/site-build.sh), по умолчанию /var/www/fin-check.shop:
//                       из него берётся шаблон страниц компаний GET /organizacii/<ИНН>/ и карты сайта /sitemap-companies.xml
//   SSR_DADATA_DAILY  — сколько раз в сутки страницы компаний могут спросить DaData (по умолчанию 2000)
//   FNS_DB            — база открытых данных ФНС (scripts/fns-import.mjs), например /var/lib/sut/fns.db
//   ADMIN_TOKEN       — ключ панели владельца /admin/ (GET /api/admin/stats), не короче 24 символов; без него панели нет
//   PORT              — порт, по умолчанию 3000
// Аккаунты (включаются, только если задан ACCOUNTS_DB; по 152-ФЗ — только на сервере в России):
//   ACCOUNTS_DB       — путь к файлу базы SQLite, например /var/lib/sut/sut.db
//   SITE_URL, PUBLIC_API_URL, COOKIE_DOMAIN — https://inn-sider.ru, https://api.inn-sider.ru, .inn-sider.ru
//   YANDEX_CLIENT_ID, YANDEX_CLIENT_SECRET   — приложение на oauth.yandex.ru
//   VK_CLIENT_ID      — приложение на id.vk.com (вход через VK ID)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_NAME    — бот для входа и уведомлений
//   TELEGRAM_API_URL  — через что ходить к Telegram. Timeweb не пускает к api.telegram.org, поэтому по умолчанию
//                       AI_UPSTREAM_URL + '/tg' (наш сервер на Render), а без него — напрямую
// Пересылка к Telegram (на Render, где нет аккаунтов): POST /tg/bot<токен>/<метод> — только методы бота INNSIDER;
//   TELEGRAM_RELAY_BOTS — необязательно: номера ботов через запятую (часть токена до двоеточия), кому разрешена пересылка
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM — почта для кодов входа и уведомлений
//
// Запуск: node server/index.mjs   (зависимостей нет, нужен Node.js 22.13+ — для встроенной SQLite)
import http from 'node:http';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { buildZskUrl } from '../shared/zsk.mjs';
import { FORBIDDEN } from '../src/lib/schema.mjs';
import { openDb, createAccounts, smtpMailer } from './accounts.mjs';
import { createBilling } from './billing.mjs';
import { dnCard, dnCourts, partyOfCard } from './datanewton.mjs';
import { createDnStore } from './dn-store.mjs';
import { checkSite, siteNotes } from './site-check.mjs';
import { createCompanyPages, shortName, similarCompanies } from './company-page.mjs';
import { peopleOf, commonPeople } from './links.mjs';
import { createIndustryPages } from './industry-pages.mjs';
import { createLawyer } from './lawyer.mjs';
import { createCerts, certSnapshot } from './certs.mjs';
import { createResearch } from './research.mjs';
import { fnsData } from './fns.mjs';
import { marketStats, orgPeers, orgForecast, compareFacts, okvedOf } from './market.mjs';
import { createAdmin } from './admin.mjs';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Проверку ИНН и памятку берём из того же файла, что и сайт, чтобы правила не расходились
function loadOrgRules() {
  const code = fs.readFileSync(path.join(HERE, '../public/org.js'), 'utf8');
  const sandbox = { module: { exports: {} }, Intl, Date, Math, Number, String };
  vm.runInNewContext(code, sandbox);
  return sandbox.module.exports;
}
export const { innValid, advise, innIndex } = loadOrgRules();

const DADATA_URL = process.env.DADATA_API_URL || 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party';
const DADATA_SUGGEST_URL = process.env.DADATA_SUGGEST_URL || 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/party';
const DAY = 864e5;

export function config(env = process.env) {
  return {
    dadataToken: env.DADATA_TOKEN || '',
    geminiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || 'gemini-3.8-flash',
    yandexKey: env.YANDEX_AI_KEY || '',
    yandexFolder: env.YANDEX_FOLDER_ID || '',
    yandexModel: env.YANDEX_AI_MODEL || 'aliceai-llm',
    yandexBase: env.YANDEX_AI_URL || 'https://ai.api.cloud.yandex.net/v1',
    geminiBase: env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com',
    origins: (env.ALLOWED_ORIGINS || 'https://inn-sider.ru,https://www.inn-sider.ru,https://innfact.ru,https://www.innfact.ru,https://fin-check.shop,https://www.fin-check.shop').split(',').map((s) => s.trim()).filter(Boolean),
    aiDailyLimit: Number(env.AI_DAILY_LIMIT || 300),
    aiPerIpHour: Number(env.AI_PER_IP_HOUR || 15),
    aiUpstream: (env.AI_UPSTREAM_URL || '').replace(/\/$/, ''),
    dnKey: env.DATANEWTON_KEY || '', dnUrl: (env.DATANEWTON_URL || 'https://api.datanewton.ru').replace(/\/$/, ''),
    // DaData бесплатно даёт 10 000 запросов в сутки на всё; держим запас, чтобы лимит не кончался посреди дня
    dadataDaily: Number(env.DADATA_DAILY_LIMIT || 8000),
    dnDailyUnits: Number(env.DATANEWTON_DAILY_UNITS || 100), dnProUnits: Number(env.DATANEWTON_PRO_UNITS || 100), dnCacheDays: Number(env.DATANEWTON_CACHE_DAYS || 7),
    dnCacheDb: env.DATANEWTON_CACHE_DB || (env.FNS_DB ? path.join(path.dirname(env.FNS_DB), 'dn-cache.db') : null),
    port: Number(env.PORT || 3000)
  };
}

/* ---------- простой кеш с ограничением размера ---------- */
// Поисковые роботы открывают страницы компаний с включённым JavaScript, и страница сама запрашивала проверку —
// так боты за сутки выбирали лимиты DaData и DataNewton (27.09.2026). Роботам проверка не нужна: данные ФНС уже в HTML
export const isBot = (req) => /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|vkshare/i.test(String(req.headers['user-agent'] || ''));

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

/* ---------- поиск по названию: подсказки DaData ---------- */
export async function suggestParty(q, cfg, fetchImpl) {
  const res = await fetchImpl(DADATA_SUGGEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Token ' + cfg.dadataToken },
    body: JSON.stringify({ query: q, count: 8 }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error('DaData suggest ' + res.status);
  const j = await res.json();
  return (j.suggestions || []).map((s) => {
    const d = s.data || {};
    const a = d.address?.data || {};
    return {
      name: s.value, inn: d.inn, kpp: d.kpp || null, type: d.type === 'INDIVIDUAL' ? 'ip' : 'ul',
      status: d.state?.status || null, branch: d.branch_type === 'BRANCH',
      place: a.city_with_type || a.settlement_with_type || a.region_with_type || null,
      okved: d.okved || null
    };
  }).filter((x) => x.inn && !x.branch);
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

export const SYSTEM = `Ты — помощник сайта INNSIDER. Тебе дают сведения об организации или ИП из открытых реестров (через DaData). Твоя задача — дать читателю развёрнутый, содержательный разбор именно этой организации: не общие слова, а то, что конкретно следует из переданных полей. Читатель — предприниматель, бухгалтер или человек, который собирается заключить договор с этой организацией, и ему нужно понять детали, а не шаблон.

ЖЁСТКИЕ ПРАВИЛА
1. Опирайся только на переданные поля. В поле fns — официальные данные ФНС (налоговый режим, численность, уплаченные налоги, налоговый долг, отчётность по годам в рублях): используй их в первую очередь, называй год. В поле details — данные ЕГРЮЛ и судов: уставный капитал, численность по годам, отметки в реестрах (flags), суды общей юрисдикции (courts), арбитраж (arbitration: роли, суммы, исходы), исполнительные производства (fssp), проверка сайтов компании (sites) и число её контактов. Ничего не выдумывай сверх переданного: ни судов, ни долгов, ни новостей, ни репутации. Если поля нет или оно null — не делай по нему выводов; можешь сказать, что этих сведений в открытых данных нет.
2. В поле index — индекс надёжности INNSIDER (0–100), уровень и факторы, из которых он сложился. Обязательно дай общий вывод о надёжности по этому индексу: назови уровень и 2–3 главных фактора с цифрами. Формулируй как оценку по открытым данным («по открытым данным надёжность высокая: …»), а не как гарантию. Если index.partial — отметь, что оценка предварительная. Не называй компанию мошеннической или однодневкой и не обвиняй в преступлениях: только факты и вывод из них.
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
— если есть details.arbitration или details.courts — скажи, в какой роли компания чаще (ответчик, истец, третье лицо), на какие суммы и чем дела заканчиваются (outcomes); дела, где компания третье лицо, не выдавай за риск;
— если есть details.fssp с открытыми производствами — назови их число и сумму;
— если есть details.flags — перечисли их как наблюдения (без вердиктов);
— если есть details.sites — дай отдельный сигнал про сайт и соцсети: открывается ли сайт, указан ли на нём ИНН (inn_on_site), есть ли HTTPS, сколько лет домену по сравнению с возрастом компании, какие соцсети указаны. Если сайт молодой, без ИНН или не открывается — предложи проверить реквизиты на сайте; если соцсетей нет — это просто наблюдение;
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
    if (/мошенни|однодневк|преступ/iu.test(v)) e.push(name + ': обвинение, а не оценка по данным');
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

export async function callYandex(prompt, cfg, fetchImpl, system = SYSTEM) {
  const res = await fetchImpl(cfg.yandexBase + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Api-Key ' + cfg.yandexKey, 'OpenAI-Project': cfg.yandexFolder, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `gpt://${cfg.yandexFolder}/${cfg.yandexModel}`,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      temperature: 0.2, max_tokens: 2500
    }),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) throw new Error(`Yandex AI ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}
export const aiProvider = (cfg) => (cfg.yandexKey && cfg.yandexFolder ? 'yandex' : cfg.geminiKey ? 'gemini' : cfg.aiUpstream ? 'upstream' : null);

export async function callGemini(prompt, cfg, fetchImpl, system = SYSTEM) {
  const models = [...new Set([cfg.geminiModel, 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite'])];
  let last;
  for (const m of models) {
    const res = await fetchImpl(`${cfg.geminiBase}/v1beta/models/${m}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': cfg.geminiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
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

// Данные ФНС для ИИ — только сводные цифры компании, без людей
export function fnsFactsForAi(f) {
  if (!f || (!f.pb && !f.bo)) return null;
  const p = f.pb || {};
  return {
    tax_regime: p.regime && p.regime.known ? (p.regime.names.length ? p.regime.names.join(', ') : 'общая система') : null,
    employees: p.employees && p.employees[0] ? p.employees[0] : null,
    taxes_paid: p.taxesPaid ? { year: p.taxesPaid.year, total: p.taxesPaid.total } : null,
    tax_arrears: p.arrears ? { total: p.arrears.total, as_of: p.arrears.asOf } : null,
    msp: p.msp ? p.msp.category : null,
    mass_address: p.massAddress ?? null,
    reports: f.bo ? f.bo.years.map((y) => ({ year: y.year, revenue: y.revenue, net_profit: y.profit, assets: y.assets, equity: y.equity })) : null
  };
}

// Данные DataNewton и проверки сайтов для ИИ — только цифры и факты о компании, без ФИО, ИНН и контактов людей
export function moreFactsForAi(m) {
  if (!m || !m.available) return null;
  const c = m.card, a = m.arbitration, k = m.courts, f = m.fssp;
  const out = {};
  if (c) {
    const kinds = {};
    for (const o of c.owners) kinds[o.kind] = (kinds[o.kind] || 0) + 1;
    out.registry = {
      charter_capital: c.capital, employees_by_year: c.workers.slice(-4), okved_count: c.okveds.length,
      founders: kinds, managers_count: c.managers.length, management_company: !!c.managementCompany,
      msp: c.msp ? c.msp.category : null, branches: c.branches, contacts: { phones: c.contacts.phones.length, emails: c.contacts.emails.length, sites: c.contacts.sites.length }
    };
    out.flags = c.flags.map((x) => x.text);
    if (c.bankruptcy.some((b) => b.active)) out.flags.push('Активное дело о банкротстве');
  }
  if (k) out.courts = { total: k.total, as_defendant: k.defendant, as_plaintiff: k.plaintiff, as_third_party: k.other, counted_from: k.shown, top_categories: k.categories.map(([n, q]) => [n.split('→').pop().trim(), q]) };
  if (a) out.arbitration = { total: a.total, sum: a.sum, as_defendant: a.defendant, defendant_sum: a.defendantSum, as_plaintiff: a.plaintiff, plaintiff_sum: a.plaintiffSum, as_third_party: a.other, open: a.open, outcomes: a.outcomes, counted_from: a.shown };
  if (f) out.fssp = { total: f.total, open: f.open, open_sum: f.openSum };
  if (m.sites && m.sites.length) out.sites = m.sites.map((x) => ({ domain: x.site, opens: x.opens, https: x.https, inn_on_site: x.innFound, domain_created: x.created, domain_age_years: x.ageYears, socials: x.socials.map((q) => q.name) }));
  return Object.keys(out).length ? out : null;
}

// Вход для индекса надёжности из данных сервера — так же, как на странице (public/org.js → indexInput)
export function indexInputFor(s, f, more) {
  const d = s.data || {}, st = d.state || {}, p = f && f.pb, ys = (f && f.bo && f.bo.years) || [];
  const x = { status: st.status, ageYears: st.registration_date ? (Date.now() - st.registration_date) / (365.25 * DAY) : null,
    invalid: !!d.invalid, disqualified: !!(d.management && d.management.disqualified), isIp: d.type === 'INDIVIDUAL' };
  if (p || ys.length) x.fns = { taxes: p?.taxesPaid?.total ?? null, staff: p?.employees?.[0]?.n ?? null, debt: p?.arrears?.total ?? null, last: ys[ys.length - 1] || null, prev: ys[ys.length - 2] || null };
  const c = more && more.card;
  if (c) x.flags = c.flags.map((q) => q.key);
  if (more?.fssp) x.fssp = { open: more.fssp.open, openSum: more.fssp.openSum };
  if (more?.arbitration) x.arb = { lostDef: (more.arbitration.outcomes.LOST || 0) + (more.arbitration.outcomes.LOST_PARTIAL || 0), openDef: more.arbitration.openDefendant };
  if (more?.courts) x.courts = { defendant: more.courts.defendant };
  return x;
}

export async function analyze(suggestion, cfg, fetchImpl, fns = null, more = null) {
  const facts = factsForAi(suggestion);
  const extra = fnsFactsForAi(fns);
  if (extra) facts.fns = extra;         // режим, численность, налоги, долги и отчётность из данных ФНС
  const details = moreFactsForAi(more);
  if (details) facts.details = details; // ЕГРЮЛ, суды, арбитраж, приставы, сайты (DataNewton и своя проверка сайтов)
  const ix = innIndex(indexInputFor(suggestion, fns, more));
  facts.index = { score: ix.score, level: ix.level, partial: ix.partial, factors: ix.factors.map((q) => (q.pts > 0 ? '+' : '') + q.pts + ' ' + q.text) };
  const prompt = 'Сведения из реестра (JSON):\n' + JSON.stringify(facts, null, 1) + '\n\nСегодня: ' + new Date().toISOString().slice(0, 10);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const call = aiProvider(cfg) === 'yandex' ? callYandex : callGemini;
    const text = await call(attempt ? prompt + '\n\nПредыдущий ответ не прошёл проверку, строго соблюдай правила и формат.' : prompt, cfg, fetchImpl);
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
export function createApp({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), db = null, mailer = null, fnsPause = 700, fnsDb = undefined, dnStore = undefined } = {}) {
  const cfg = config(env);
  const accounts = db ? createAccounts({ env, db, fetchImpl, mailer, now, watchLimit: (u) => billing.watchLimit(u) }) : null;
  // подписка: нужна база аккаунтов (платёж привязан к пользователю)
  const billing = db ? createBilling({ env, db, fetchImpl, now, notify: (u, text) => accounts.notify(u, text, 'INNSIDER Ultima: подписка') }) : null;
  const partyCache = makeCache(24 * 3600e3, 20000);   // сведения из ЕГРЮЛ за сутки почти не меняются; слежение берёт свежие отдельно
  // Карточки организаций из DaData храним и на диске неделю: перезапуск сервера и обход страниц поисковиками не тратят
  // дневной лимит заново. Только организации (10 цифр) — у ИП в карточке ФИО; кто и кого проверял, здесь не записывается
  const PARTY_TTL = 7 * DAY;
  if (db) db.exec('CREATE TABLE IF NOT EXISTS party_cache (inn TEXT PRIMARY KEY, data TEXT NOT NULL, at INTEGER NOT NULL)');
  const partyDisk = {
    get(inn) {
      if (!db || inn.length !== 10) return undefined;
      const r = db.prepare('SELECT data, at FROM party_cache WHERE inn = ?').get(inn);
      return r && now() - r.at < PARTY_TTL ? JSON.parse(r.data) : undefined;
    },
    set(inn, v) {
      if (!db || !v || inn.length !== 10) return;
      db.prepare('INSERT OR REPLACE INTO party_cache (inn, data, at) VALUES (?, ?, ?)').run(inn, JSON.stringify(v), now());
      if (Math.random() < 0.01) db.prepare('DELETE FROM party_cache WHERE at < ?').run(now() - PARTY_TTL);
    }
  };
  function cachedParty(inn) {
    let v = partyCache.get(inn);
    if (v === undefined && (v = partyDisk.get(inn)) !== undefined) partyCache.set(inn, v);
    return v;
  }
  const aiCache = makeCache(DAY);
  const fnsCache = makeCache(DAY);
  const suggestCache = makeCache(3600e3, 20000);
  const suggestHits = new Map();
  const marketHits = new Map();
  const dn = dnStore || createDnStore(cfg.dnCacheDb, { ttlDays: cfg.dnCacheDays, dailyUnits: cfg.dnDailyUnits, now });
  const dnHits = new Map();
  setInterval(() => dn.prune(), DAY).unref();
  // всё, что уже есть о компании из DataNewton (для разбора и страницы компании) — без новых запросов
  const dnCached = (inn) => {
    const c = dn.get('card:' + inn), k = dn.get('courts:' + inn);
    return c || k ? { available: true, ...(c || {}), ...(k || {}) } : null;
  };
  // pro — запрос подписчика: у него свой запас сверх общего дневного лимита
  const dnAllow = (ip, units, pro = false) => {
    const t = now(), hits = (dnHits.get(ip) || []).filter((x) => t - x < 3600e3);
    if (hits.length >= 40) return false;
    if (!dn.take(units, pro ? cfg.dnDailyUnits + cfg.dnProUnits : undefined)) return false;
    hits.push(t); dnHits.set(ip, hits);
    if (dnHits.size > 20000) dnHits.clear();
    return true;
  };
  // база открытых данных ФНС открывается только на чтение; если её ещё нет — работаем без неё
  let fdb = fnsDb;
  if (fdb === undefined && env.FNS_DB) { try { fdb = new DatabaseSync(env.FNS_DB, { readOnly: true }); } catch (e) { console.error('FNS_DB:', e.message); fdb = null; } }
  // Для ежедневного слежения (accounts.runWatch): налоговые долги из базы ФНС — всем; суды и приставы из DataNewton —
  // только компаниям из слежения подписчиков, не чаще раза в неделю и не больше половины дневного запаса единиц,
  // чтобы живым проверкам на сайте хватало лимита
  async function watchExtra(inn, prev, pro) {
    const out = {};
    if (fdb) { try { out.fnsDebt = fdb.prepare('SELECT total FROM fns_debt WHERE inn = ?').get(inn)?.total || 0; } catch { /* таблицы нет */ } }
    if (pro && cfg.dnKey && !(prev && prev.dnAt && now() - prev.dnAt < 7 * DAY)
      && dn.take(inn.length === 10 ? 3 : 2, Math.round((cfg.dnDailyUnits + cfg.dnProUnits) / 2))) {
      const k = await dnCourts(inn, cfg, fetchImpl);
      if (k.courts || k.arbitration || k.fssp) {
        dn.set('courts:' + inn, k);
        Object.assign(out, { dnAt: now(), arbDef: k.arbitration?.defendant ?? null, courtsDef: k.courts?.defendant ?? null, fsspOpen: k.fssp?.open ?? null, fsspSum: k.fssp?.openSum ?? null });
      }
    }
    return out;
  }
  // панель владельца (server/admin.mjs): счётчики использования по дням и GET /api/admin/stats по ключу ADMIN_TOKEN
  const admin = createAdmin({ env, db, fdb, dn, now });
  // Помощник юриста (server/lawyer.mjs): тот же ИИ, что и у разбора, но только для подписчиков Ultima
  const lawyerAsk = (prompt, system) => {
    const p = aiProvider(cfg);
    if (p === 'yandex') return callYandex(prompt, cfg, fetchImpl, system);
    if (p === 'gemini') return callGemini(prompt, cfg, fetchImpl, system);
    return Promise.reject(new Error('ИИ не подключён'));
  };
  const lawyer = createLawyer({
    ask: ['yandex', 'gemini'].includes(aiProvider(cfg)) ? lawyerAsk : null,
    isPro: (u) => !!(billing && billing.enabled && billing.isPro(u)),
    userOf: (req) => (accounts ? accounts.userOf(req) : null),
    perUserDay: Number(env.LAWYER_PER_DAY || 30), count: (m) => admin.count(m), now
  });
  const ipHits = new Map();
  const relayHits = new Map();
  let day = { key: '', count: 0 };

  function cors(req, res) {
    const o = req.headers.origin;
    if (o && cfg.origins.includes(o)) {
      res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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

  // Если DaData не отвечает (27.09.2026 она отключила ключу подсказки), берём карточку DataNewton: её и так запрашивает
  // /api/org/more при каждой проверке, так что лишних единиц не тратится. Страницы для поисковиков запасной источник не используют
  const dnMiss = makeCache(3600e3);   // ИНН, по которым DataNewton не вернул карточку: час не спрашиваем снова и не тратим единицы
  async function partyFromDn(inn) {
    if (!cfg.dnKey || dnMiss.get(inn)) return null;
    let m = dn.get('card:' + inn);
    if (!m) {
      if (!dn.take(1)) return null;
      const d = await dnCard(inn, cfg, fetchImpl);
      if (!d.card) { dnMiss.set(inn, true); return null; }
      m = { card: d.card, left: d.left, sites: [] };
      dn.set('card:' + inn, m);
    }
    return m.card ? partyOfCard(inn, m.card) : null;
  }
  // счётчик запросов к DaData за сутки по Москве; на потолке работаем по запасным источникам
  let dadataDay = { key: '', n: 0 };
  function dadataTake() {
    const key = new Date(now() + 3 * 3600e3).toISOString().slice(0, 10);
    if (dadataDay.key !== key) dadataDay = { key, n: 0 };
    if (dadataDay.n >= cfg.dadataDaily) throw new Error('DaData: дневной потолок ' + cfg.dadataDaily);
    dadataDay.n++;
  }
  async function getParty(inn, { fallback = true } = {}) {
    let s = cachedParty(inn);
    if (s !== undefined) return s;
    try { dadataTake(); s = await findParty(inn, cfg, fetchImpl); partyDisk.set(inn, s); } catch (e) {
      if (!fallback) throw e;
      s = await partyFromDn(inn).catch(() => null);
      if (s) console.error(new Date().toISOString(), inn, e.message, '— карточка из DataNewton');
      else if ((s = partyFromFns(inn))) console.error(new Date().toISOString(), inn, e.message, '— название из базы ФНС');
      else throw e;
    }
    if (!s || s.source !== 'fns') partyCache.set(inn, s);   // урезанную карточку не запоминаем: DaData может ожить через минуту
    return s;
  }
  // последний запасной вариант, когда DaData и DataNewton недоступны: название из нашей базы ФНС. Статуса и адреса
  // там нет — карточка их не покажет, но налоги, суды, сравнение с отраслью и индекс по ним работают
  function partyFromFns(inn) {
    if (!fdb) return null;
    let r;
    try { r = fdb.prepare('SELECT name FROM fns_name WHERE inn = ?').get(inn); } catch { r = null; }
    if (!r || !r.name) return null;
    const name = shortName(r.name);
    return { value: name, source: 'fns', data: { inn, type: inn.length === 12 ? 'INDIVIDUAL' : 'LEGAL', branch_type: 'MAIN', name: { short_with_opf: name, full_with_opf: r.name } } };
  }
  // поиск по названию без DaData: по нашей базе названий ФНС (только организации)
  function suggestFromFns(q) {
    if (!fdb) return [];
    try {
      return fdb.prepare('SELECT inn, name FROM fns_name WHERE instr(name, ?) > 0 LIMIT 8').all(q.toUpperCase())
        .map((r) => ({ name: r.name, inn: r.inn, kpp: null, type: r.inn.length === 12 ? 'ip' : 'ul', status: null, branch: false, place: null, okved: null }));
    } catch { return []; }
  }
  const industryPages = createIndustryPages({ env, fdb, now });
  const research = createResearch({ env, fdb, now });   // «Исследования INNSIDER» (server/research.mjs)
  const certs = db ? createCerts({ env, db, now }) : null;   // сертификаты проверки (server/certs.mjs)
  const companyPages = createCompanyPages({ env, fdb, getParty: (inn) => getParty(inn, { fallback: false }), cachedParty, getMore: dnCached, now });

  // Пересылка к api.telegram.org для нашего сервера в России. Секретов не хранит: токен приходит в адресе и дальше не пишется
  async function relayTelegram(req, res, url) {
    const m = /^\/tg\/bot(\d+):([\w-]+)\/(getUpdates|sendMessage|answerCallbackQuery|editMessageText|getMe)$/.exec(url.pathname);
    if (req.method !== 'POST' || !m) return send(res, 404, { ok: false, description: 'Не найдено' });
    const allowed = (env.TELEGRAM_RELAY_BOTS || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(m[1])) return send(res, 403, { ok: false, description: 'Бот не разрешён' });
    const ip = ipOf(req), t = now();
    const hits = (relayHits.get(ip) || []).filter((x) => t - x < 60e3);
    if (hits.length >= 120) return send(res, 429, { ok: false, description: 'Слишком много запросов' });
    hits.push(t); relayHits.set(ip, hits);
    if (relayHits.size > 1000) relayHits.clear();
    const body = await readBody(req, 16384);
    const r = await fetchImpl(`https://api.telegram.org/bot${m[1]}:${m[2]}/${m[3]}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000)
    });
    return send(res, r.status, await r.json().catch(() => ({ ok: false, description: 'Telegram ' + r.status })));
  }

  handler.watchExtra = watchExtra;
  // строка недельной сводки о компании пользователя: место среди сверстников и ссылка на прогноз
  handler.companyLine = (inn) => {
    const p = orgPeers(fdb, inn);
    if (!p || p.incomePercentile == null) return null;
    const site = (env.SITE_URL || 'https://inn-sider.ru').replace(/\/$/, '');
    return `Ваша компания: доходы за ${p.year} год выше, чем у ${p.incomePercentile}% сверстников — компаний той же отрасли${p.scope === 'region' ? ' и региона' : ''}, которые работают ${p.ageLabel}. Прогноз на три года: ${site}/prognoz/#inn=${inn}`;
  };
  return handler;
  async function handler(req, res) {
    cors(req, res);
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (admin.handle(req, res, url, { send, ipOf })) return;
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
        return send(res, 200, { ok: true, dadata: !!cfg.dadataToken, dadataToday: dadataDay.n, datanewtonToday: dn.used(), ai: aiProvider(cfg), accounts: !!accounts, datanewton: !!cfg.dnKey });
      }
      if (!accounts && url.pathname.startsWith('/tg/')) return relayTelegram(req, res, url);
      // адрес API роботам не нужен: Google и Яндекс не станут вызывать его, открывая страницы
      if (req.method === 'GET' && url.pathname === '/robots.txt') {   // robots.txt самого сайта отдаёт Caddy из статики
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('User-agent: *\nDisallow: /\n');
      }
      if (await companyPages(req, res, url, innValid)) return;
      if (industryPages(req, res, url)) return;
      if (research(req, res, url)) return;
      if (certs && certs.handle(req, res, url)) return;
      if (req.method !== 'GET' && req.headers.origin && !cfg.origins.includes(req.headers.origin)) return send(res, 403, { error: 'Запрос с чужого сайта' });
      if (await lawyer.handle(req, res, url, { send, readBody })) return;
      if (url.pathname === '/api/cert') {
        // сертификат к отчёту PDF — только подписчикам: снимок того, что они видели о компании
        if (req.method !== 'POST' || !certs) return send(res, 404, { error: 'Не найдено' });
        const u = accounts && accounts.userOf(req);
        if (!u) return send(res, 401, { error: 'Войдите, чтобы получить сертификат.' });
        if (!(billing && billing.enabled && billing.isPro(u))) return send(res, 403, { error: 'Сертификат проверки — в подписке INNSIDER Ultima.', needPro: true });
        let body; try { body = await readBody(req); } catch { return send(res, 400, { error: 'Не удалось прочитать запрос.' }); }
        const inn = String((body && body.inn) || '').replace(/\D/g, '');
        if (!innValid(inn)) return send(res, 400, { error: 'Неверный ИНН.' });
        const s = partyCache.get(inn) || await getParty(inn).catch(() => null);
        if (!s) return send(res, 404, { error: 'По этому ИНН ничего не найдено.' });
        const f = fnsCache.get(inn) || null, more = dnCached(inn);
        const c = certs.issue(u.id, certSnapshot({ inn, suggestion: s, fns: f, more, index: innIndex(indexInputFor(s, f, more)) }));
        return c ? send(res, 200, c) : send(res, 429, { error: 'На сегодня сертификатов достаточно. Попробуйте завтра.' });
      }
      if (billing && await billing.handle(req, res, url, { send, readBody, user: url.pathname.startsWith('/api/billing') ? accounts.userOf(req) : null })) return;
      if (accounts && await accounts.handle(req, res, url, { send, readBody, getParty, innValid, ip: ipOf(req) })) return;
      if (req.method !== 'POST' || !['/api/org', '/api/org/ai', '/api/org/fns', '/api/org/more', '/api/org/courts', '/api/org/suggest', '/api/market', '/api/forecast', '/api/compare'].includes(url.pathname)) return send(res, 404, { error: 'Не найдено' });
      if (req.headers.origin && !cfg.origins.includes(req.headers.origin)) return send(res, 403, { error: 'Запрос с чужого сайта' });
      if (url.pathname === '/api/compare') {
        // сравнение 2–3 организаций бок о бок — только база ФНС
        const body = await readBody(req);
        const inns = (Array.isArray(body && body.inns) ? body.inns : []).map((x) => String(x).replace(/\D/g, '')).filter((x) => /^\d{10}$/.test(x) && innValid(x));
        if (inns.length < 2 || inns.length > 3 || new Set(inns).size !== inns.length) return send(res, 400, { error: 'Укажите от двух до трёх разных ИНН организаций (10 цифр).' });
        const ip = ipOf(req), t = now();
        const hits = (marketHits.get(ip) || []).filter((x) => t - x < 600e3);
        if (hits.length >= 120) return send(res, 429, { error: 'Слишком много запросов. Подождите несколько минут.' });
        hits.push(t); marketHits.set(ip, hits);
        admin.count('market');
        // руководитель и учредители — из ЕГРЮЛ через DaData и карточку DataNewton (новая карточка — в пределах лимита адреса)
        const people = await Promise.all(inns.map(async (inn) => {
          const party = await getParty(inn).catch(() => null);
          let card = (dn.get('card:' + inn) || {}).card || null;
          if (!card && cfg.dnKey && !dnMiss.get(inn) && dnAllow(ip, 1)) {
            const d = await dnCard(inn, cfg, fetchImpl).catch(() => null);
            if (d && d.card) { card = d.card; dn.set('card:' + inn, { card: d.card, left: d.left, sites: [] }); } else dnMiss.set(inn, true);
          }
          return peopleOf(party && party.source !== 'fns' ? party : null, card);
        }));
        const items = inns.map((inn, i) => { const c = compareFacts(fdb, inn); return { ...(c ? { ...c, name: c.name ? shortName(c.name) : null } : { inn, missing: true }), people: people[i] }; });
        return send(res, 200, { items, links: commonPeople(items) });
      }
      if (url.pathname === '/api/forecast') {
        // прогноз действующей организации по месту среди сверстников — тоже только наша база ФНС
        const body = await readBody(req);
        const inn = String((body && body.inn) || '').replace(/\D/g, '');
        if (!/^\d{10}$/.test(inn) || !innValid(inn)) return send(res, 400, { error: 'Нужен ИНН организации — 10 цифр. По ИП ФНС не публикует отчётность.' });
        const ip = ipOf(req), t = now();
        const hits = (marketHits.get(ip) || []).filter((x) => t - x < 600e3);
        if (hits.length >= 120) return send(res, 429, { error: 'Слишком много запросов. Подождите несколько минут.' });
        hits.push(t); marketHits.set(ip, hits);
        admin.count('market');
        let f = null, name = null;
        try { f = orgForecast(fdb, inn); name = fdb && fdb.prepare('SELECT name FROM fns_name WHERE inn = ?').get(inn)?.name; } catch { f = null; }
        return send(res, 200, f ? { available: true, name: name ? shortName(name) : null, ...f } : { available: false });
      }
      if (url.pathname === '/api/market') {
        // только открытые данные ФНС из нашей базы — DaData не нужна
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || !okvedOf(body.okved)) return send(res, 400, { error: 'Укажите отрасль: код ОКВЭД, например 47 или 56.10.' });
        // лимит как у подсказок: 120 запросов за 10 минут с адреса — хватает для калькулятора, но не для выкачивания всей статистики
        const ip = ipOf(req), t = now();
        const hits = (marketHits.get(ip) || []).filter((x) => t - x < 600e3);
        if (hits.length >= 120) return send(res, 429, { error: 'Слишком много запросов. Подождите несколько минут.' });
        hits.push(t); marketHits.set(ip, hits);
        if (marketHits.size > 20000) marketHits.clear();
        admin.count('market');
        const m = marketStats(fdb, { okved: body.okved, region: body.region });
        return send(res, 200, m ? { available: true, ...m } : { available: false });
      }
      if (!cfg.dadataToken) return send(res, 503, { error: 'Проверка организаций не подключена.' });

      if (isBot(req)) return send(res, 403, { error: 'Проверка доступна в браузере.' });
      const body = await readBody(req);
      if (url.pathname === '/api/org/suggest') {
        const q = String(body.q || '').replace(/\s+/g, ' ').trim().slice(0, 100);
        if (q.length < 3) return send(res, 200, { items: [] });
        // лимит: 120 запросов за 10 минут с одного адреса — хватает для набора текста, но не для выкачивания базы
        const ip = ipOf(req), t = now();
        const hits = (suggestHits.get(ip) || []).filter((x) => t - x < 600e3);
        if (hits.length >= 120) return send(res, 429, { error: 'Слишком много запросов. Подождите несколько минут.' });
        hits.push(t); suggestHits.set(ip, hits);
        if (suggestHits.size > 20000) suggestHits.clear();
        const key = q.toLowerCase();
        let items = suggestCache.get(key);
        if (!items) {
          try { dadataTake(); items = await suggestParty(q, cfg, fetchImpl); } catch (e) {
            items = suggestFromFns(q);
            if (!items.length) throw e;
          }
          suggestCache.set(key, items);
        }
        return send(res, 200, { items });
      }
      const inn = String(body.inn || '').replace(/\s/g, '');
      if (!innValid(inn)) return send(res, 400, { error: 'Проверьте ИНН: у организации 10 цифр, у ИП 12, и контрольные цифры должны сходиться.' });

      if (url.pathname === '/api/org/more') {
        if (!cfg.dnKey) return send(res, 200, { available: false });
        let m = dn.get('card:' + inn);
        if (!m) {
          if (!dnAllow(ipOf(req), 1)) return send(res, 200, { available: true, limited: true, ...(dn.get('courts:' + inn) || {}) });
          const d = await dnCard(inn, cfg, fetchImpl);
          const sites = (d.card?.contacts.sites || []).slice(0, 2).map((x) => x.value);
          const checks = await Promise.all(sites.map((x) => checkSite(x, inn, { fetchImpl, now: now() }).catch(() => null)));
          m = { card: d.card, left: d.left, sites: checks.filter(Boolean).map((c) => ({ ...c, notes: siteNotes(c) })) };
          if (d.card) dn.set('card:' + inn, m);
        }
        return send(res, 200, { available: true, ...m, ...(dn.get('courts:' + inn) || {}) });   // суды — если уже загружены
      }
      if (url.pathname === '/api/org/courts') {
        if (!cfg.dnKey) return send(res, 200, { available: false });
        let k = dn.get('courts:' + inn);
        if (!k) {
          // уже загруженные суды показываем всем; новый запрос к DataNewton — подписчикам или в пределах бесплатных в день
          const u = accounts && accounts.userOf(req), pro = !!(billing && billing.isPro(u));
          if (billing && !billing.allowCourts(u, ipOf(req), inn)) return send(res, 200, { available: true, paywall: true, free: billing.state(u).freeCourts, signedIn: !!u });
          if (!dnAllow(ipOf(req), inn.length === 10 ? 3 : 2, pro)) return send(res, 200, { available: true, limited: true });
          k = await dnCourts(inn, cfg, fetchImpl);
          admin.count('courts');
          if (k.courts || k.arbitration || k.fssp) dn.set('courts:' + inn, k);
        }
        return send(res, 200, { available: true, ...k });
      }

      if (url.pathname === '/api/org/fns') {
        let f = fnsCache.get(inn);
        if (!f) { f = await fnsData(inn, fetchImpl, fnsPause, fdb, now); if (f.pb || f.bo) fnsCache.set(inn, f); }
        return send(res, 200, { ...f, peers: orgPeers(fdb, inn), similar: similarCompanies(fdb, inn) });
      }

      const s = await getParty(inn);
      if (!s) return send(res, 404, { error: 'По этому ИНН ничего не найдено.' });

      if (url.pathname === '/api/org') {
        const u = accounts && accounts.userOf(req);
        if (u) accounts.recordHistory(u, inn, s.data?.name?.short_with_opf || s.value);
        admin.count('checks');
        return send(res, 200, { suggestion: s, advice: advise(s.data || {}, now()), zsk: buildZskUrl(inn), signedIn: !!u, pro: !!(billing && billing.enabled && billing.isPro(u)), billing: !!(billing && billing.enabled) });
      }

      // /api/org/ai
      const provider = aiProvider(cfg);
      if (!provider) return send(res, 200, { ai: null, reason: 'Экспресс-разбор пока не подключён.' });
      const cached = aiCache.get(inn);
      if (cached) return send(res, 200, { ai: cached, cached: true });
      const limited = allowAi(ipOf(req));
      if (limited) return send(res, 200, { ai: null, reason: limited });
      let ai;
      if (provider === 'upstream') {
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
        // свой ИИ (Алиса или Gemini): добавляем данные ФНС, если они есть в кеше или быстро получаются
        let f = fnsCache.get(inn);
        if (!f) { try { f = await fnsData(inn, fetchImpl, fnsPause, fdb, now); if (f.pb || f.bo) fnsCache.set(inn, f); } catch { f = null; } }
        ai = await analyze(s, cfg, fetchImpl, f, dnCached(inn));   // сайт запрашивает разбор после /api/org/more
      }
      aiCache.set(inn, ai);
      admin.count('ai');   // только новые разборы — они стоят денег
      return send(res, 200, { ai });
    } catch (e) {
      console.error(new Date().toISOString(), req.method, url.pathname, e.message);
      if (/too big|bad json/.test(e.message)) return send(res, 400, { error: 'Некорректный запрос' });
      return send(res, 502, { error: url.pathname === '/api/org/ai' ? 'Разбор сейчас недоступен. Попробуйте позже.' : 'Не получилось получить данные. Попробуйте позже.' });
    }
  };
}

/* ---------- Налоговый календарь: напоминания по email за 3 дня до сроков ---------- */
const TZ = 'Europe/Moscow';
const NOTIFY_DAYS_BEFORE = 3;
const ALL_MONTHS = null;

const TAX_DEADLINES = {
  usn: [
    { day: 25, months: [4, 7, 10], kind: 'notice',  title: 'Уведомление об исчисленных авансовых платежах по УСН' },
    { day: 28, months: [3, 4, 7, 10], kind: 'payment', title: 'Уплата налога / авансового платежа по УСН (ЕНП)' },
  ],
  osn: [
    { day: 25, months: ALL_MONTHS, kind: 'notice',  title: 'Уведомление об исчисленных налогах (НДФЛ, взносы)' },
    { day: 28, months: ALL_MONTHS, kind: 'payment', title: 'Уплата ЕНП (НДС, НДФЛ, взносы, налог на прибыль)' },
  ],
  psn: [
    { day: 25, months: ALL_MONTHS, kind: 'notice',  title: 'Уведомление по НДФЛ и взносам за работников' },
    { day: 28, months: ALL_MONTHS, kind: 'payment', title: 'Уплата ЕНП (НДФЛ, взносы за работников)' },
  ],
};

function mskToday() {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: TZ })
    .format(new Date()).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const addDays = (dt, n) => new Date(dt.getTime() + n * 86_400_000);
const ymd = (dt) => dt.toISOString().slice(0, 10);

function shiftToWorkday(dt) {
  const wd = dt.getUTCDay();
  return wd === 6 ? addDays(dt, 2) : wd === 0 ? addDays(dt, 1) : dt;
}

export function findDeadlinesOn(target) {
  const key = ymd(target);
  const periods = [0, -1].map((off) => {
    const d = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + off, 1));
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
  });
  const found = [];
  for (const [system, rules] of Object.entries(TAX_DEADLINES)) {
    for (const rule of rules) {
      for (const { y, m } of periods) {
        if (rule.months && !rule.months.includes(m)) continue;
        const due = shiftToWorkday(new Date(Date.UTC(y, m - 1, rule.day)));
        if (ymd(due) === key) found.push({ system, ...rule, due });
      }
    }
  }
  return found;
}

function buildTaxMail(user, dl) {
  const date = dl.due.toLocaleDateString('ru-RU', { timeZone: 'UTC' });
  return {
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: user.email,
    subject: `INNSIDER: ${dl.title} — до ${date}`,
    text: `${user.name || 'Здравствуйте'}!\n\nЧерез ${NOTIFY_DAYS_BEFORE} дня наступает срок: ${dl.title}.\nКрайняя дата: ${date}.\n\nНастройки уведомлений — в профиле INNSIDER.`,
  };
}

async function sendInBatches(mails, mailer, size = 20) {
  let ok = 0, fail = 0;
  for (let i = 0; i < mails.length; i += size) {
    const res = await Promise.allSettled(mails.slice(i, i + size).map((m) => mailer(m)));
    for (const r of res) r.status === 'fulfilled' ? ok++ : (fail++, console.error('[tax-cron] send failed:', r.reason?.message));
  }
  return { ok, fail };
}

let taxJobRunning = false;

export async function runTaxReminderJob(accounts, mailer) {
  if (!accounts || !mailer || taxJobRunning) return;
  taxJobRunning = true;
  try {
    const deadlines = findDeadlinesOn(addDays(mskToday(), NOTIFY_DAYS_BEFORE));
    for (const dl of deadlines) {
      const users = accounts.listUsersByTaxSystem(dl.system);
      if (!users.length) continue;
      const { ok, fail } = await sendInBatches(users.map((u) => buildTaxMail(u, dl)), mailer);
      console.log(`[tax-cron] ${dl.system}/${dl.kind} ${ymd(dl.due)}: sent=${ok} failed=${fail}`);
    }
  } catch (err) {
    console.error('[tax-cron] job error:', err);
  } finally {
    taxJobRunning = false;
  }
}

export function startTaxCron(accounts, mailer) {
  return cron.schedule('0 9 * * *', () => runTaxReminderJob(accounts, mailer), { timezone: TZ });
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
    console.log(`INNSIDER API: порт ${cfg.port}, DaData ${cfg.dadataToken ? 'есть' : 'НЕТ'}, ИИ ${{ yandex: 'Алиса (' + cfg.yandexModel + ')', gemini: cfg.geminiModel, upstream: 'через ' + cfg.aiUpstream }[aiProvider(cfg)] || 'выключен'}, аккаунты ${db ? env.ACCOUNTS_DB : 'выключены'}, сайты: ${cfg.origins.join(', ')}`);
  });
  if (db) {
    // слежение: раз в сутки свежие данные из DaData (без кеша)
    const accounts = createAccounts({ env, db, fetchImpl: globalThis.fetch, mailer });
    const bill = createBilling({ env, db, fetchImpl: globalThis.fetch, notify: (u, text) => accounts.notify(u, text, 'INNSIDER Ultima: подписка') });
    accounts.scheduleWatch((inn) => findParty(inn, cfg, globalThis.fetch),
      (inn, prev, uids) => app.watchExtra(inn, prev, bill.enabled && uids.some((id) => bill.isPro({ id }))));
    accounts.scheduleTaxReminders();
    accounts.scheduleDigest((u) => bill.enabled && bill.isPro(u), { companyLine: (inn) => app.companyLine(inn) });
    bill.scheduleRenew();
    if (process.env.TAX_CRON_ENABLED !== 'false') startTaxCron(accounts, mailer);
  }
}

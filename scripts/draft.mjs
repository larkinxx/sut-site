// Черновики карточек: берёт необработанные материалы из content/raw/ и просит Claude
// подготовить карточку в content/news/ со статусом "draft". Ничего не публикуется само:
// на сайт карточка попадёт только после проверки человеком (см. README).
//
// Запуск:  ANTHROPIC_API_KEY=... npm run draft
// Без ключа, для проверки конвейера:  npm run draft:mock
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson } from '../src/lib/content.mjs';
import { validateCard } from '../src/lib/schema.mjs';

const args = process.argv.slice(2);
const MOCK = args.includes('--mock');
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const RAW = path.join(ROOT, 'content/raw');
const OUT = path.join(ROOT, 'content/news');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(RAW, { recursive: true });

if (!MOCK && !API_KEY) {
  console.error('Не задан ANTHROPIC_API_KEY. Для проверки без ключа запустите: npm run draft:mock');
  process.exit(1);
}

const cfg = readJson('config/sources.json');
const topics = readJson('content/topics.json');
const topicIds = (topics.topics || []).map((t) => t.id);

const SYSTEM = `Ты — редактор русскоязычного сайта «Суть». Ты превращаешь официальную новость об экономике в короткую карточку: что случилось, кого касается, что можно сделать. Читатель — обычный человек без финансового образования.

ЖЁСТКИЕ ПРАВИЛА
1. Используй только факты из переданного текста. Ничего не выдумывай: ни цифр, ни дат, ни сроков. Если данных мало — так и скажи и поставь confidence "low".
2. Не давай инвестиционных советов: никаких «покупайте», «продавайте», «вкладывайте в». Не обещай доход, не пиши «гарантированно», «без риска».
3. Шаги — это проверки и действия в собственных делах читателя (посмотреть договор, сравнить условия, уточнить у банка/налоговой, прочитать первоисточник), а не прогнозы рынка.
4. Пиши простым языком, короткими фразами. Термин — с пояснением в gloss.
5. Если новость не имеет практического значения для граждан или малого бизнеса (кадровые назначения, протокольные встречи, узкие технические процедуры банков) — верни {"skip": true, "reason": "..."}.
6. Отвечай только одним JSON-объектом, без пояснений и без markdown.

ФОРМАТ ОТВЕТА
{
  "skip": false,
  "title": "заголовок до 140 знаков, по-человечески, без канцелярита",
  "highlight": "фраза из title дословно (до 80 знаков) — главная цифра или суть; иначе пустая строка",
  "summary": "до 600 знаков: что произошло, 2–3 предложения",
  "gloss": "до 180 знаков: что это значит на деле, одной фразой",
  "tip": "до 160 знаков: самое короткое действие",
  "affects": ["borrowers"|"savers"|"selfemployed"|"business" — кого касается; "all" если всех],
  "audiences": {
    "<та же аудитория, кроме all>": { "meaning": "до 420 знаков", "steps": ["1–3 шага, каждый до 260 знаков"] }
  },
  "calc": "mortgage" | "deposit" | null,
  "critical": true|false,
  "confidence": "high"|"medium"|"low",
  "confidenceNote": "до 240 знаков: чего не хватает в первоисточнике или почему уверенность не высокая; иначе пустая строка",
  "topics": ["id тем из списка"]
}
Пояснения: critical=true только если новость может напрямую и скоро изменить платежи, налоги, обязательные сроки или права людей. calc "mortgage" — если речь о ставках по кредитам, "deposit" — о вкладах и инфляции, иначе null. В audiences включай только те группы, которых новость реально касается (обычно 1–3).
Допустимые id тем: ${topicIds.join(', ')}.`;

function userPrompt(raw) {
  return `Источник: ${raw.sourceName} (${raw.kind || 'новость'})
Дата публикации: ${raw.publishedAt}
Ссылка: ${raw.url}
Заголовок: ${raw.title}

Текст:
${(raw.text || '').slice(0, 6000)}`;
}

async function callClaude(messages) {
  const res = await fetch((process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com') + '/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, system: SYSTEM, messages }),
    signal: AbortSignal.timeout(90000)
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

export function parseJsonLoose(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('в ответе нет JSON');
  return JSON.parse(text.slice(a, b + 1));
}

// Заглушка для проверки конвейера без ключа: карточка собирается из заголовка, помечена как тестовая.
function mockDraft(raw) {
  return {
    skip: false,
    title: raw.title.slice(0, 140),
    highlight: '',
    summary: (raw.text || raw.title).slice(0, 560),
    gloss: 'ТЕСТОВЫЙ ЧЕРНОВИК: текст не написан ИИ, замените перед публикацией.',
    tip: 'Прочитайте первоисточник по ссылке.',
    affects: ['all'],
    audiences: { borrowers: { meaning: 'Тестовый черновик.', steps: ['Откройте первоисточник и оцените, касается ли это вас.'] } },
    calc: null, critical: false, confidence: 'low',
    confidenceNote: 'Сгенерировано заглушкой без участия ИИ.', topics: []
  };
}

function toCard(raw, d) {
  const date = raw.publishedAt.slice(0, 10);
  return {
    id: `${date}-${raw.id}`.toLowerCase(),
    status: 'draft',
    publishedAt: raw.publishedAt,
    source: { name: raw.sourceName, url: raw.url },
    title: d.title, highlight: d.highlight || '',
    summary: d.summary, gloss: d.gloss, tip: d.tip,
    critical: !!d.critical,
    affects: d.affects, audiences: d.audiences,
    calc: d.calc || null,
    confidence: d.confidence, confidenceNote: d.confidenceNote || '',
    topics: (d.topics || []).filter((t) => topicIds.includes(t)),
    review: { by: null, at: null },
    ai: { model: MOCK ? 'mock' : MODEL, generatedAt: new Date().toISOString() }
  };
}

async function draftOne(raw) {
  if (MOCK) return { d: mockDraft(raw), errors: [] };
  const messages = [{ role: 'user', content: userPrompt(raw) }];
  let last = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let text;
    try {
      text = await callClaude(messages);
      const d = parseJsonLoose(text);
      if (d.skip) return { skip: d.reason || 'не имеет практического значения' };
      const card = toCard(raw, d);
      last = validateCard(card);
      if (!last.length) return { d, errors: [] };
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: `Есть ошибки: ${last.join('; ')}. Исправь и верни только JSON.` });
    } catch (err) {
      last = [err.message];
      if (/API 4(29|0[13])|API 5/.test(err.message)) break;
      if (text) messages.push({ role: 'assistant', content: text }, { role: 'user', content: `Ошибка разбора: ${err.message}. Верни только корректный JSON.` });
    }
  }
  return { d: null, errors: last };
}

const files = fs.readdirSync(RAW).filter((f) => f.endsWith('.json')).sort();
const pending = [];
for (const f of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
  if (!raw.drafted) pending.push({ f, raw });
}
pending.sort((a, b) => Date.parse(b.raw.publishedAt) - Date.parse(a.raw.publishedAt));
const batch = pending.slice(0, cfg.maxNewItemsPerRun || 8);
console.log(`Ждут черновика: ${pending.length}, берём: ${batch.length}${MOCK ? ' (тестовый режим)' : ` (модель ${MODEL})`}`);

let made = 0, skipped = 0, failed = 0;
for (const { f, raw } of batch) {
  const r = await draftOne(raw);
  const rawPath = path.join(RAW, f);
  if (r.skip) {
    raw.drafted = true; raw.skipReason = r.skip;
    fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2) + '\n');
    skipped++; console.log(`  пропуск: ${raw.title.slice(0, 60)} — ${r.skip}`);
    continue;
  }
  if (!r.d) {
    failed++; console.warn(`  не вышло: ${raw.title.slice(0, 60)} — ${r.errors.join('; ')} (попробуем в следующий раз)`);
    continue;
  }
  const card = toCard(raw, r.d);
  fs.writeFileSync(path.join(OUT, `${card.id}.json`), JSON.stringify(card, null, 2) + '\n');
  raw.drafted = true;
  fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2) + '\n');
  made++; console.log(`  черновик: ${card.id}`);
}
console.log(`Готово: черновиков ${made}, пропущено ${skipped}, ошибок ${failed}`);

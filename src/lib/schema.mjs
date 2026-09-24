// Проверка карточки новости. Один и тот же набор правил используют:
// сборка сайта, помощник черновиков и редакторский просмотр.
// Правила защищают доверие: нет источника, нет проверки редактором, обещаний дохода и «покупайте/продавайте» быть не может.

import { AUDIENCES, AUDIENCE_TABS } from './util.mjs';

const CONF = ['high', 'medium', 'low'];
const STATUS = ['draft', 'published'];

// Формулировки, которые на сайте недопустимы
// Флаг u и \p{L}: обычные \w и \b в JavaScript понимают только латиницу, на русском тексте они не срабатывают
export const FORBIDDEN = [
  { re: /гарантирован\p{L}*\s+(доход|прибыл|заработ)/iu, why: 'обещание гарантированного дохода' },
  { re: /(точно|обязательно)\s+(заработа|разбогате)/iu, why: 'обещание заработка' },
  { re: /(?<!\p{L})(покупайте|продавайте|вкладывайте\s+в)(?!\p{L})/iu, why: 'инвестиционная рекомендация' },
  { re: /без\s+риск(а|ов)/iu, why: 'утверждение «без риска»' }
];

function str(v, name, max, errors, { required = true } = {}) {
  if (v == null || v === '') {
    if (required) errors.push(`${name}: пусто`);
    return;
  }
  if (typeof v !== 'string') return errors.push(`${name}: должен быть текст`);
  if (v.length > max) errors.push(`${name}: длиннее ${max} знаков (${v.length})`);
  for (const f of FORBIDDEN) {
    if (f.re.test(v)) errors.push(`${name}: ${f.why}`);
  }
}

export function validateCard(card, { forPublish = false } = {}) {
  const e = [];
  if (!card || typeof card !== 'object') return ['карточка не объект'];

  if (!/^[a-z0-9][a-z0-9-]{5,80}$/.test(card.id || '')) e.push('id: латиница, цифры и дефисы, 6–80 знаков');
  if (!STATUS.includes(card.status)) e.push('status: draft или published');
  if (!card.publishedAt || Number.isNaN(Date.parse(card.publishedAt))) e.push('publishedAt: нужна дата в формате ISO');

  const src = card.source || {};
  str(src.name, 'source.name', 80, e);
  if (!/^https?:\/\//.test(src.url || '')) e.push('source.url: нужна ссылка на первоисточник');

  str(card.title, 'title', 140, e);
  str(card.highlight, 'highlight', 80, e, { required: false });
  if (card.highlight && card.title && !card.title.includes(card.highlight)) e.push('highlight: этой фразы нет в заголовке');
  str(card.summary, 'summary', 600, e);
  str(card.gloss, 'gloss', 180, e);
  str(card.tip, 'tip', 160, e);

  if (!Array.isArray(card.affects) || !card.affects.length) e.push('affects: укажите, кого касается');
  else for (const a of card.affects) if (!(a in AUDIENCES)) e.push(`affects: неизвестная аудитория «${a}»`);

  const aud = card.audiences || {};
  for (const [k, v] of Object.entries(aud)) {
    if (!AUDIENCE_TABS.includes(k)) { e.push(`audiences.${k}: неизвестная аудитория`); continue; }
    str(v?.meaning, `audiences.${k}.meaning`, 420, e);
    if (!Array.isArray(v?.steps) || v.steps.length < 1 || v.steps.length > 3) e.push(`audiences.${k}.steps: от 1 до 3 шагов`);
    else v.steps.forEach((s, i) => str(s, `audiences.${k}.steps[${i}]`, 260, e));
  }

  if (!CONF.includes(card.confidence)) e.push('confidence: high, medium или low');
  str(card.confidenceNote, 'confidenceNote', 240, e, { required: false });
  if (card.calc != null && !['mortgage', 'deposit'].includes(card.calc)) e.push('calc: mortgage, deposit или пусто');
  if (card.critical != null && typeof card.critical !== 'boolean') e.push('critical: true или false');

  if (forPublish || card.status === 'published') {
    if (!card.review || !String(card.review.by || '').trim()) e.push('review.by: опубликовать можно только после проверки — укажите, кто проверил');
    if (!card.review || !card.review.at || Number.isNaN(Date.parse(card.review.at))) e.push('review.at: укажите дату проверки');
  }
  return e;
}

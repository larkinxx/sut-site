// Загрузка содержимого сайта из папки content/ и настроек из config/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCard } from './schema.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readJson(rel, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  } catch (err) {
    if (fallback !== undefined && err.code === 'ENOENT') return fallback;
    throw new Error(`Не удалось прочитать ${rel}: ${err.message}`);
  }
}

export function loadSite() {
  return readJson('config/site.json');
}

function listJson(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f));
}

// Возвращает { cards, problems }. Показываются только опубликованные и проверенные карточки.
export function loadCards({ withExamples = false } = {}) {
  const files = [...listJson('content/news'), ...(withExamples ? listJson('content/examples') : [])];
  const cards = [];
  const problems = [];
  for (const rel of files) {
    let card;
    try {
      card = readJson(rel);
    } catch (err) {
      problems.push(`${rel}: ${err.message}`);
      continue;
    }
    // Примеры: время публикации считается от «сейчас», чтобы лента за 24 часа не была пустой
    if (card.minutesAgo != null) {
      card.publishedAt = new Date(Date.now() - card.minutesAgo * 60000).toISOString();
      card.review = { ...card.review, at: new Date().toISOString() };
    }
    if (card.status !== 'published') continue;
    const errs = validateCard(card, { forPublish: true });
    if (errs.length) {
      problems.push(`${rel}: ${errs.join('; ')}`);
      continue;
    }
    cards.push(card);
  }
  cards.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return { cards, problems };
}

export function loadTopics() {
  return readJson('content/topics.json');
}

// Курсы и видео сторонних авторов: без даты согласия автора материал не попадает на сайт.
export function loadMaterials() {
  const list = readJson('content/courses.json', { items: [] }).items || [];
  const ok = [];
  const problems = [];
  list.forEach((m, i) => {
    const miss = [];
    for (const k of ['id', 'kind', 'title', 'author', 'url', 'consentDate', 'updatedAt', 'topics']) {
      if (m[k] == null || m[k] === '' || (Array.isArray(m[k]) && !m[k].length)) miss.push(k);
    }
    if (!['video', 'course'].includes(m.kind)) miss.push('kind (video или course)');
    if (miss.length) problems.push(`content/courses.json, запись ${i + 1}: не заполнено ${miss.join(', ')}`);
    else ok.push(m);
  });
  return { materials: ok, problems };
}

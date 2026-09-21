// Быстрая публикация проверенной карточки из командной строки.
//   npm run review                      — список черновиков
//   npm run review -- <id> "Имя"        — отметить проверенной и опубликовать
// Можно и без этого: откройте файл в content/news/, поменяйте "status" на "published"
// и впишите review.by и review.at — сборка проверит то же самое.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/lib/content.mjs';
import { validateCard } from '../src/lib/schema.mjs';

const dir = path.join(ROOT, 'content/news');
const [id, ...nameParts] = process.argv.slice(2);
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];

if (!id) {
  const list = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).filter((c) => c.status !== 'published');
  if (!list.length) console.log('Черновиков нет.');
  else {
    for (const c of list) console.log(`${c.id}\n   ${c.title}\n   ${c.source?.url}`);
    console.log('\nПосле проверки: npm run review -- <id> "Ваше имя"');
  }
} else {
  const file = path.join(dir, `${id}.json`);
  const name = nameParts.join(' ').trim();
  if (!fs.existsSync(file)) { console.error(`Нет карточки ${id}`); process.exit(1); }
  if (!name) { console.error('Укажите, кто проверил: npm run review -- <id> "Имя"'); process.exit(1); }
  const card = JSON.parse(fs.readFileSync(file, 'utf8'));
  card.status = 'published';
  card.review = { by: name, at: new Date().toISOString() };
  const errs = validateCard(card, { forPublish: true });
  if (errs.length) { console.error('Нельзя опубликовать:\n - ' + errs.join('\n - ')); process.exit(1); }
  fs.writeFileSync(file, JSON.stringify(card, null, 2) + '\n');
  console.log(`Опубликовано: ${card.title}`);
}

// Проверка всего содержимого: карточки, курсы. Код выхода 1, если есть ошибки в опубликованном.
// Запуск: npm run check
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson, loadMaterials } from '../src/lib/content.mjs';
import { validateCard } from '../src/lib/schema.mjs';

let bad = 0, drafts = 0, pub = 0;
const dir = path.join(ROOT, 'content/news');
for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.json')) : []) {
  let card;
  try { card = readJson(`content/news/${f}`); } catch (e) { console.log(`✗ ${f}: ${e.message}`); bad++; continue; }
  const errs = validateCard(card, { forPublish: card.status === 'published' });
  if (card.status === 'published') pub++; else drafts++;
  if (card.status === 'published' && errs.length) { bad++; console.log(`✗ ${f} (опубликована, но не проходит проверку)\n   - ${errs.join('\n   - ')}`); }
  else if (card.status !== 'published' && errs.length) console.log(`· ${f} (черновик, пока есть замечания): ${errs.join('; ')}`);
}
const { materials, problems } = loadMaterials();
problems.forEach((p) => { console.log(`✗ ${p}`); bad++; });
console.log(`Опубликовано: ${pub}, черновиков: ${drafts}, курсов/видео с согласием: ${materials.length}`);
process.exit(bad ? 1 : 0);

// Публикует новые опубликованные новости в Telegram-канал. Запускается после сбора новостей (pipeline.yml).
// Нужны секреты TELEGRAM_BOT_TOKEN (бот от @BotFather, добавлен в канал администратором) и TELEGRAM_CHAT_ID
// (например, @sut_news или числовой id канала). Без них скрипт ничего не делает.
// Что уже отправлено, хранится в content/telegram.json. При первом запуске старые новости помечаются
// как отправленные, чтобы не завалить канал архивом.
// Запуск: npm run telegram
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadCards } from '../src/lib/content.mjs';

const STATE = path.join(ROOT, 'content', 'telegram.json');
const PER_RUN = 5;
const html = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function message(c, siteUrl) {
  return [
    c.critical ? '<b>❗ Важно</b>' : '',
    `<b>${html(c.title)}</b>`,
    '',
    html(c.gloss),
    '',
    `<b>Что делать:</b> ${html(c.tip)}`,
    '',
    `<a href="${siteUrl}/n/${c.id}/">Полный разбор</a> · источник: ${html(c.source.name)}${c.review && c.review.auto ? ' · подготовлено автоматически' : ''}`
  ].filter((x, i) => i || x).join('\n');
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  const siteUrl = (process.env.SITE_URL || 'https://innfact.ru').replace(/\/$/, '');
  if (!token || !chat) { console.log('TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не заданы — пропускаю.'); return; }
  const { cards } = loadCards();
  const save = (posted) => fs.writeFileSync(STATE, JSON.stringify({ posted: posted.slice(-500) }, null, 2) + '\n');
  if (!fs.existsSync(STATE)) {
    save(cards.map((c) => c.id).reverse());
    console.log(`Первый запуск: ${cards.length} старых новостей отмечены как отправленные.`);
    return;
  }
  const posted = JSON.parse(fs.readFileSync(STATE, 'utf8')).posted || [];
  const fresh = cards.filter((c) => !posted.includes(c.id)).reverse().slice(0, PER_RUN); // старые первыми
  for (const c of fresh) {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: message(c, siteUrl), parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(20000)
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { console.error(`Не отправлено ${c.id}: ${j.description || r.status}`); break; }
    posted.push(c.id);
    console.log('Отправлено:', c.title);
  }
  save(posted);
  if (!fresh.length) console.log('Новых новостей для канала нет.');
}

if (import.meta.url === `file://${process.argv[1]}`) main();

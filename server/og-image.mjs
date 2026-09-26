// Картинка-превью проверки компании для мессенджеров и соцсетей (1200×630): /organizacii/<ИНН>/og.png.
// Рисуем SVG и переводим в PNG утилитой rsvg-convert (пакет librsvg2-bin; шрифты — fonts-paratype, PT Serif):
// Telegram и WhatsApp SVG в превью не показывают. Нет утилиты — отдаём общую картинку сайта.
import { spawn } from 'node:child_process';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };

// Перенос названия по словам: не больше двух строк, лишнее — многоточием
function wrap(text, maxChars) {
  const words = String(text).split(/\s+/);
  const lines = [''];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if (!cur) lines[lines.length - 1] = w;
    else if ((cur + ' ' + w).length <= maxChars) lines[lines.length - 1] = cur + ' ' + w;
    else lines.push(w);
  }
  if (lines.length > 2) { lines.length = 2; lines[1] = lines[1].slice(0, maxChars - 1).replace(/\s+\S*$/, '') + '…'; }
  return lines.map((l) => (l.length > maxChars ? l.slice(0, maxChars - 1) + '…' : l));
}

// facts: [[подпись, значение, 'bad'?], ...] — до четырёх
export function ogSvg({ name, inn, status, active, facts }) {
  // заглавные буквы жирного шрифта шире строчных: ширину символа считаем с запасом
  const size = name.length > 50 ? 42 : name.length > 28 ? 50 : 62;
  const lines = wrap(name, Math.floor(1080 / (size * 0.68)));
  const nameY = 190;
  const infoY = nameY + (lines.length - 1) * size * 1.15 + 58;
  const cells = facts.slice(0, 4).map(([label, value, bad], i) => {
    const x = 60 + (i % 2) * 540, y = infoY + 62 + Math.floor(i / 2) * 96;
    return `<text x="${x}" y="${y}" class="lbl">${esc(label)}</text><text x="${x}" y="${y + 44}" class="val${bad ? ' bad' : ''}">${esc(value)}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<style>
text{font-family:'PT Serif','DejaVu Serif',serif;fill:#1B2130}
.logo{font-size:44px;font-weight:700}.dot{fill:#8A6A34}
.kicker{font-family:'PT Sans','DejaVu Sans',sans-serif;font-size:22px;letter-spacing:4px;fill:#67707F}
.name{font-weight:700}
.info{font-family:'PT Sans','DejaVu Sans',sans-serif;font-size:28px;fill:#67707F}
.ok{fill:#227A4F}.badst{fill:#B03A4E}
.lbl{font-family:'PT Sans','DejaVu Sans',sans-serif;font-size:24px;fill:#67707F}
.val{font-size:40px;font-weight:700}.val.bad{fill:#B03A4E}
.foot{font-family:'PT Sans','DejaVu Sans',sans-serif;font-size:24px;fill:#67707F}
</style>
<rect width="1200" height="630" fill="#F3EEE1"/>
<rect x="24" y="24" width="1152" height="582" rx="10" fill="#FBF7ED" stroke="#E2DCCB" stroke-width="2"/>
<text x="60" y="100" class="logo">Суть<tspan class="dot">.</tspan></text>
<text x="1140" y="96" text-anchor="end" class="kicker">ПРОВЕРКА КОМПАНИИ</text>
${lines.map((l, i) => `<text x="60" y="${nameY + i * size * 1.12}" class="name" font-size="${size}">${esc(l)}</text>`).join('\n')}
<text x="60" y="${infoY}" class="info">ИНН ${esc(inn)}${status ? ` · <tspan class="${active ? 'ok' : 'badst'}">${esc(status)}</tspan>` : ''}</text>
${cells}
<text x="60" y="578" class="foot">fin-check.shop — бесплатная проверка контрагентов</text>
</svg>`;
}

// Какие цифры показать на картинке: из данных ФНС и, если человек недавно проверял компанию, из судов и реестров
export function ogFacts(f, more, money) {
  const out = [];
  if (f && f.tax) out.push([`Налоги за ${f.tax.year}`, money(f.tax.total)]);
  if (f && f.staff) out.push(['Сотрудников', String(f.staff.n)]);
  const c = more && more.card, a = more && more.arbitration;
  if (c) out.push(['Отметки в реестрах', c.flags.length ? `${c.flags.length} ${plural(c.flags.length, 'отметка', 'отметки', 'отметок')}` : 'нет', c.flags.length > 0]);
  if (a) out.push(['Арбитраж', a.total ? `${a.total} ${plural(a.total, 'дело', 'дела', 'дел')}` : 'дел нет']);
  if (f && out.length < 4) out.push(['Налоговый долг', f.debt > 0 ? money(f.debt) : 'нет', f.debt > 0]);
  if (f && out.length < 4) out.push(['Налоговый режим', f.regime]);
  return out.slice(0, 4);
}

export function svgToPng(svg, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const p = spawn('rsvg-convert', ['-w', '1200', '-h', '630', '-f', 'png']);
    const chunks = [];
    const timer = setTimeout(() => { p.kill(); reject(new Error('rsvg-convert: таймаут')); }, timeout);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('rsvg-convert: код ' + code)); });
    p.stdin.end(svg);
  });
}

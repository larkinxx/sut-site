// Общие мелкие функции: экранирование, склонения, даты, названия аудиторий.

export const AUDIENCES = {
  all: 'Всем',
  borrowers: 'Заёмщикам',
  savers: 'Вкладчикам',
  selfemployed: 'Самозанятым',
  business: 'Малому бизнесу'
};

// Порядок и названия вкладок «Что это значит для вас»
export const AUDIENCE_TABS = ['borrowers', 'savers', 'selfemployed', 'business'];

export function esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Выделяет в заголовке ключевую фразу (безопасно: сначала экранирует текст)
export function markTitle(title, highlight) {
  const t = String(title || '');
  const h = String(highlight || '');
  const i = h ? t.indexOf(h) : -1;
  if (i < 0) return esc(t);
  return esc(t.slice(0, i)) + '<mark>' + esc(h) + '</mark>' + esc(t.slice(i + h.length));
}

export function plural(n, forms) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return forms[0];
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1];
  return forms[2];
}

// «25 минут назад», «3 часа назад», «2 дня назад»
export function agoRu(ms) {
  const min = Math.max(0, Math.floor(ms / 60000));
  if (min < 1) return 'только что';
  if (min < 60) return `${min} ${plural(min, ['минуту', 'минуты', 'минут'])} назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ${plural(h, ['час', 'часа', 'часов'])} назад`;
  const d = Math.floor(h / 24);
  return `${d} ${plural(d, ['день', 'дня', 'дней'])} назад`;
}

const dateFmt = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow'
});
export function dateRu(iso) {
  return dateFmt.format(new Date(iso)) + ' МСК';
}

export function slugFromId(id) {
  return String(id).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function fmtRub(n) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' ₽';
}

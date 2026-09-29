// Форма ЦБ защищена Yandex SmartCaptcha и не принимает ИНН через query string,
// поэтому ссылка всегда ведёт на фиксированную страницу, а ИНН копируется в буфер.
export const ZSK_ORIGIN = 'https://cbr.ru';
export const ZSK_PATH = '/counteraction_m_ter/platform_zsk/proverka-po-inn/';

const W10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const W11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const W12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

const checkDigit = (d, w) => (w.reduce((s, k, i) => s + k * d[i], 0) % 11) % 10;

export function normalizeInn(raw) {
  const inn = String(raw ?? '').replace(/\D/g, '');
  if (!/^(\d{10}|\d{12})$/.test(inn)) return null;
  const d = [...inn].map(Number);
  const ok = inn.length === 10
    ? checkDigit(d, W10) === d[9]
    : checkDigit(d, W11) === d[10] && checkDigit(d, W12) === d[11];
  return ok ? inn : null;
}

export function buildZskUrl(rawInn) {
  const inn = normalizeInn(rawInn);
  if (!inn) return null;
  const url = new URL(ZSK_PATH, ZSK_ORIGIN);
  if (url.origin !== ZSK_ORIGIN || url.pathname !== ZSK_PATH) return null;
  return { url: url.href, inn };
}

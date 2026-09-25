// Проверка сайта компании: открывается ли, защищённое ли соединение, указан ли на главной ИНН компании
// (значит, сайт почти наверняка её), сколько лет домену и какие соцсети на нём указаны.
// Адреса сайтов приходят из реестров, но на всякий случай ходим только на публичные адреса (не во внутреннюю сеть).
import dns from 'node:dns/promises';
import net from 'node:net';

const SOCIAL = [
  ['vk.com', 'ВКонтакте'], ['t.me', 'Telegram'], ['ok.ru', 'Одноклассники'], ['dzen.ru', 'Дзен'],
  ['rutube.ru', 'Rutube'], ['youtube.com', 'YouTube'], ['vc.ru', 'vc.ru'], ['hh.ru', 'hh.ru']
];

function privateIp(ip) {
  if (net.isIPv6(ip)) return /^(::1|fc|fd|fe80|::ffff:(10|127|192\.168|169\.254|172\.(1[6-9]|2\d|3[01]))\.)/i.test(ip) || ip === '::';
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export function normalizeSite(v) {
  let s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  if (!/^https?:\/\//.test(s)) s = 'http://' + s;
  try { const u = new URL(s); return u.hostname.includes('.') ? u : null; } catch { return null; }
}

// Возраст домена по WHOIS (для .ru, .su и .рф — сервер whois.tcinet.ru)
export function whoisCreated(host, timeout = 6000) {
  const parts = host.replace(/^www\./, '').split('.');
  const zone = parts[parts.length - 1];
  if (!['ru', 'su', 'xn--p1ai'].includes(zone)) return Promise.resolve(null);
  const domain = parts.slice(-2).join('.');
  return new Promise((resolve) => {
    let buf = '';
    const sock = net.connect(43, 'whois.tcinet.ru', () => sock.write(domain + '\r\n'));
    sock.setTimeout(timeout, () => { sock.destroy(); resolve(null); });
    sock.on('data', (c) => { buf += c.toString('utf8'); if (buf.length > 20000) sock.destroy(); });
    sock.on('error', () => resolve(null));
    sock.on('close', () => { const m = /created:\s*(\d{4}-\d{2}-\d{2})/i.exec(buf); resolve(m ? m[1] : null); });
  });
}

export async function checkSite(site, inn, { fetchImpl = globalThis.fetch, lookup = dns.lookup, whois = whoisCreated, now = Date.now() } = {}) {
  const u = normalizeSite(site);
  if (!u) return null;
  const out = { site: u.hostname.replace(/^www\./, ''), url: null, opens: false, https: false, innFound: false, title: null, socials: [], created: null, ageYears: null };
  const [created, page] = await Promise.all([
    whois(u.hostname).catch(() => null),
    (async () => {
      const { address } = await lookup(u.hostname);
      if (privateIp(address)) throw new Error('внутренний адрес');
      for (const proto of ['https:', 'http:']) {
        try {
          const r = await fetchImpl(`${proto}//${u.hostname}/`, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; fin-check.shop)' }, signal: AbortSignal.timeout(8000) });
          if (!r.ok) continue;
          const html = (await r.text()).slice(0, 1_500_000);
          return { url: r.url || `${proto}//${u.hostname}/`, html };
        } catch { /* пробуем http */ }
      }
      return null;
    })().catch(() => null)
  ]);
  if (created) { out.created = created; out.ageYears = Math.floor((now - Date.parse(created)) / (365.25 * 864e5) * 10) / 10; }
  if (page) {
    out.opens = true;
    out.url = page.url;
    out.https = page.url.startsWith('https:');
    const text = page.html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ');
    out.innFound = new RegExp(`(^|\\D)${inn}(\\D|$)`).test(text.replace(/[\s\u00a0]/g, ''));
    out.title = (/<title[^>]*>([^<]{1,200})<\/title>/i.exec(page.html)?.[1] || '').replace(/\s+/g, ' ').trim() || null;
    const links = [...page.html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
    for (const [dom, name] of SOCIAL) {
      const link = links.find((l) => new RegExp(`^https?://(www\\.)?${dom.replace('.', '\\.')}/[^\\s]+`, 'i').test(l));
      if (link) out.socials.push({ name, url: link.slice(0, 200) });
    }
  }
  return out;
}

const years = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'год' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'года' : 'лет'}`;

// Короткая оценка без вердиктов: что проверено и на что обратить внимание
export function siteNotes(c) {
  if (!c) return [];
  const notes = [];
  if (!c.opens) { notes.push({ level: 'warn', text: 'Сайт не открылся. Возможно, он заброшен или временно не работает.' }); }
  else {
    notes.push(c.innFound
      ? { level: 'ok', text: 'На главной странице указан ИНН компании — сайт, скорее всего, действительно её.' }
      : { level: 'info', text: 'ИНН на главной странице не найден. Проверьте реквизиты в разделе «Контакты» или «О компании», прежде чем доверять сайту.' });
    if (!c.https) notes.push({ level: 'warn', text: 'Сайт работает без защищённого соединения (HTTPS). Не вводите на нём платёжные данные.' });
  }
  if (c.ageYears != null) notes.push(c.ageYears < 1
    ? { level: 'warn', text: `Домен зарегистрирован недавно (${c.created.split('-').reverse().join('.')}). У давно работающей компании молодой сайт — повод уточнить.` }
    : { level: 'info', text: `Домену ${years(Math.floor(c.ageYears))}: он зарегистрирован ${c.created.split('-').reverse().join('.')}.` });
  if (c.socials.length) notes.push({ level: 'info', text: 'На сайте указаны: ' + c.socials.map((s) => s.name).join(', ') + '.' });
  return notes;
}

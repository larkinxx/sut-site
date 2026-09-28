// «Сертификат проверки» — как сертификат подлинности у часовых домов: отчёт подписчика получает номер,
// а по адресу /sertifikat/<номер>/ любой может убедиться, что проверка настоящая, и увидеть, что было известно
// о компании на эту дату (для партнёров, руководителя и как подтверждение должной осмотрительности, ст. 54.1 НК).
// Хранится только снимок открытых сведений о компании; кто выписал сертификат, на странице не показывается.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { esc } from './company-page.mjs';
import { qrSvg } from './qr.mjs';

const ABC = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // без 0/O и 1/I, чтобы номер легко читался с бумаги
const STATUS = { ACTIVE: 'Действует', LIQUIDATING: 'Ликвидируется', LIQUIDATED: 'Ликвидирована', BANKRUPT: 'Банкротство', REORGANIZING: 'Реорганизация' };
const money = (n) => (n == null ? '—' : new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' ₽');

export function newCertId(rand = crypto.randomBytes) {
  const b = rand(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ABC[b[i] % ABC.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}

// Снимок: только сведения о компании из открытых источников и индекс, как их видел подписчик
export function certSnapshot({ inn, suggestion, fns, more, index }) {
  const d = (suggestion && suggestion.data) || {}, st = d.state || {}, pb = fns && fns.pb;
  return {
    inn, name: d.name?.short_with_opf || suggestion?.value || '', ogrn: d.ogrn || null,
    status: st.status || null, registered: st.registration_date || null, address: d.address?.value || null,
    index: index ? { score: index.score, level: index.level } : null,
    taxes: pb?.taxesPaid ? { year: pb.taxesPaid.year, total: pb.taxesPaid.total } : null,
    staff: pb?.employees?.[0]?.n ?? null, debt: pb?.arrears?.total ?? null,
    arb: more?.arbitration ? { defendant: more.arbitration.defendant, open: more.arbitration.openDefendant } : null,
    fssp: more?.fssp ? { open: more.fssp.open, sum: more.fssp.openSum } : null,
    courtsDef: more?.courts ? more.courts.defendant : null
  };
}

export function createCerts({ env = {}, db, now = () => Date.now(), perUserDay = 100 }) {
  db.exec(`CREATE TABLE IF NOT EXISTS certs (id TEXT PRIMARY KEY, inn TEXT NOT NULL, data TEXT NOT NULL, user_id INTEGER, created_at INTEGER NOT NULL);
           CREATE INDEX IF NOT EXISTS certs_user ON certs (user_id, created_at)`);
  const dist = env.SITE_DIST || '/var/www/fin-check.shop';
  const siteUrl = (env.SITE_URL || 'https://inn-sider.ru').replace(/\/$/, '');

  function issue(userId, snap) {
    const since = now() - 864e5;
    if (db.prepare('SELECT COUNT(*) AS n FROM certs WHERE user_id = ? AND created_at > ?').get(userId, since).n >= perUserDay) return null;
    for (let i = 0; i < 5; i++) {
      const id = newCertId();
      try {
        db.prepare('INSERT INTO certs (id, inn, data, user_id, created_at) VALUES (?, ?, ?, ?, ?)').run(id, snap.inn, JSON.stringify(snap), userId, now());
        const url = `${siteUrl}/sertifikat/${id}/`;
        return { id, url, at: now(), qr: qrSvg(url, { size: 96, label: 'QR-код: проверить сертификат' }) };
      } catch (e) { if (!/UNIQUE/.test(e.message)) throw e; }
    }
    return null;
  }

  function page(id) {
    const row = db.prepare('SELECT * FROM certs WHERE id = ?').get(id);
    if (!row) return null;
    const s = JSON.parse(row.data), at = new Date(row.created_at);
    const when = at.toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    const rows = [
      ['Организация', s.name], ['ИНН', s.inn], ['ОГРН', s.ogrn], ['Статус', STATUS[s.status] || s.status],
      ['Дата регистрации', s.registered ? new Date(s.registered).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) : null],
      ['Адрес', s.address],
      ['Индекс надёжности INNSIDER', s.index ? `${s.index.score} из 100 — ${s.index.level}` : null],
      ['Уплачено налогов и взносов', s.taxes ? `${money(s.taxes.total)} за ${s.taxes.year} год` : null],
      ['Сотрудников', s.staff != null ? new Intl.NumberFormat('ru-RU').format(s.staff) : null], ['Налоговая задолженность', s.debt != null ? (s.debt > 0 ? money(s.debt) : 'нет') : null],
      ['Арбитраж, где компания — ответчик', s.arb ? `${s.arb.defendant}, из них идут сейчас: ${s.arb.open}` : null],
      ['Суды общей юрисдикции, ответчик', s.courtsDef],
      ['Производства у приставов', s.fssp ? (s.fssp.open ? `${s.fssp.open} на ${money(s.fssp.sum)}` : 'нет открытых') : null]
    ].filter(([, v]) => v != null && v !== '');
    return {
      title: `Сертификат проверки № ${id}`,
      body: `<p class="cert-no">№ ${esc(id)}</p>
<p class="lede">Проверка организации проведена на сервисе INNSIDER ${esc(when)} (МСК). Ниже — сведения из открытых источников, которые были известны на этот момент.</p>
<div class="result cols cert-facts">${rows.map(([k, v]) => `<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')}</div>
<figure class="cert-qr">${qrSvg(`${siteUrl}/sertifikat/${id}/`, { label: 'QR-код этой страницы' })}<figcaption>Наведите камеру телефона, чтобы открыть этот сертификат</figcaption></figure>
<p class="note-sm">Сертификат подтверждает дату проверки и её результат: сведения зафиксированы на сервере и не меняются. Источники — ЕГРЮЛ, открытые данные ФНС, картотека арбитражных дел и банк данных ФССП. Это не заключение о надёжности компании и не юридическое мнение.</p>
<p><a class="btn" href="/organizacii/${esc(s.inn)}/">Актуальные сведения о компании</a></p>`
    };
  }

  // true — запрос обработан здесь
  function handle(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const m = /^\/sertifikat\/([2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4})\/?$/.exec(url.pathname);
    if (!m && !url.pathname.startsWith('/sertifikat/')) return false;
    const file = path.join(dist, 'sertifikat', 'index.html');
    if (!fs.existsSync(file)) return false;
    const tpl = fs.readFileSync(file, 'utf8');
    const p = m && page(m[1]);
    const html = tpl
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(p ? p.title : 'Сертификат не найден')} — INNSIDER</title>`)
      .replace(/<!--ssr:intro-->[\s\S]*?<!--\/ssr:intro-->/, `<h1 class="page">${p ? 'Сертификат проверки' : 'Сертификат не найден'}</h1>`)
      .replace(/<!--ssr:body-->[\s\S]*?<!--\/ssr:body-->/, p ? p.body : '<p class="lede">Проверьте номер: он состоит из восьми букв и цифр, например 7KQ2-M9XA. Если номер верный, а сертификата нет, — напишите нам.</p>');
    res.writeHead(p ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': p ? 'public, max-age=86400' : 'no-store' });
    res.end(html);
    return true;
  }
  return { issue, page, handle };
}

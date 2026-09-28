// Тесты сертификатов проверки (server/certs.mjs): номер, снимок, публичная страница, лимит
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCerts, certSnapshot, newCertId } from './certs.mjs';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok  ', name); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'));
fs.mkdirSync(path.join(dir, 'sertifikat'));
fs.writeFileSync(path.join(dir, 'sertifikat', 'index.html'), '<head><title>x</title></head><!--ssr:intro--><h1>x</h1><!--/ssr:intro--><!--ssr:body--><p>…</p><!--/ssr:body-->');
const S = { value: 'ООО "РОМАШКА"', data: { inn: '7707083893', ogrn: '1027700132195', name: { short_with_opf: 'ООО "РОМАШКА"' }, state: { status: 'ACTIVE', registration_date: Date.UTC(2010, 0, 5) }, address: { value: 'г Москва, ул Вавилова, д 19' }, management: { name: 'Иванов Иван Иванович' } } };
const get = (certs, p) => { let code, body = ''; const res = { writeHead: (c) => { code = c; }, end: (b) => { body = b; } }; const ok = certs.handle({ method: 'GET' }, res, new URL('https://x' + p)); return { ok, code, body }; };

await t('номер: 8 знаков без путаницы 0/O и 1/I, через дефис', () => {
  for (let i = 0; i < 200; i++) assert.match(newCertId(), /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  assert.equal(newCertId(() => Buffer.alloc(8)), '2222-2222');
});

await t('снимок — только сведения о компании, без ФИО руководителя', () => {
  const s = certSnapshot({ inn: '7707083893', suggestion: S, fns: { pb: { taxesPaid: { year: 2025, total: 5e6 }, employees: [{ n: 12 }], arrears: { total: 0 } } }, more: { fssp: { open: 1, openSum: 20000 }, arbitration: { defendant: 3, openDefendant: 1 } }, index: { score: 81, level: 'высокий' } });
  assert.equal(s.name, 'ООО "РОМАШКА"');
  assert.deepEqual(s.index, { score: 81, level: 'высокий' });
  assert.deepEqual(s.fssp, { open: 1, sum: 20000 });
  assert.doesNotMatch(JSON.stringify(s), /Иванов/);
});

await t('выдача, публичная страница, неизвестный номер, чужие адреса', () => {
  let clock = Date.UTC(2026, 8, 28, 9, 30);
  const certs = createCerts({ env: { SITE_DIST: dir, SITE_URL: 'https://inn-sider.ru' }, db: new DatabaseSync(':memory:'), now: () => clock, perUserDay: 2 });
  const snap = certSnapshot({ inn: '7707083893', suggestion: S, index: { score: 81, level: 'высокий' } });
  const c = certs.issue(1, snap);
  assert.match(c.url, /^https:\/\/inn-sider\.ru\/sertifikat\/[2-9A-Z]{4}-[2-9A-Z]{4}\/$/);
  const r = get(certs, `/sertifikat/${c.id}/`);
  assert.equal(r.code, 200);
  assert.match(r.body, new RegExp(`№ ${c.id}`));
  assert.match(r.body, /81 из 100 — высокий/);
  assert.match(r.body, /<figure class="cert-qr"><svg class="qr"[^>]*aria-label="QR-код этой страницы"/);
  assert.match(c.qr, /^<svg class="qr"/, 'QR для печатного отчёта');
  assert.match(r.body, /28 сентября 2026.{0,6}12:30 \(МСК\)/);
  assert.equal(get(certs, '/sertifikat/2222-2222/').code, 404);
  assert.equal(get(certs, '/sertifikat/abc/').code, 404);
  assert.equal(get(certs, '/organizacii/').ok, false);
  // лимит в сутки на подписчика
  assert.ok(certs.issue(1, snap));
  assert.equal(certs.issue(1, snap), null);
  assert.ok(certs.issue(2, snap), 'у другого подписчика свой лимит');
  clock += 864e5 + 1;
  assert.ok(certs.issue(1, snap), 'на следующий день снова можно');
});

await t('знак $ в названии не ломает шаблон', () => {
  const certs = createCerts({ env: { SITE_DIST: dir }, db: new DatabaseSync(':memory:') });
  const c = certs.issue(1, { ...certSnapshot({ inn: '7707083893', suggestion: S }), name: "ООО \"$'$&\"" });
  const r = get(certs, `/sertifikat/${c.id}/`);
  assert.match(r.body, /ООО &quot;&#36;&#39;&#36;&amp;&quot;/);
  assert.equal((r.body.match(/<\/head>/g) || []).length, 1);
});

fs.rmSync(dir, { recursive: true });
console.log(`\nВсе тесты сертификатов прошли: ${n}`);

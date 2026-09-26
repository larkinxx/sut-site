// Аккаунты «Сути»: необязательный вход (Яндекс ID, Telegram, код на почту), кабинет и слежение за компаниями.
// Почта, Яндекс ID и Telegram ID — персональные данные: по 152-ФЗ храним их только на сервере в России
// (Timeweb), поэтому модуль включается переменной ACCOUNTS_DB и не работает на Render.
//
// Маршруты (все ответы JSON, кроме переходов входа):
//   GET  /auth/yandex?return=/kabinet/&consent=1   — переход на oauth.yandex.ru
//   GET  /auth/yandex/callback                      — возврат от Яндекса, ставит сессию и ведёт обратно на сайт
//   POST /auth/telegram/start {consent}             — вход через бота: ссылка t.me/<бот>?start=<код>
//   GET  /auth/telegram/status?nonce=…              — сайт ждёт, пока человек подтвердит вход в боте
//   GET  /auth/telegram/callback?...&consent=1      — возврат от виджета Telegram Login (старый способ)
//   POST /auth/email/start   {email}                — отправить код на почту
//   POST /auth/email/verify  {email, code, consent} — войти по коду
//   POST /auth/logout
//   GET/PATCH/DELETE /api/me                        — профиль, «моя компания», уведомления; удаление аккаунта
//   GET/DELETE /api/history                         — история проверок
//   GET/POST/DELETE /api/watch                      — слежение за компаниями
//   GET/POST/DELETE /api/calcs                      — сохранённые расчёты
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

const DAY = 864e5;
const SESSION_DAYS = 90;
const LIMITS = { history: 200, watch: 50, calcs: 50 };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TG_LOGIN_TTL = 10 * 60e3;

/* ---------- база ---------- */
export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, consent_at INTEGER NOT NULL, last_seen INTEGER,
      name TEXT, email TEXT UNIQUE, yandex_id TEXT UNIQUE, telegram_id TEXT UNIQUE,
      company_inn TEXT, notify TEXT NOT NULL DEFAULT 'auto'
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_codes (
      email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL, sent_count INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS history (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, inn TEXT NOT NULL, name TEXT, at INTEGER NOT NULL,
      PRIMARY KEY (user_id, inn)
    );
    CREATE TABLE IF NOT EXISTS watch (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, inn TEXT NOT NULL, name TEXT, added_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, inn)
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      inn TEXT PRIMARY KEY, data TEXT NOT NULL, checked_at INTEGER NOT NULL, changed_at INTEGER, last_change TEXT
    );
    CREATE TABLE IF NOT EXISTS calcs (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      calc TEXT NOT NULL, title TEXT NOT NULL, link TEXT NOT NULL, saved_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}

/* ---------- слепок компании для слежения: только то, что важно контрагенту ---------- */
const STATUS_RU = { ACTIVE: 'действует', LIQUIDATING: 'ликвидируется', LIQUIDATED: 'ликвидирована', BANKRUPT: 'банкротство', REORGANIZING: 'реорганизация' };
export function snapshotOf(s) {
  const d = (s && s.data) || {};
  const f = d.finance || {};
  return {
    name: d.name?.short_with_opf || s?.value || '',
    status: d.state?.status || '',
    invalid: !!d.invalid,
    debt: Number(f.debt || 0),
    penalty: Number(f.penalty || 0),
    manager: d.management?.name || d.name?.full || '',
    address: d.address?.value || '',
    disqualified: !!d.management?.disqualified
  };
}
const rub = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' ₽';
export function diffSnapshots(a, b) {
  if (!a) return [];
  const out = [];
  if (a.status !== b.status) out.push(`статус: ${STATUS_RU[a.status] || a.status || '—'} → ${STATUS_RU[b.status] || b.status || '—'}`);
  if (!a.invalid && b.invalid) out.push('в реестре появилась отметка о недостоверности сведений');
  if (b.debt > a.debt) out.push(`налоговая недоимка выросла до ${rub(b.debt)}`);
  if (b.penalty > a.penalty) out.push(`штрафы выросли до ${rub(b.penalty)}`);
  if (a.manager && b.manager && a.manager !== b.manager) out.push('сменился руководитель');
  if (a.address && b.address && a.address !== b.address) out.push('сменился адрес');
  if (!a.disqualified && b.disqualified) out.push('руководитель в реестре дисквалифицированных лиц');
  return out;
}

/* ---------- Telegram Login: проверка подписи виджета ---------- */
export function telegramCheck(params, botToken, now = Date.now()) {
  const { hash, ...rest } = params;
  if (!hash || !botToken) return null;
  const fields = ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date'];
  const check = fields.filter((k) => rest[k] != null && rest[k] !== '').sort().map((k) => `${k}=${rest[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(botToken).digest();
  const hmac = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (hmac.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(String(hash)))) return null;
  if (now / 1000 - Number(rest.auth_date) > 86400) return null;   // подписи старше суток не принимаем
  return { id: String(rest.id), name: [rest.first_name, rest.last_name].filter(Boolean).join(' ') || rest.username || '' };
}

/* ---------- почта: минимальный SMTP-клиент (неявный TLS, порт 465, AUTH LOGIN) ---------- */
export function smtpMailer({ host, port = 465, user, pass, from }) {
  return function send({ to, subject, text }) {
    return new Promise((resolve, reject) => {
      const sock = tls.connect(Number(port), host, { servername: host });
      sock.setTimeout(20000, () => { sock.destroy(); reject(new Error('SMTP: таймаут')); });
      let buf = '', waiting = null;
      sock.on('data', (c) => {
        buf += c.toString('utf8');
        const lines = buf.split('\r\n'); buf = lines.pop();
        for (const l of lines) if (/^\d{3} /.test(l) && waiting) { const w = waiting; waiting = null; w(l); }
      });
      sock.on('error', reject);
      const expect = (code) => new Promise((res2, rej2) => { waiting = (l) => (l.startsWith(String(code)) ? res2(l) : rej2(new Error('SMTP: ' + l))); });
      const cmd = (line, code) => { const p = expect(code); sock.write(line + '\r\n'); return p; };
      const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
      const body = b64(text).replace(/.{1,76}/g, '$&\r\n');
      const msg = [
        `From: =?UTF-8?B?${b64('Суть')}?= <${from}>`, `To: <${to}>`, `Subject: =?UTF-8?B?${b64(subject)}?=`,
        `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@${from.split('@')[1]}>`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body
      ].join('\r\n');
      (async () => {
        await expect(220);
        await cmd('EHLO ' + (String(from || '').split('@')[1] || 'localhost').replace(/>.*$/, ''), 250);
        await cmd('AUTH LOGIN', 334); await cmd(b64(user), 334); await cmd(b64(pass), 235);
        await cmd(`MAIL FROM:<${from}>`, 250); await cmd(`RCPT TO:<${to}>`, 250);
        await cmd('DATA', 354); await cmd(msg + '\r\n.', 250);
        sock.end('QUIT\r\n'); resolve();
      })().catch((e) => { sock.destroy(); reject(e); });
    });
  };
}

/* ---------- модуль аккаунтов ---------- */
export function createAccounts({ env, db, fetchImpl, mailer, now = () => Date.now() }) {
  const cfg = {
    site: (env.SITE_URL || 'https://innfact.ru').replace(/\/$/, ''),
    api: (env.PUBLIC_API_URL || 'https://api.innfact.ru').replace(/\/$/, ''),
    cookieDomain: env.COOKIE_DOMAIN || '',              // .innfact.ru — чтобы сессия была общей для сайта и api
    yandexId: env.YANDEX_CLIENT_ID || '', yandexSecret: env.YANDEX_CLIENT_SECRET || '',
    tgToken: env.TELEGRAM_BOT_TOKEN || '', tgBot: env.TELEGRAM_BOT_NAME || '',
    // Timeweb не пускает сервер к api.telegram.org — ходим через наш сервер на Render (маршрут /tg/ в index.mjs)
    tgApi: (env.TELEGRAM_API_URL || (env.AI_UPSTREAM_URL ? env.AI_UPSTREAM_URL.replace(/\/$/, '') + '/tg' : 'https://api.telegram.org')).replace(/\/$/, ''),
    mailOn: !!mailer
  };
  const host = new URL(cfg.site).host;   // адрес сайта для текстов писем и сообщений бота
  const q = (sql) => db.prepare(sql);
  const secure = cfg.site.startsWith('https');

  function cookie(name, value, maxAgeSec) {
    return [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', secure ? 'Secure' : '', cfg.cookieDomain ? `Domain=${cfg.cookieDomain}` : '', `Max-Age=${maxAgeSec}`].filter(Boolean).join('; ');
  }
  const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
  const safeReturn = (r) => (typeof r === 'string' && /^\/(?!\/)[\w\-./?=&#%]*$/.test(r) ? r : '/kabinet/');

  function startSession(userId) {
    const t = token();
    q('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha(t), userId, now(), now() + SESSION_DAYS * DAY);
    return cookie('sut_s', t, SESSION_DAYS * 86400);
  }
  function userOf(req) {
    const t = cookies(req).sut_s;
    if (!t) return null;
    const u = q('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?').get(sha(t), now());
    if (u) q('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), u.id);
    return u || null;
  }
  // Находим пользователя по id способа входа, иначе по подтверждённой почте; иначе создаём (с отметкой согласия).
  // Если человек уже вошёл (current) — привязываем новый способ входа к его аккаунту, а не создаём второй.
  function findOrCreate({ field, id, email, name }, current = null) {
    if (current) {
      const other = q(`SELECT id FROM users WHERE ${field} = ?`).get(id);
      if (other && other.id !== current.id) throw new Error('уже привязан');
      q(`UPDATE users SET ${field} = ? WHERE id = ?`).run(id, current.id);
      if (email && !current.email && !q('SELECT id FROM users WHERE email = ?').get(email)) q('UPDATE users SET email = ? WHERE id = ?').run(email, current.id);
      return q('SELECT * FROM users WHERE id = ?').get(current.id);
    }
    let u = q(`SELECT * FROM users WHERE ${field} = ?`).get(id);
    if (!u && email) {
      u = q('SELECT * FROM users WHERE email = ?').get(email);
      if (u) q(`UPDATE users SET ${field} = ? WHERE id = ?`).run(id, u.id);
    }
    if (!u) {
      const r = q(`INSERT INTO users (created_at, consent_at, name, email, ${field}) VALUES (?, ?, ?, ?, ?)`).run(now(), now(), name || null, email || null, id);
      u = q('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    } else if (!u.name && name) q('UPDATE users SET name = ? WHERE id = ?').run(name, u.id);
    return u;
  }
  const publicUser = (u) => ({
    name: u.name || (u.email ? u.email.split('@')[0] : 'Пользователь'), email: u.email || null,
    via: [u.yandex_id && 'yandex', u.telegram_id && 'telegram', u.email && 'email'].filter(Boolean),
    company_inn: u.company_inn || null, notify: channelOf(u), can_telegram: !!u.telegram_id, can_email: !!u.email
  });
  function channelOf(u) {
    if (u.notify === 'none') return 'none';
    if (u.notify === 'telegram' && u.telegram_id) return 'telegram';
    if (u.notify === 'email' && u.email) return 'email';
    return u.telegram_id ? 'telegram' : u.email ? 'email' : 'none';
  }

  function redirect(res, to, setCookies = []) { res.writeHead(302, { Location: to, 'Set-Cookie': setCookies, 'Cache-Control': 'no-store' }); res.end(); }
  const back = (ret, err) => cfg.site + (err ? '/vhod/?oshibka=' + encodeURIComponent(err) : safeReturn(ret));

  /* ----- Telegram: вызовы бота и вход через бота ----- */
  async function tgCall(method, body, timeoutMs = 15000) {
    const r = await fetchImpl(`${cfg.tgApi}/bot${cfg.tgToken}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || r.status}`);
    return j.result;
  }
  // Ожидающие входы живут в памяти 10 минут: код из ссылки → кто нажал «Запустить» и подтвердил ли вход кнопкой.
  // Подтверждение кнопкой — чтобы по чужой ссылке нельзя было незаметно войти в аккаунт человека.
  const tgLogins = new Map();
  let tgOffset = 0, tgPolling = false;
  const tgName = (f) => [f.first_name, f.last_name].filter(Boolean).join(' ') || f.username || '';
  function tgPrune() { for (const [k, v] of tgLogins) if (now() - v.created > TG_LOGIN_TTL) tgLogins.delete(k); }
  async function tgUpdate(up) {
    const msg = up.message;
    if (msg && msg.chat?.type === 'private' && typeof msg.text === 'string') {
      const m = /^\/start(?:\s+([\w-]{10,64}))?/.exec(msg.text);
      const L = m && m[1] && tgLogins.get(m[1]);
      if (!L || L.state === 'ok') {
        return tgCall('sendMessage', { chat_id: msg.chat.id, text: m && m[1]
          ? `Ссылка для входа устарела. Нажмите «Войти через Telegram» на сайте ${host} ещё раз.`
          : `Это бот сайта ${host}: через него входят в кабинет и получают уведомления об изменениях у компаний.` });
      }
      L.from = String(msg.from.id);
      return tgCall('sendMessage', {
        chat_id: msg.chat.id,
        text: `Вход на сайт ${host}.\n\nНажмите кнопку, если это вы сейчас входите на сайт. Если вы ничего не нажимали на сайте — просто закройте это сообщение.`,
        reply_markup: { inline_keyboard: [[{ text: `Войти на ${host}`, callback_data: 'login:' + m[1] }]] }
      });
    }
    const cb = up.callback_query;
    if (cb && String(cb.data || '').startsWith('login:')) {
      const L = tgLogins.get(cb.data.slice(6));
      const ok = !!(L && L.from === String(cb.from.id) && L.state !== 'ok');
      if (ok) { L.state = 'ok'; L.tg = { id: String(cb.from.id), name: tgName(cb.from) }; }
      await tgCall('answerCallbackQuery', { callback_query_id: cb.id, text: ok ? 'Готово' : 'Ссылка устарела, начните вход на сайте заново' }).catch(() => {});
      if (ok && cb.message) await tgCall('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: 'Вход подтверждён. Вернитесь на сайт — страница обновится сама.' }).catch(() => {});
    }
  }
  // Сообщения боту забираем, только пока кто-то входит: Render на бесплатном тарифе не будим зря
  async function tgPoll() {
    if (tgPolling || !cfg.tgToken) return;
    tgPolling = true;
    try {
      for (;;) {
        tgPrune();
        if (!tgLogins.size) break;
        const t0 = now();
        try {
          const ups = await tgCall('getUpdates', { offset: tgOffset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 45000);
          for (const up of ups) { tgOffset = up.update_id + 1; await tgUpdate(up).catch((e) => console.error('бот', e.message)); }
          if (!ups.length && now() - t0 < 1000) await sleep(1000);
        } catch (e) { console.error('бот', e.message); await sleep(3000); }
      }
    } finally { tgPolling = false; }
  }

  /* ----- уведомления ----- */
  async function notify(u, text) {
    const ch = channelOf(u);
    if (ch === 'telegram' && cfg.tgToken) {
      await tgCall('sendMessage', { chat_id: u.telegram_id, text, link_preview_options: { is_disabled: true } });
    } else if (ch === 'email' && mailer) {
      await mailer({ to: u.email, subject: 'Суть: изменения у компаний, за которыми вы следите', text });
    }
  }

  /* ----- ежедневная проверка компаний из слежения ----- */
  async function runWatch(getPartyFresh) {
    const inns = q('SELECT DISTINCT inn FROM watch').all().map((r) => r.inn);
    const changed = {};
    for (const inn of inns) {
      try {
        const s = await getPartyFresh(inn);
        if (!s) continue;
        const snap = snapshotOf(s);
        const prev = q('SELECT data FROM snapshots WHERE inn = ?').get(inn);
        const changes = diffSnapshots(prev ? JSON.parse(prev.data) : null, snap);
        q(`INSERT INTO snapshots (inn, data, checked_at, changed_at, last_change) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(inn) DO UPDATE SET data = excluded.data, checked_at = excluded.checked_at,
           changed_at = COALESCE(excluded.changed_at, snapshots.changed_at), last_change = COALESCE(excluded.last_change, snapshots.last_change)`)
          .run(inn, JSON.stringify(snap), now(), changes.length ? now() : null, changes.length ? changes.join('; ') : null);
        if (changes.length) changed[inn] = { name: snap.name, changes };
      } catch (e) { console.error('слежение', inn, e.message); }
    }
    // одно сообщение на пользователя со всеми изменениями
    const byUser = {};
    for (const [inn, c] of Object.entries(changed)) {
      for (const { user_id } of q('SELECT user_id FROM watch WHERE inn = ?').all(inn)) (byUser[user_id] ||= []).push(`• ${c.name} (ИНН ${inn}): ${c.changes.join('; ')}`);
    }
    let sent = 0;
    for (const [uid, lines] of Object.entries(byUser)) {
      const u = q('SELECT * FROM users WHERE id = ?').get(Number(uid));
      if (!u) continue;
      try {
        await notify(u, `Изменения у компаний, за которыми вы следите:\n\n${lines.join('\n')}\n\nПодробнее: ${cfg.site}/kabinet/`);
        sent++;
      } catch (e) { console.error('уведомление', uid, e.message); }
    }
    q("INSERT INTO meta (key, value) VALUES ('watch_last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(now()));
    return { checked: inns.length, changed: Object.keys(changed).length, sent };
  }

  // Слежение запускается раз в сутки после 08:00 по Москве
  function scheduleWatch(getPartyFresh) {
    const tick = async () => {
      const msk = new Date(now() + 3 * 3600e3);
      const today = msk.toISOString().slice(0, 10);
      const last = q("SELECT value FROM meta WHERE key = 'watch_day'").get();
      if (msk.getUTCHours() >= 8 && (!last || last.value !== today)) {
        q("INSERT INTO meta (key, value) VALUES ('watch_day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(today);
        const r = await runWatch(getPartyFresh);
        console.log(new Date().toISOString(), 'слежение:', JSON.stringify(r));
      }
    };
    return setInterval(() => tick().catch((e) => console.error('слежение', e.message)), 10 * 60e3);
  }

  function recordHistory(u, inn, name) {
    q('INSERT INTO history (user_id, inn, name, at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, inn) DO UPDATE SET name = excluded.name, at = excluded.at').run(u.id, inn, name || null, now());
    q('DELETE FROM history WHERE user_id = ? AND inn NOT IN (SELECT inn FROM history WHERE user_id = ? ORDER BY at DESC LIMIT ?)').run(u.id, u.id, LIMITS.history);
  }

  /* ----- маршруты ----- */
  const emailOk = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

  // Журнал входа (journalctl -u sut-api): только исход и внутренний номер пользователя — без имён, почты и ID Telegram/Яндекса
  const log = (...a) => console.log(new Date().toISOString(), 'вход:', ...a);
  const fail = (way, msg, detail) => (log(way, '—', msg + (detail ? ` (${detail})` : '')), back(null, msg));

  async function handle(req, res, url, { send, readBody, getParty, innValid, ip }) {
    const p = url.pathname;
    if (!p.startsWith('/auth/') && !['/api/me', '/api/history', '/api/watch', '/api/calcs'].includes(p)) return false;
    const m = req.method;

    // ---- вход через Яндекс ID ----
    if (m === 'GET' && p === '/auth/yandex') {
      if (!cfg.yandexId) return redirect(res, fail('Яндекс', 'Вход через Яндекс пока не подключён', 'нет YANDEX_CLIENT_ID')), true;
      if (url.searchParams.get('consent') !== '1') return redirect(res, fail('Яндекс', 'Нужно согласие на обработку данных')), true;
      const state = token();
      const ret = safeReturn(url.searchParams.get('return'));
      const to = 'https://oauth.yandex.ru/authorize?' + new URLSearchParams({ response_type: 'code', client_id: cfg.yandexId, redirect_uri: cfg.api + '/auth/yandex/callback', state });
      redirect(res, to, [cookie('sut_st', `${state}.${Buffer.from(ret).toString('base64url')}`, 600)]);
      return true;
    }
    if (m === 'GET' && p === '/auth/yandex/callback') {
      const [state, retB64] = String(cookies(req).sut_st || '').split('.');
      const ret = retB64 ? Buffer.from(retB64, 'base64url').toString() : null;
      const clear = cookie('sut_st', '', 0);
      if (!state || state !== url.searchParams.get('state')) return redirect(res, fail('Яндекс', 'Вход не удался, попробуйте ещё раз', 'state не совпал: истёк или другой браузер'), [clear]), true;
      const code = url.searchParams.get('code');
      if (!code) return redirect(res, fail('Яндекс', 'Вход отменён', url.searchParams.get('error') || 'нет code'), [clear]), true;
      const tr = await fetchImpl('https://oauth.yandex.ru/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: cfg.yandexId, client_secret: cfg.yandexSecret }), signal: AbortSignal.timeout(15000)
      });
      const tj = await tr.json().catch(() => ({}));
      if (!tj.access_token) return redirect(res, fail('Яндекс', 'Яндекс не подтвердил вход', `HTTP ${tr.status} ${tj.error || ''}`.trim()), [clear]), true;
      const ir = await fetchImpl('https://login.yandex.ru/info?format=json', { headers: { Authorization: 'OAuth ' + tj.access_token }, signal: AbortSignal.timeout(15000) });
      const info = await ir.json().catch(() => ({}));
      if (!info.id) return redirect(res, fail('Яндекс', 'Яндекс не передал данные профиля', `HTTP ${ir.status}`), [clear]), true;
      const email = info.default_email ? String(info.default_email).toLowerCase() : null;
      let u;
      try { u = findOrCreate({ field: 'yandex_id', id: String(info.id), email, name: info.real_name || info.display_name || '' }, userOf(req)); }
      catch { return redirect(res, fail('Яндекс', 'Этот Яндекс ID уже привязан к другому аккаунту'), [clear]), true; }
      log('Яндекс — успешно, пользователь #' + u.id);
      redirect(res, back(ret), [clear, startSession(u.id)]);
      return true;
    }

    // ---- вход через бота Telegram: не нужен ни номер телефона, ни сайт telegram.org ----
    if (m === 'POST' && p === '/auth/telegram/start') {
      const body = await readBody(req, 1024);
      if (!cfg.tgToken || !cfg.tgBot) return send(res, 503, { error: 'Вход через Telegram пока не подключён.' }), true;
      if (body.consent !== true) return send(res, 400, { error: 'Нужно согласие на обработку данных.' }), true;
      tgPrune();
      if (tgLogins.size > 2000) return send(res, 429, { error: 'Слишком много входов сразу. Попробуйте через минуту.' }), true;
      const nonce = crypto.randomBytes(16).toString('base64url'), secret = token();
      tgLogins.set(nonce, { created: now(), state: 'wait', browser: sha(secret) });
      tgPoll();
      res.setHeader('Set-Cookie', cookie('sut_tg', secret, TG_LOGIN_TTL / 1000));
      return send(res, 200, { nonce, url: `https://t.me/${cfg.tgBot}?start=${nonce}` }), true;
    }
    if (m === 'GET' && p === '/auth/telegram/status') {
      const nonce = String(url.searchParams.get('nonce') || '');
      tgPrune();
      const L = tgLogins.get(nonce);
      if (!L) return send(res, 200, { state: 'expired' }), true;
      // забрать вход может только тот браузер, который его начал
      if (L.browser !== sha(cookies(req).sut_tg || '')) return send(res, 403, { error: 'Начните вход заново на этой странице.' }), true;
      tgPoll();
      if (L.state !== 'ok') return send(res, 200, { state: 'wait' }), true;
      tgLogins.delete(nonce);
      let u;
      try { u = findOrCreate({ field: 'telegram_id', id: L.tg.id, email: null, name: L.tg.name }, userOf(req)); }
      catch { return send(res, 409, { state: 'error', error: 'Этот Telegram уже привязан к другому аккаунту.' }), true; }
      res.setHeader('Set-Cookie', [cookie('sut_tg', '', 0), startSession(u.id)]);
      return send(res, 200, { state: 'ok', user: publicUser(u) }), true;
    }

    // ---- вход через Telegram (виджет в режиме перехода по ссылке) ----
    if (m === 'GET' && p === '/auth/telegram/callback') {
      const params = Object.fromEntries(url.searchParams);
      if (params.consent !== '1') return redirect(res, fail('Telegram', 'Нужно согласие на обработку данных')), true;
      const tg = telegramCheck(params, cfg.tgToken, now());
      if (!tg) {
        const why = !cfg.tgToken ? 'нет TELEGRAM_BOT_TOKEN' : !params.hash ? 'Telegram не передал подпись' : now() / 1000 - Number(params.auth_date) > 86400 ? 'подпись старше суток' : 'подпись не сошлась: токен на сервере не от этого бота или устарел после /revoke';
        return redirect(res, fail('Telegram', 'Telegram не подтвердил вход', why)), true;
      }
      let u;
      try { u = findOrCreate({ field: 'telegram_id', id: tg.id, email: null, name: tg.name }, userOf(req)); }
      catch { return redirect(res, fail('Telegram', 'Этот Telegram уже привязан к другому аккаунту')), true; }
      log('Telegram — успешно, пользователь #' + u.id);
      redirect(res, back(params.return), [startSession(u.id)]);
      return true;
    }

    // Остальное — JSON-запросы с сайта (проверку Origin делает index.mjs)
    const body = ['POST', 'PATCH'].includes(m) ? await readBody(req, 8192) : {};

    // ---- вход по коду на почту ----
    if (m === 'POST' && p === '/auth/email/start') {
      if (!cfg.mailOn) return send(res, 503, { error: 'Вход по почте пока не подключён.' }), true;
      const email = String(body.email || '').trim().toLowerCase();
      if (!emailOk(email)) return send(res, 400, { error: 'Проверьте адрес почты.' }), true;
      const row = q('SELECT * FROM email_codes WHERE email = ?').get(email);
      if (row && now() - row.sent_at < 60e3) return send(res, 429, { error: 'Код уже отправлен. Повторно можно через минуту.' }), true;
      if (row && row.sent_count >= 5 && now() - row.sent_at < 3600e3) return send(res, 429, { error: 'Слишком много попыток. Попробуйте через час.' }), true;
      const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
      const count = row && now() - row.sent_at < 3600e3 ? row.sent_count + 1 : 1;
      q(`INSERT INTO email_codes (email, code_hash, expires_at, attempts, sent_at, sent_count) VALUES (?, ?, ?, 0, ?, ?)
         ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at, sent_count = excluded.sent_count`)
        .run(email, sha(email + ':' + code), now() + 10 * 60e3, now(), count);
      try {
        await mailer({ to: email, subject: `Код для входа: ${code}`, text: `Ваш код для входа на ${host}: ${code}\n\nКод действует 10 минут. Если вы не запрашивали вход, просто проигнорируйте это письмо.\n\n— Суть` });
      } catch (e) {
        log('почта — письмо с кодом не отправлено:', e.message);
        return send(res, 502, { error: 'Не получилось отправить письмо. Попробуйте позже или войдите другим способом.' }), true;
      }
      log('почта — код отправлен');
      return send(res, 200, { ok: true }), true;
    }
    if (m === 'POST' && p === '/auth/email/verify') {
      const email = String(body.email || '').trim().toLowerCase();
      const code = String(body.code || '').replace(/\D/g, '');
      if (body.consent !== true) return send(res, 400, { error: 'Нужно согласие на обработку данных.' }), true;
      const row = q('SELECT * FROM email_codes WHERE email = ?').get(email);
      if (!row || row.expires_at < now()) return send(res, 400, { error: 'Код устарел. Запросите новый.' }), true;
      if (row.attempts >= 5) return send(res, 429, { error: 'Слишком много попыток. Запросите новый код.' }), true;
      if (sha(email + ':' + code) !== row.code_hash) {
        log('почта — неверный код');
        q('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?').run(email);
        return send(res, 400, { error: 'Неверный код.' }), true;
      }
      q('DELETE FROM email_codes WHERE email = ?').run(email);
      const u = findOrCreate({ field: 'email', id: email, email, name: '' });
      log('почта — успешно, пользователь #' + u.id);
      res.setHeader('Set-Cookie', startSession(u.id));
      return send(res, 200, { user: publicUser(u) }), true;
    }
    if (m === 'POST' && p === '/auth/logout') {
      const t = cookies(req).sut_s;
      if (t) q('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
      res.setHeader('Set-Cookie', cookie('sut_s', '', 0));
      return send(res, 200, { ok: true }), true;
    }
    if (p.startsWith('/auth/')) return send(res, 404, { error: 'Не найдено' }), true;

    // ---- кабинет: только для вошедших ----
    const u = userOf(req);
    if (p === '/api/me' && m === 'GET') return send(res, 200, { user: u ? publicUser(u) : null, methods: { yandex: !!cfg.yandexId, telegram: cfg.tgBot || null, email: cfg.mailOn } }), true;
    if (!u) return send(res, 401, { error: 'Войдите, чтобы пользоваться кабинетом.' }), true;

    if (p === '/api/me' && m === 'PATCH') {
      if ('company_inn' in body) {
        const inn = body.company_inn ? String(body.company_inn).replace(/\s/g, '') : null;
        if (inn && !innValid(inn)) return send(res, 400, { error: 'Проверьте ИНН.' }), true;
        q('UPDATE users SET company_inn = ? WHERE id = ?').run(inn, u.id);
      }
      if ('notify' in body) {
        if (!['auto', 'telegram', 'email', 'none'].includes(body.notify)) return send(res, 400, { error: 'Неизвестный способ уведомлений.' }), true;
        q('UPDATE users SET notify = ? WHERE id = ?').run(body.notify, u.id);
      }
      return send(res, 200, { user: publicUser(q('SELECT * FROM users WHERE id = ?').get(u.id)) }), true;
    }
    if (p === '/api/me' && m === 'DELETE') {
      q('DELETE FROM users WHERE id = ?').run(u.id);          // сессии, история, слежение и расчёты удалятся каскадом
      res.setHeader('Set-Cookie', cookie('sut_s', '', 0));
      return send(res, 200, { ok: true }), true;
    }

    if (p === '/api/history') {
      if (m === 'GET') return send(res, 200, { items: q('SELECT inn, name, at FROM history WHERE user_id = ? ORDER BY at DESC').all(u.id) }), true;
      if (m === 'DELETE') { q('DELETE FROM history WHERE user_id = ?').run(u.id); return send(res, 200, { ok: true }), true; }
    }

    if (p === '/api/watch') {
      if (m === 'GET') {
        const items = q(`SELECT w.inn, w.name, w.added_at, s.checked_at, s.changed_at, s.last_change, s.data
                         FROM watch w LEFT JOIN snapshots s ON s.inn = w.inn WHERE w.user_id = ? ORDER BY w.added_at DESC`).all(u.id)
          .map((r) => ({ inn: r.inn, name: r.name, added_at: r.added_at, checked_at: r.checked_at, changed_at: r.changed_at, last_change: r.last_change, status: r.data ? JSON.parse(r.data).status : null }));
        return send(res, 200, { items }), true;
      }
      if (m === 'POST') {
        const inn = String(body.inn || '').replace(/\s/g, '');
        if (!innValid(inn)) return send(res, 400, { error: 'Проверьте ИНН.' }), true;
        const n = q('SELECT COUNT(*) AS n FROM watch WHERE user_id = ?').get(u.id).n;
        if (n >= LIMITS.watch) return send(res, 400, { error: `Можно следить не больше чем за ${LIMITS.watch} компаниями.` }), true;
        const s = await getParty(inn);
        if (!s) return send(res, 404, { error: 'По этому ИНН ничего не найдено.' }), true;
        const snap = snapshotOf(s);
        q('INSERT INTO watch (user_id, inn, name, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, inn) DO NOTHING').run(u.id, inn, snap.name, now());
        q('INSERT INTO snapshots (inn, data, checked_at) VALUES (?, ?, ?) ON CONFLICT(inn) DO NOTHING').run(inn, JSON.stringify(snap), now());
        return send(res, 200, { ok: true, name: snap.name }), true;
      }
      if (m === 'DELETE') { q('DELETE FROM watch WHERE user_id = ? AND inn = ?').run(u.id, String(url.searchParams.get('inn') || '')); return send(res, 200, { ok: true }), true; }
    }

    if (p === '/api/calcs') {
      if (m === 'GET') return send(res, 200, { items: q('SELECT id, calc, title, link, saved_at FROM calcs WHERE user_id = ? ORDER BY saved_at DESC').all(u.id) }), true;
      if (m === 'POST') {
        const calc = String(body.calc || ''), title = String(body.title || '').slice(0, 120), link = String(body.link || '');
        if (!/^[a-zA-Z]{2,20}$/.test(calc) || !title || !link.startsWith(cfg.site + '/') || link.length > 1000) return send(res, 400, { error: 'Некорректный расчёт.' }), true;
        const n = q('SELECT COUNT(*) AS n FROM calcs WHERE user_id = ?').get(u.id).n;
        if (n >= LIMITS.calcs) return send(res, 400, { error: `Можно сохранить не больше ${LIMITS.calcs} расчётов.` }), true;
        q('INSERT INTO calcs (user_id, calc, title, link, saved_at) VALUES (?, ?, ?, ?, ?)').run(u.id, calc, title, link, now());
        return send(res, 200, { ok: true }), true;
      }
      if (m === 'DELETE') { q('DELETE FROM calcs WHERE user_id = ? AND id = ?').run(u.id, Number(url.searchParams.get('id'))); return send(res, 200, { ok: true }), true; }
    }
    send(res, 405, { error: 'Метод не поддерживается' });
    return true;
  }

  return { handle, userOf, recordHistory, runWatch, scheduleWatch, cfg };
}

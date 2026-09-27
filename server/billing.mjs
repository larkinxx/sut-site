// Подписка ИННсайдер Про: оплата через ЮKassa. Продавец — ИП на УСН: кассовые чеки (54-ФЗ) передаём в ЮKassa
// вместе с платежом (YOOKASSA_RECEIPT=1), чек уходит на почту покупателя. Для самозанятого чеки не нужны — ЮKassa
// сама отправляет их в «Мой налог», тогда YOOKASSA_RECEIPT не задаётся.
// Включается, когда заданы YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY; без них всё бесплатно, как раньше.
//
// Что даёт Про: проверки судов, арбитража и приставов без дневного лимита, слежение до 50 компаний, отчёт в PDF.
// Бесплатно: FREE.courts новых проверок судов в день (уже загруженные кем-то — всегда бесплатно), слежение за FREE.watch компаниями.
//
// Маршруты:
//   GET  /api/billing                 — тарифы и состояние подписки вошедшего
//   POST /api/billing/pay {plan, autorenew} — создать платёж, ответ {url} — страница оплаты ЮKassa
//   POST /api/billing/check {id}      — сверить платёж после возврата с оплаты (если уведомление ещё не пришло)
//   POST /api/billing/autorenew {on:false} — отключить автопродление
//   POST /billing/yookassa            — уведомления ЮKassa. Телу не верим: статус платежа перезапрашиваем у ЮKassa по id
import crypto from 'node:crypto';

const DAY = 864e5;
export const PLANS = {
  month: { price: 290, days: 30, title: 'месяц', desc: 'Подписка ИННсайдер Про на 1 месяц' },
  year: { price: 2490, days: 365, title: 'год', desc: 'Подписка ИННсайдер Про на 1 год' }
};
export const FREE = { courts: 3, watch: 3 };
const PRO_WATCH = 50;
const API = 'https://api.yookassa.ru/v3';

export function createBilling({ env, db, fetchImpl, now = () => Date.now(), notify = async () => {} }) {
  const cfg = {
    shopId: env.YOOKASSA_SHOP_ID || '', secret: env.YOOKASSA_SECRET_KEY || '',
    // автоплатежи ЮKassa включает отдельно по заявке — до этого продаём разовые периоды
    recurring: env.YOOKASSA_RECURRING === '1',
    // чеки: система налогообложения по справочнику ЮKassa — 2 УСН «доходы», 3 УСН «доходы минус расходы»
    receipt: env.YOOKASSA_RECEIPT === '1', taxSystem: Number(env.YOOKASSA_TAX_SYSTEM || 2),
    site: (env.SITE_URL || 'https://inn-saider.ru').replace(/\/$/, ''),
    freeCourts: Number(env.FREE_COURTS_PER_DAY || FREE.courts)
  };
  const enabled = !!(cfg.shopId && cfg.secret);
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT NOT NULL, paid_until INTEGER NOT NULL, method_id TEXT, autorenew INTEGER NOT NULL DEFAULT 0,
      renew_tries INTEGER NOT NULL DEFAULT 0, renew_at INTEGER, noticed_until INTEGER
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, plan TEXT NOT NULL, amount INTEGER NOT NULL,
      status TEXT NOT NULL, recurring INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, paid_at INTEGER, email TEXT
    );
  `);
  try { db.exec('ALTER TABLE payments ADD COLUMN email TEXT'); } catch {}   // база, созданная до появления чеков
  // при удалении аккаунта платёж остаётся для учёта, но почта из него стирается
  db.exec('CREATE TRIGGER IF NOT EXISTS payments_forget BEFORE DELETE ON users BEGIN UPDATE payments SET email = NULL WHERE user_id = OLD.id; END');
  const q = (sql) => db.prepare(sql);
  const log = (...a) => console.log(new Date().toISOString(), 'оплата:', ...a);

  function ykCall(method, path, body) {
    return fetchImpl(API + path, {
      method,
      headers: {
        Authorization: 'Basic ' + Buffer.from(cfg.shopId + ':' + cfg.secret).toString('base64'),
        'Content-Type': 'application/json',
        ...(method === 'POST' ? { 'Idempotence-Key': crypto.randomUUID() } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000)
    }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`ЮKassa ${r.status}: ${j.description || j.code || ''}`);
      return j;
    });
  }

  const subOf = (u) => (u ? q('SELECT * FROM subscriptions WHERE user_id = ?').get(u.id) : null);
  const isPro = (u) => { const s = subOf(u); return !!(s && s.paid_until > now()); };
  const watchLimit = (u) => (!enabled || isPro(u) ? PRO_WATCH : FREE.watch);

  // Бесплатные проверки судов: считаем разные ИНН за сутки по Москве — на человека (вошедшего) или на адрес
  const freeUsed = new Map();
  function allowCourts(u, ip, inn) {
    if (!enabled || isPro(u)) return true;
    const day = new Date(now() + 3 * 3600e3).toISOString().slice(0, 10);
    const key = (u ? 'u' + u.id : 'ip' + ip) + ':' + day;
    const set = freeUsed.get(key) || new Set();
    if (set.has(inn)) return true;
    if (set.size >= cfg.freeCourts) return false;
    set.add(inn); freeUsed.set(key, set);
    if (freeUsed.size > 50000) freeUsed.clear();
    return true;
  }

  // Зачесть оплаченный платёж. Повторный вызов с тем же платежом ничего не делает
  function apply(p) {
    const row = q('SELECT * FROM payments WHERE id = ?').get(p.id);
    if (!row || row.status === 'succeeded') return false;
    if (p.status !== 'succeeded') {
      if (p.status === 'canceled') q("UPDATE payments SET status = 'canceled' WHERE id = ?").run(p.id);
      return false;
    }
    const plan = PLANS[row.plan];
    if (!plan || Number(p.amount?.value) !== row.amount || p.amount?.currency !== 'RUB') { log('сумма не совпала, платёж', p.id); return false; }
    q("UPDATE payments SET status = 'succeeded', paid_at = ? WHERE id = ?").run(now(), p.id);
    if (!row.user_id) return true;                      // аккаунт удалили, пока шла оплата
    const s = q('SELECT * FROM subscriptions WHERE user_id = ?').get(row.user_id);
    const until = Math.max(now(), s ? s.paid_until : 0) + plan.days * DAY;
    const saved = cfg.recurring && p.payment_method?.saved ? p.payment_method.id : null;
    const method = saved || (row.recurring ? s?.method_id : null);
    q(`INSERT INTO subscriptions (user_id, plan, paid_until, method_id, autorenew, renew_tries) VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, paid_until = excluded.paid_until,
       method_id = COALESCE(excluded.method_id, subscriptions.method_id), autorenew = MAX(excluded.autorenew, subscriptions.autorenew), renew_tries = 0`)
      .run(row.user_id, row.plan, until, method, method ? 1 : 0);
    log('оплачено, пользователь', row.user_id, row.plan);
    return true;
  }

  // Кассовый чек: одна позиция — услуга, без НДС (УСН), полный расчёт
  const receiptOf = (plan, email) => (cfg.receipt && email ? {
    receipt: {
      customer: { email }, tax_system_code: cfg.taxSystem,
      items: [{ description: plan.desc, quantity: '1.00', amount: { value: plan.price.toFixed(2), currency: 'RUB' }, vat_code: 1, payment_subject: 'service', payment_mode: 'full_payment' }]
    }
  } : {});
  // почта для чека: введённая при оплате, из аккаунта или из прошлой оплаты (вход через Telegram почты не даёт)
  const emailOk = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim());
  const lastEmail = (uid) => q('SELECT email FROM payments WHERE user_id = ? AND email IS NOT NULL ORDER BY created_at DESC LIMIT 1').get(uid)?.email || null;
  const emailOf = (u, typed) => (emailOk(typed) ? typed.trim().toLowerCase() : null) || u?.email || (u ? lastEmail(u.id) : null);

  async function createPayment(u, planKey, autorenew, email) {
    const plan = PLANS[planKey];
    const save = cfg.recurring && !!autorenew;
    const p = await ykCall('POST', '/payments', {
      amount: { value: plan.price.toFixed(2), currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: cfg.site + '/kabinet/?oplata=1' },
      description: plan.desc,
      metadata: { user_id: String(u.id), plan: planKey },
      ...(save ? { save_payment_method: true } : {}),
      ...receiptOf(plan, email)
    });
    q("INSERT INTO payments (id, user_id, plan, amount, status, created_at, email) VALUES (?, ?, ?, ?, 'pending', ?, ?)").run(p.id, u.id, planKey, plan.price, now(), email || null);   // статус — только из apply()
    return p;
  }

  /* ----- автопродление: раз в час; за 3 дня предупреждаем, в последние сутки списываем ----- */
  async function runRenew() {
    if (!enabled || !cfg.recurring) return { charged: 0 };
    const t = now();
    for (const s of q('SELECT * FROM subscriptions WHERE autorenew = 1 AND method_id IS NOT NULL AND paid_until BETWEEN ? AND ? AND (noticed_until IS NULL OR noticed_until != paid_until)').all(t, t + 3 * DAY)) {
      const u = q('SELECT * FROM users WHERE id = ?').get(s.user_id);
      const plan = PLANS[s.plan];
      q('UPDATE subscriptions SET noticed_until = paid_until WHERE user_id = ?').run(s.user_id);
      if (u) await notify(u, `Подписка ИННсайдер Про заканчивается ${new Date(s.paid_until).toLocaleDateString('ru-RU')}. Мы продлим её автоматически и спишем ${plan.price} ₽ с сохранённой карты. Отключить автопродление: ${cfg.site}/kabinet/`).catch((e) => log('предупреждение', e.message));
    }
    let charged = 0;
    for (const s of q('SELECT * FROM subscriptions WHERE autorenew = 1 AND method_id IS NOT NULL AND paid_until < ? AND renew_tries < 3 AND (renew_at IS NULL OR renew_at < ?)').all(t + DAY, t - 12 * 3600e3)) {
      const plan = PLANS[s.plan];
      const email = emailOf(q('SELECT * FROM users WHERE id = ?').get(s.user_id), null);
      q('UPDATE subscriptions SET renew_at = ?, renew_tries = renew_tries + 1 WHERE user_id = ?').run(t, s.user_id);
      try {
        const p = await ykCall('POST', '/payments', {
          amount: { value: plan.price.toFixed(2), currency: 'RUB' }, capture: true, payment_method_id: s.method_id,
          description: plan.desc + ' (автопродление)', metadata: { user_id: String(s.user_id), plan: s.plan },
          ...receiptOf(plan, email)
        });
        q("INSERT INTO payments (id, user_id, plan, amount, status, recurring, created_at, email) VALUES (?, ?, ?, ?, 'pending', 1, ?, ?)").run(p.id, s.user_id, s.plan, plan.price, t, email);
        if (apply(p)) charged++;
      } catch (e) { log('автопродление, пользователь', s.user_id, e.message); }
      if (s.renew_tries + 1 >= 3 && !isPro({ id: s.user_id })) {
        q('UPDATE subscriptions SET autorenew = 0 WHERE user_id = ?').run(s.user_id);
        const u = q('SELECT * FROM users WHERE id = ?').get(s.user_id);
        if (u) await notify(u, `Не получилось продлить подписку ИННсайдер Про: платёж по карте не прошёл. Оформить заново: ${cfg.site}/tarify/`).catch(() => {});
      }
    }
    return { charged };
  }
  function scheduleRenew() {
    return setInterval(() => runRenew().catch((e) => log('автопродление', e.message)), 3600e3);
  }

  const state = (u) => {
    const s = subOf(u);
    return {
      enabled, recurring: cfg.recurring, freeCourts: cfg.freeCourts, freeWatch: FREE.watch,
      plans: Object.fromEntries(Object.entries(PLANS).map(([k, p]) => [k, { price: p.price, title: p.title }])),
      pro: isPro(u), plan: s?.plan || null, paid_until: s && s.paid_until > now() ? s.paid_until : null,
      autorenew: !!(s && s.autorenew && s.method_id),
      // почту для чека спрашиваем только у тех, чьей почты у нас нет
      needEmail: cfg.receipt && !emailOf(u, null)
    };
  };

  async function handle(req, res, url, { send, readBody, user }) {
    const p = url.pathname, m = req.method;
    if (p === '/billing/yookassa' && m === 'POST') {
      const body = await readBody(req, 16384).catch(() => ({}));
      const id = body?.object?.id;
      if (enabled && typeof id === 'string' && /^[\w-]{10,60}$/.test(id) && q('SELECT 1 FROM payments WHERE id = ?').get(id)) {
        try { apply(await ykCall('GET', '/payments/' + id)); } catch (e) { log('уведомление', e.message); return send(res, 500, { ok: false }), true; }
      }
      return send(res, 200, { ok: true }), true;       // ЮKassa повторяет уведомление, пока не получит 200
    }
    if (!p.startsWith('/api/billing')) return false;
    if (p === '/api/billing' && m === 'GET') return send(res, 200, state(user)), true;
    if (!user) return send(res, 401, { error: 'Войдите, чтобы оформить подписку.' }), true;
    const body = await readBody(req);
    if (p === '/api/billing/pay' && m === 'POST') {
      if (!enabled) return send(res, 503, { error: 'Оплата пока не подключена.' }), true;
      if (!PLANS[body.plan]) return send(res, 400, { error: 'Неизвестный тариф.' }), true;
      const email = emailOf(user, body.email);
      if (cfg.receipt && !email) return send(res, 400, { error: 'Укажите почту: на неё придёт кассовый чек.', needEmail: true }), true;
      const pay = await createPayment(user, body.plan, body.autorenew, email);
      return send(res, 200, { url: pay.confirmation?.confirmation_url, id: pay.id }), true;
    }
    if (p === '/api/billing/check' && m === 'POST') {
      // последний платёж человека, если id не передан (возврат с оплаты без параметров)
      const row = typeof body.id === 'string' ? q('SELECT * FROM payments WHERE id = ? AND user_id = ?').get(body.id, user.id)
        : q('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(user.id);
      if (!row) return send(res, 404, { error: 'Платёж не найден.' }), true;
      if (enabled && row.status !== 'succeeded' && row.status !== 'canceled') apply(await ykCall('GET', '/payments/' + row.id));
      const st = q('SELECT status FROM payments WHERE id = ?').get(row.id).status;
      return send(res, 200, { payment: st, ...state(user) }), true;
    }
    if (p === '/api/billing/autorenew' && m === 'POST') {
      if (body.on) return send(res, 400, { error: 'Включить автопродление можно при следующей оплате.' }), true;
      q('UPDATE subscriptions SET autorenew = 0, method_id = NULL WHERE user_id = ?').run(user.id);
      return send(res, 200, state(user)), true;
    }
    return send(res, 405, { error: 'Метод не поддерживается' }), true;
  }

  return { enabled, isPro, watchLimit, allowCourts, handle, runRenew, scheduleRenew, state, apply };
}

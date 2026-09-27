// Панель владельца: GET /api/admin/stats — сводка для страницы /admin/ на сайте.
// Доступ только по ключу ADMIN_TOKEN из /etc/sut/api.env (заголовок Authorization: Bearer …, не короче 24 символов);
// без ключа маршрута нет (404). Неверный ключ — не больше 10 попыток за 15 минут с адреса.
// Счётчики использования — по дням и только числа (usage_daily): ни ИНН, ни адресов, ни пользователей.
import crypto from 'node:crypto';

const DAY = 864e5;
const METRICS = ['checks', 'ai', 'courts', 'market', 'lawyer'];   // проверки по ИНН, разборы, суды/арбитраж, запросы статистики отрасли, вопросы помощнику юриста

export function createAdmin({ env = {}, db = null, fdb = null, dn = null, now = () => Date.now() } = {}) {
  const token = String(env.ADMIN_TOKEN || '');
  const enabled = token.length >= 24;
  const want = crypto.createHash('sha256').update(token).digest();
  const fails = new Map();
  const mem = new Map();                                  // без базы аккаунтов — счётчики в памяти до перезапуска
  if (db) db.exec('CREATE TABLE IF NOT EXISTS usage_daily (day TEXT NOT NULL, metric TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, metric))');
  const inc = db && db.prepare('INSERT INTO usage_daily (day, metric, n) VALUES (?, ?, 1) ON CONFLICT(day, metric) DO UPDATE SET n = n + 1');
  const today = () => new Date(now() + 3 * 3600e3).toISOString().slice(0, 10);   // сутки по Москве

  function count(metric) {
    if (!METRICS.includes(metric)) return;
    try {
      if (inc) inc.run(today(), metric);
      else { const k = today() + '|' + metric; mem.set(k, (mem.get(k) || 0) + 1); }
    } catch (e) { console.error('usage_daily:', e.message); }
  }

  function authorized(req, ip) {
    const t = now(), f = (fails.get(ip) || []).filter((x) => t - x < 15 * 60e3);
    if (f.length >= 10) return 'limited';
    const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
    const got = crypto.createHash('sha256').update(m ? m[1] : '').digest();
    if (m && crypto.timingSafeEqual(got, want)) return 'ok';
    f.push(t); fails.set(ip, f);
    if (fails.size > 10000) fails.clear();
    return 'denied';
  }

  const q = (sql, ...args) => { try { return db.prepare(sql).get(...args) || {}; } catch { return {}; } };
  const qa = (sql, ...args) => { try { return db.prepare(sql).all(...args); } catch { return []; } };

  function stats() {
    const t = now(), days = [];
    for (let i = 29; i >= 0; i--) days.push(new Date(t + 3 * 3600e3 - i * DAY).toISOString().slice(0, 10));
    const usage = days.map((d) => {
      const row = { day: d };
      for (const m of METRICS) row[m] = 0;
      return row;
    });
    const byDay = new Map(usage.map((r) => [r.day, r]));
    if (db) {
      for (const r of qa('SELECT day, metric, n FROM usage_daily WHERE day >= ?', days[0])) {
        if (byDay.has(r.day) && METRICS.includes(r.metric)) byDay.get(r.day)[r.metric] = r.n;
      }
    } else {
      for (const [k, n] of mem) { const [d, m] = k.split('|'); if (byDay.has(d)) byDay.get(d)[m] = n; }
    }
    const out = { generatedAt: new Date(t).toISOString(), usage };
    if (db) {
      out.users = {
        total: q('SELECT count(*) AS n FROM users').n || 0,
        new7: q('SELECT count(*) AS n FROM users WHERE created_at >= ?', t - 7 * DAY).n || 0,
        active7: q('SELECT count(*) AS n FROM users WHERE last_seen >= ?', t - 7 * DAY).n || 0
      };
      out.subscriptions = {
        active: q('SELECT count(*) AS n FROM subscriptions WHERE paid_until > ?', t).n || 0,
        byPlan: Object.fromEntries(qa('SELECT plan, count(*) AS n FROM subscriptions WHERE paid_until > ? GROUP BY plan', t).map((r) => [r.plan, r.n])),
        autorenew: q('SELECT count(*) AS n FROM subscriptions WHERE paid_until > ? AND autorenew = 1', t).n || 0
      };
      const p = q("SELECT count(*) AS n, coalesce(sum(amount), 0) AS sum FROM payments WHERE status = 'succeeded' AND paid_at >= ?", t - 30 * DAY);
      out.payments30 = { count: p.n || 0, sum: p.sum || 0 };
      out.watching = q('SELECT count(*) AS n FROM watch').n || 0;
    }
    if (dn) out.datanewton = { usedToday: dn.used() };
    if (fdb) {
      const f = (sql) => { try { return fdb.prepare(sql).get() || {}; } catch { return {}; } };
      let sets = [];
      try { sets = fdb.prepare('SELECT dataset, rows, loaded_at FROM fns_meta ORDER BY dataset').all().map((r) => ({ dataset: r.dataset, rows: r.rows, loadedAt: r.loaded_at })); } catch {}
      out.fns = { datasets: sets, peerGroups: f('SELECT count(*) AS n FROM fns_peers').n || 0 };
    }
    out.server = { uptimeHours: Math.round(process.uptime() / 360) / 10, memoryMb: Math.round(process.memoryUsage().rss / 1e6), node: process.version };
    return out;
  }

  // true — запрос обработан здесь
  function handle(req, res, url, { send, ipOf }) {
    if (url.pathname !== '/api/admin/stats') return false;
    if (!enabled || req.method !== 'GET') { send(res, 404, { error: 'Не найдено' }); return true; }
    const a = authorized(req, ipOf(req));
    if (a === 'limited') send(res, 429, { error: 'Слишком много попыток. Подождите 15 минут.' });
    else if (a === 'denied') send(res, 401, { error: 'Неверный ключ.' });
    else send(res, 200, stats());
    return true;
  }

  return { count, handle, stats };
}

// Хранилище ответов DataNewton и учёт расхода лимита.
// Ответы живут неделю (суды и учредители за неделю почти не меняются) и лежат на диске — переживают перезапуск сервера.
// Дневной лимит считается в единицах DataNewton: карточка — 1, суды + арбитраж + приставы — 3 (у ИП — 2).
import { DatabaseSync } from 'node:sqlite';

export function createDnStore(file, { ttlDays = 7, dailyUnits = 100, now = () => Date.now() } = {}) {
  let db = null;
  const mem = new Map();
  let day = { key: '', used: 0 };
  if (file) {
    try {
      db = new DatabaseSync(file);
      db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS dn_cache (key TEXT PRIMARY KEY, data TEXT, at INT); CREATE TABLE IF NOT EXISTS dn_usage (day TEXT PRIMARY KEY, units INT)');
    } catch (e) { console.error('DataNewton, кеш:', e.message); db = null; }
  }
  const ttl = ttlDays * 864e5;
  const today = () => new Date(now() + 3 * 3600e3).toISOString().slice(0, 10);   // сутки по Москве
  return {
    get(key) {
      if (db) {
        const r = db.prepare('SELECT data, at FROM dn_cache WHERE key = ?').get(key);
        return r && now() - r.at < ttl ? JSON.parse(r.data) : undefined;
      }
      const r = mem.get(key);
      return r && now() - r.at < ttl ? r.data : undefined;
    },
    set(key, data) {
      if (db) db.prepare('INSERT OR REPLACE INTO dn_cache (key, data, at) VALUES (?, ?, ?)').run(key, JSON.stringify(data), now());
      else {
        if (mem.size >= 5000) mem.delete(mem.keys().next().value);
        mem.set(key, { data, at: now() });
      }
    },
    used() {
      if (db) return db.prepare('SELECT units FROM dn_usage WHERE day = ?').get(today())?.units || 0;
      return day.key === today() ? day.used : 0;
    },
    // списать единицы, если дневной лимит позволяет
    take(units) {
      if (this.used() + units > dailyUnits) return false;
      if (db) db.prepare('INSERT INTO dn_usage (day, units) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET units = units + excluded.units').run(today(), units);
      else { if (day.key !== today()) day = { key: today(), used: 0 }; day.used += units; }
      return true;
    },
    prune() { if (db) db.prepare('DELETE FROM dn_cache WHERE at < ?').run(now() - ttl); }
  };
}

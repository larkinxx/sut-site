// Перспективы бизнеса по статистике похожих компаний (таблицы fns_peers и fns_market из scripts/fns-peers.mjs).
//   marketStats — отрасль (ОКВЭД) + регион: выручка и прибыль по годам жизни компании, доля прибыльных, конкуренция.
//   orgPeers    — конкретная организация против похожих: какой процент компаний её отрасли, региона и возраста она обгоняет.
// Это статистика прошлого года, а не обещание дохода: в ответе — диапазоны и доля убыточных, без «вы заработаете».
import { AGE_GROUPS, ALL_AGES, RUSSIA, QUANTILES } from '../scripts/fns-peers.mjs';

// подготовленные запросы — один раз на базу, а не на каждый запрос к API
const stmts = new WeakMap();
const st = (db, sql) => { let m = stmts.get(db); if (!m) stmts.set(db, (m = new Map())); if (!m.has(sql)) m.set(sql, db.prepare(sql)); return m.get(sql); };

export const MIN_GROUP = 20;   // меньше компаний с отчётностью в группе — берём ту же отрасль по всей России
const AGE_LABEL = { 0: 'первый год', 1: 'второй год', 2: 'третий год', 3: '4–5-й год', 5: 'старше 5 лет' };

export const okvedOf = (s) => (String(s || '').match(/^\s*(\d{2})/) || [])[1] || null;
export const regionOf = (s) => (/^\d{2}$/.test(String(s || '').trim()) ? String(s).trim() : RUSSIA);

const parse = (r) => r && {
  companies: r.n, withReports: r.nfin, profitableShare: r.profitable, marginMedian: r.margin, year: r.year,
  income: r.income && JSON.parse(r.income), profit: r.profit && JSON.parse(r.profit)
};

// Группа с запасным вариантом: регион → вся Россия, если в регионе мало компаний с отчётностью
function group(db, okved, region, age) {
  const q = st(db, 'SELECT * FROM fns_peers WHERE okved = ? AND region = ? AND age = ?');
  const local = region !== RUSSIA ? q.get(okved, region, age) : null;
  if (local && local.nfin >= MIN_GROUP) return { ...parse(local), scope: 'region' };
  const all = q.get(okved, RUSSIA, age);
  return all && all.nfin >= MIN_GROUP ? { ...parse(all), scope: 'russia' } : null;
}

export function marketStats(db, { okved, region }) {
  const ok = okvedOf(okved), rg = regionOf(region);
  if (!db || !ok) return null;
  let total;
  try { total = group(db, ok, rg, ALL_AGES); } catch { return null; }   // таблиц ещё нет — статистику не считали
  if (!total) return null;
  const byAge = AGE_GROUPS.map((age) => ({ age, label: AGE_LABEL[age], ...group(db, ok, rg, age) })).filter((x) => x.scope);
  const count = (reg, age) => st(db, 'SELECT n FROM fns_peers WHERE okved = ? AND region = ? AND age = ?').get(ok, reg, age)?.n || 0;
  const n = count(rg, ALL_AGES);
  const history = st(db, 'SELECT month, n FROM fns_market WHERE okved = ? AND region = ? ORDER BY month').all(ok, rg).map(({ month, n }) => ({ month, n }));
  return {
    okved: ok, region: rg, quantiles: QUANTILES, total, byAge,
    // конкуренция: сколько организаций этой отрасли в регионе, доля новых (первый год) и как менялось число по месяцам
    competition: { companies: n, newShare: n ? Math.round((count(rg, 0) / n) * 1000) / 1000 : null, history }
  };
}

// Место значения среди квантилей группы, в процентах (сколько компаний группы меньше): 5 точек → линейно между ними
export function percentile(value, qs) {
  if (value == null || !qs) return null;
  const ps = QUANTILES.map((q) => q * 100);
  if (value <= qs[0]) return value < qs[0] ? Math.max(1, Math.round(ps[0] / 2)) : ps[0];
  if (value >= qs[qs.length - 1]) return value > qs[qs.length - 1] ? Math.min(99, Math.round((ps[ps.length - 1] + 100) / 2)) : ps[ps.length - 1];
  for (let i = 1; i < qs.length; i++) {
    if (value <= qs[i]) {
      const w = qs[i] === qs[i - 1] ? 0 : (value - qs[i - 1]) / (qs[i] - qs[i - 1]);
      return Math.round(ps[i - 1] + w * (ps[i] - ps[i - 1]));
    }
  }
  return null;
}

export function orgPeers(db, inn) {
  if (!db) return null;
  let m, f;
  try {
    m = st(db, 'SELECT * FROM fns_msp WHERE inn = ?').get(inn);
    f = st(db, 'SELECT * FROM fns_finance WHERE inn = ?').get(inn);
  } catch { return null; }
  if (!m || !f || f.income == null || f.expense == null) return null;
  const ok = okvedOf(m.okved);
  const years = Math.floor((Date.parse(f.asof) - Date.parse(m.since)) / (365.25 * 864e5));
  if (!Number.isFinite(years)) return null;   // нет даты — возраст не знаем, сравнивать не с кем (buildPeers такие тоже пропускает)
  const age = years < 3 ? Math.max(years, 0) : years < 5 ? 3 : 5;
  let g;
  try { g = group(db, ok, m.region, age); } catch { return null; }
  if (!g) return null;
  const profit = Math.round((f.income - f.expense) * 100) / 100;
  return {
    okved: ok, region: m.region, age, ageLabel: AGE_LABEL[age], year: g.year, scope: g.scope,
    income: f.income, profit,
    incomePercentile: percentile(f.income, g.income), profitPercentile: percentile(profit, g.profit),
    peers: g
  };
}

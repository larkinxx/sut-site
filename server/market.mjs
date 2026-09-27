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

// Значение по месту в группе (обратное к percentile): pct 10–90 → линейно между квантилями; за краями — край
export function valueAt(pct, qs) {
  if (pct == null || !qs) return null;
  const ps = QUANTILES.map((q) => q * 100);
  if (pct <= ps[0]) return qs[0];
  if (pct >= ps[ps.length - 1]) return qs[qs.length - 1];
  for (let i = 1; i < ps.length; i++) {
    if (pct <= ps[i]) return Math.round(qs[i - 1] + (pct - ps[i - 1]) / (ps[i] - ps[i - 1]) * (qs[i] - qs[i - 1]));
  }
  return null;
}

const ageGroup = (years) => (years < 3 ? Math.max(years, 0) : years < 5 ? 3 : 5);

// Прогноз для действующей организации: если она сохранит своё место среди сверстников той же отрасли и региона,
// какими будут доходы и прибыль в следующие три года — у компаний на год, два и три старше. Диапазон — место ±15 процентилей.
// Это оценка по статистике прошлого года, а не обещание: рынок, цены и сама компания меняются.
export function orgForecast(db, inn) {
  const p = orgPeers(db, inn);
  if (!p) return null;
  let m;
  try { m = st(db, 'SELECT since FROM fns_msp WHERE inn = ?').get(inn); } catch { return null; }
  const years = Math.floor((Date.parse(p.year + '-12-31') - Date.parse(m.since)) / (365.25 * 864e5));
  const region = p.scope === 'region' ? p.region : RUSSIA;
  const steps = [];
  for (let k = 1; k <= 3; k++) {
    const a = ageGroup(years + k);
    let g;
    try { g = group(db, p.okved, region, a); } catch { g = null; }
    if (!g) continue;
    const band = (pct, qs) => (pct == null ? null : { low: valueAt(Math.max(pct - 15, 10), qs), mid: valueAt(pct, qs), high: valueAt(Math.min(pct + 15, 90), qs) });
    steps.push({ year: p.year + k, age: a, ageLabel: AGE_LABEL[a], income: band(p.incomePercentile, g.income), profit: band(p.profitPercentile, g.profit), profitableShare: g.profitableShare, peers: g.withReports });
  }
  return {
    okved: p.okved, region: p.region, scope: p.scope, year: p.year, ageNow: p.age, ageLabel: p.ageLabel,
    income: p.income, profit: p.profit, incomePercentile: p.incomePercentile, profitPercentile: p.profitPercentile,
    mature: p.age === 5,   // старше 5 лет: дальше возраст не меняет группу — прогноз показывает удержание места
    steps
  };
}

// Карточка для сравнения компаний (/sravnenie/) — только наша база ФНС: быстро, бесплатно, без лимитов DaData
export function compareFacts(db, inn) {
  if (!db) return null;
  const q = (t) => { try { return st(db, `SELECT * FROM ${t} WHERE inn = ?`).get(inn); } catch { return undefined; } };
  const name = q('fns_name'), msp = q('fns_msp'), fin = q('fns_finance'), rg = q('fns_regime'), sf = q('fns_staff'), tx = q('fns_tax'), dt = q('fns_debt');
  if (!name && !msp && !fin && !tx) return null;
  const regime = rg ? [['usn', 'УСН'], ['ausn', 'АУСН'], ['eshn', 'ЕСХН'], ['srp', 'СРП']].filter(([k]) => rg[k]).map(([, n]) => n) : [];
  const peers = orgPeers(db, inn);
  return {
    inn, name: name ? name.name : null, okved: msp ? okvedOf(msp.okved) : null, region: msp ? msp.region : null,
    since: msp ? msp.since : null, category: msp ? msp.category : null,
    regime: rg || tx ? (regime.length ? regime.join(', ') : 'общая система') : null,
    staff: sf ? sf.n : null, taxes: tx ? tx.total : null, debt: dt ? dt.total : (tx ? 0 : null),
    income: fin ? fin.income : null, expense: fin ? fin.expense : null, profit: fin ? Math.round((fin.income - fin.expense) * 100) / 100 : null,
    year: fin ? Number(String(fin.asof).slice(0, 4)) : null,
    incomePercentile: peers ? peers.incomePercentile : null, profitPercentile: peers ? peers.profitPercentile : null
  };
}

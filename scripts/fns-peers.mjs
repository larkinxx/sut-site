// Статистика похожих компаний из открытых данных ФНС (fns_msp + fns_finance → fns_peers, fns_market).
// Группа — две первые цифры основного ОКВЭД (отрасль), регион и возраст компании на конец отчётного года.
// Возраст считается от даты включения в реестр МСП: новые компании попадают туда в течение месяца после регистрации,
// а все, кто существовал до запуска реестра (август 2016), — с 10.08.2016, то есть оказываются в группе «5 лет и старше».
// Прибыль = доходы − расходы по бухотчётности (до налога, по данным ФНС). Только организации: по ИП ФНС отчётность не публикует.
// Запуск отдельно (без повторной загрузки наборов): node scripts/fns-peers.mjs /var/lib/sut/fns.db
import { DatabaseSync } from 'node:sqlite';

export const AGE_GROUPS = [0, 1, 2, 3, 5];           // 0 — первый год, 1, 2, 3 — «3–4 года», 5 — «5 лет и старше»
export const ALL_AGES = -1;
export const RUSSIA = '00';
export const QUANTILES = [0.1, 0.25, 0.5, 0.75, 0.9];

const quantiles = (xs) => {
  if (!xs.length) return null;
  xs.sort((a, b) => a - b);
  return QUANTILES.map((q) => Math.round(xs[Math.floor(q * (xs.length - 1))]));
};

export function buildPeers(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS fns_peers (okved TEXT, region TEXT, age INT, n INT, nfin INT, profitable REAL,
             income TEXT, profit TEXT, margin REAL, year INT, PRIMARY KEY (okved, region, age));
           CREATE TABLE IF NOT EXISTS fns_market (okved TEXT, region TEXT, month TEXT, n INT, PRIMARY KEY (okved, region, month))`);
  const ref = db.prepare('SELECT max(asof) AS d FROM fns_finance').get().d
    || db.prepare('SELECT max(asof) AS d FROM fns_msp').get().d;
  const month = (db.prepare('SELECT max(asof) AS d FROM fns_msp').get().d || '').slice(0, 7);
  if (!ref) return 0;
  const year = Number(ref.slice(0, 4));
  // возраст на дату отчётности, сгруппированный: 0, 1, 2, 3 (3–4 года), 5 (5+)
  const age = `(CASE WHEN a < 3 THEN max(a, 0) WHEN a < 5 THEN 3 ELSE 5 END)`;
  const base = `SELECT substr(m.okved, 1, 2) AS ok, m.region AS rg, ${age} AS age, f.income, f.expense
                FROM (SELECT *, CAST((julianday(:ref) - julianday(since)) / 365.25 AS INT) AS a FROM fns_msp
                      WHERE okved IS NOT NULL AND region IS NOT NULL AND since IS NOT NULL) m
                LEFT JOIN fns_finance f ON f.inn = m.inn`;
  // четыре уровня: отрасль+регион+возраст, отрасль+Россия+возраст, отрасль+регион, отрасль+Россия
  const levels = [
    [`rg`, `age`], [`'${RUSSIA}'`, `age`], [`rg`, `${ALL_AGES}`], [`'${RUSSIA}'`, `${ALL_AGES}`]
  ];
  const put = db.prepare(`INSERT INTO fns_peers (okved, region, age, n, nfin, profitable, income, profit, margin, year)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const market = db.prepare('INSERT OR REPLACE INTO fns_market (okved, region, month, n) VALUES (?, ?, ?, ?)');
  let groups = 0;
  db.exec('BEGIN; DELETE FROM fns_peers');
  for (const [rg, ag] of levels) {
    const rows = db.prepare(`SELECT ok, ${rg} AS rg, ${ag} AS age, income, expense FROM (${base}) ORDER BY 1, 2, 3`).iterate({ ref });
    let key = null, g = null;
    const flush = () => {
      if (!g) return;
      const margins = g.pairs.filter(([i]) => i > 0).map(([i, e]) => (i - e) / i);
      const profits = g.pairs.map(([i, e]) => i - e);
      put.run(g.ok, g.rg, g.age, g.n, g.pairs.length,
        g.pairs.length ? Math.round((profits.filter((x) => x > 0).length / g.pairs.length) * 1000) / 1000 : null,
        JSON.stringify(quantiles(g.pairs.map(([i]) => i))), JSON.stringify(quantiles(profits)),
        margins.length ? Math.round(quantiles(margins.map((x) => x * 1000))[2]) / 1000 : null, year);
      if (g.age === ALL_AGES && month) market.run(g.ok, g.rg, month, g.n);
      groups++;
    };
    for (const r of rows) {
      const k = `${r.ok}|${r.rg}|${r.age}`;
      if (k !== key) { flush(); key = k; g = { ok: r.ok, rg: r.rg, age: r.age, n: 0, pairs: [] }; }
      g.n++;
      if (r.income != null && r.expense != null) g.pairs.push([r.income, r.expense]);
    }
    flush();
  }
  db.exec('COMMIT');
  return groups;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DatabaseSync(process.argv[2] || '/var/lib/sut/fns.db');
  console.log(`Статистика похожих компаний: ${buildPeers(db)} групп`);
  db.close();
}

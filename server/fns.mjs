// Бесплатные данные ФНС о компании или ИП — то, чего нет на нашем тарифе DaData:
//   открытые данные ФНС (scripts/fns-import.mjs → fns.db) — юрлица: налоговый режим, численность, уплаченные налоги, долги;
//   ГИР БО (bo.nalog.gov.ru) — бухотчётность за 5 лет: выручка, прибыль, активы, капитал (только юрлица);
//   «Прозрачный бизнес» (pb.nalog.ru) — для ИП: налоговый режим (УСН, патент, НПД…), категория МСП.
//     При частых запросах просит капчу — капчу не обходим: при первом же требовании делаем паузу на 2 часа.
// Сервисы ФНС работают с российских адресов — поэтому это делает сервер в России.
// Персональные данные (ФИО и ИНН руководителей и учредителей) наружу не отдаём — только количество.

const UA = 'Mozilla/5.0 (compatible; fin-check.shop)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/* ---------- ГИР БО: бухгалтерская отчётность ---------- */
export async function girbo(inn, fetchImpl) {
  const get = async (url) => {
    const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('ГИР БО ' + r.status);
    return r.json();
  };
  const found = await get(`https://bo.nalog.gov.ru/advanced-search/organizations/search?query=${inn}&page=0`);
  const org = (found.content || []).find((o) => String(o.inn || '').replace(/<[^>]+>/g, '') === inn);
  if (!org) return null;
  const reports = await get(`https://bo.nalog.gov.ru/nbo/organizations/${org.id}/bfo/`);
  const years = [];
  for (const rep of Array.isArray(reports) ? reports : []) {
    const corr = rep.typeCorrections?.[0]?.correction || rep.correction || {};
    const fr = corr.financialResult || {}, bal = corr.balance || {};
    const k = (v) => (num(v) == null ? null : num(v) * 1000);           // в отчётности — тысячи рублей
    years.push({
      year: Number(rep.period),
      revenue: k(fr.current2110),
      profit: k(fr.current2400),
      assets: k(bal.current1600),
      equity: k(bal.current1300),
      liabilities: bal.current1400 == null && bal.current1500 == null ? null : (k(bal.current1400) || 0) + (k(bal.current1500) || 0)
    });
  }
  years.sort((a, b) => a.year - b.year);
  return { url: `https://bo.nalog.gov.ru/organizations-card/${org.id}`, years: years.slice(-5) };
}

/* ---------- «Прозрачный бизнес» ---------- */
async function pbPost(path, body, fetchImpl) {
  const r = await fetchImpl('https://pb.nalog.ru/' + path, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body), signal: AbortSignal.timeout(15000)
  });
  const j = await r.json().catch(() => ({}));
  if (j.ERRORS && JSON.stringify(j.ERRORS).includes('aptcha')) throw new Error('ПБ просит капчу');
  if (!r.ok) throw new Error('ПБ ' + r.status);
  return j;
}
// Ответ готовится асинхронно: сначала получаем id запроса, потом забираем результат (иногда со второй попытки)
async function pbAwait(path, body, fetchImpl, pause) {
  const q = await pbPost(path, body, fetchImpl);
  if (q.captchaRequired) throw new Error('ПБ просит капчу');
  for (let i = 0; i < 5; i++) {
    await sleep(pause);
    const r = await pbPost(path, { ...(body.token ? { token: body.token } : {}), id: q.id, method: 'get-response' }, fetchImpl);
    if (r && Object.keys(r).length && !r.ERRORS) return r;
  }
  throw new Error('ПБ не ответил');
}

const REGIMES = { usn: 'УСН', ausn: 'АУСН', psn: 'патент', npd: 'НПД', eshn: 'ЕСХН', envd: 'ЕНВД', spr: 'СРП' };
const CODES = { usn: 'USN', ausn: 'AUSN', psn: 'PSN', npd: 'NPD', eshn: 'ESHN', envd: 'ENVD', spr: 'SRP' };
const MSP = { 1: 'микропредприятие', 2: 'малое предприятие', 3: 'среднее предприятие' };

export function pbSummary(d, isIp) {
  const v = d.vyp || {};
  const regimeKeys = Object.keys(REGIMES).filter((k) => Number(v[k]) === 1);
  const tm = Array.isArray(d.taxmode) && d.taxmode[0];
  const arrears = (Array.isArray(d.arrear) ? d.arrear : [])
    .filter((a) => Number(a.totalsum) > 0)
    .map((a) => ({ name: a.kbkname, arrear: num(a.arrearsum), penalty: num(a.penaltysum), fine: num(a.finesum), total: num(a.totalsum) }));
  const taxes = (Array.isArray(d.taxpay) ? d.taxpay : [])
    .filter((t) => Number(t.taxsum) > 0 && !/задолженност|переплат/i.test(t.kbkname || ''))
    .map((t) => ({ name: t.kbkname.replace(/\s+/g, ' ').trim(), sum: num(t.taxsum) }))
    .sort((a, b) => b.sum - a.sum);
  const mgrCompanies = Math.max(0, ...((Array.isArray(v.masruk) ? v.masruk : []).map((m) => Number(m.cnt) || 0)));
  return {
    type: isIp ? 'ip' : 'ul',
    regime: {
      known: Number(v.hastaxmode) === 1 || !!tm,
      names: regimeKeys.map((k) => REGIMES[k]),
      code: regimeKeys.map((k) => CODES[k]).join(','),          // в формате DaData finance.tax_system: USN, AUSN…
      period: tm ? `${String(tm.periodcode).replace('.0', '').padStart(2, '0')}.${tm.yearcode}` : null
    },
    employees: (Array.isArray(d.sschr) ? d.sschr : []).map((s) => ({ year: s.yearcode, n: num(s.sschr) })).slice(0, 3),
    taxesPaid: num(v.taxpaysum) == null ? null : { year: v.taxpay_yearcode, total: num(v.taxpaysum), items: taxes.slice(0, 6) },
    arrears: num(v.totalarrearsum) == null ? null : {
      total: num(v.totalarrearsum), asOf: v.arrear_yearcode ? `${String(v.arrear_periodcode).replace('.0', '').padStart(2, '0')}.${v.arrear_yearcode}` : null, items: arrears
    },
    reports: (Array.isArray(d.form1) ? d.form1 : []).map((f) => ({ year: f.yearcode, revenue: num(f.revenue), expense: num(f.expense) })),
    msp: v.rsmpcategory ? { category: MSP[Number(v.rsmpcategory)] || null, since: (v.rsmpdate || '').slice(0, 10) || null } : null,
    massAddress: Array.isArray(d.masaddress) && d.masaddress.length > 0,
    managerOtherCompanies: mgrCompanies > 1 ? mgrCompanies - 1 : 0,
    foundersCount: Array.isArray(v.masuchr) ? v.masuchr.length : null,
    offenseYears: (Array.isArray(d.offense) ? d.offense : []).map((o) => o.yearcode).filter(Boolean),
    notReporting: Number(v.pr_otch) === 1,
    vestnik: Array.isArray(d.vestnik) ? d.vestnik.length : 0,
    invalid: Number(v.invalid) === 1,
    boUrl: (v.bourl || '').trim() || null
  };
}

export async function pb(inn, fetchImpl, pause = 700) {
  const isIp = inn.length === 12;
  const found = await pbAwait('search-proc.json', isIp ? { mode: 'search-ip', queryIp: inn, page: 1, pageSize: 10 } : { mode: 'search-ul', queryUl: inn, page: 1, pageSize: 10 }, fetchImpl, pause);
  const row = ((found[isIp ? 'ip' : 'ul'] || {}).data || []).find((x) => x.inn === inn);
  if (!row) return null;
  const card = await pbAwait('company-proc.json', { token: row.token, method: 'get-request' }, fetchImpl, pause);
  return pbSummary(card, isIp);
}

/* ---------- открытые данные ФНС из нашей базы (только юрлица) ---------- */
const yearOf = (d) => (d ? Number(String(d).slice(0, 4)) : null);
const asOfRu = (d) => (d ? d.split('-').reverse().join('.') : null);
export function openData(inn, db) {
  if (!db) return null;
  const q = (t) => db.prepare(`SELECT * FROM ${t} WHERE inn = ?`).get(inn);
  let r, st, tx, dt;
  try { r = q('fns_regime'); st = q('fns_staff'); tx = q('fns_tax'); dt = q('fns_debt'); } catch { return null; }
  if (!r && !st && !tx && !dt) return null;
  const names = r ? [['usn', 'УСН'], ['ausn', 'АУСН'], ['eshn', 'ЕСХН'], ['srp', 'СРП']].filter(([k]) => r[k]).map(([, n]) => n) : [];
  const code = r ? [['usn', 'USN'], ['ausn', 'AUSN'], ['eshn', 'ESHN'], ['srp', 'SRP']].filter(([k]) => r[k]).map(([, c]) => c).join(',') : '';
  return {
    type: 'ul', source: 'opendata',
    // в наборе спецрежимов есть все организации на спецрежимах; если компании там нет — это общая система
    regime: { known: true, names, code, period: r ? asOfRu(r.asof) : null },
    employees: st ? [{ year: yearOf(st.asof), n: st.n }] : [],
    taxesPaid: tx ? { year: yearOf(tx.asof), total: tx.total, items: JSON.parse(tx.items || '[]').slice(0, 6) } : null,
    arrears: { total: dt ? dt.total : 0, asOf: dt ? asOfRu(dt.asof) : null, items: dt ? JSON.parse(dt.items || '[]') : [] },
    reports: [], msp: null, massAddress: null, managerOtherCompanies: null, foundersCount: null, offenseYears: [], notReporting: null, vestnik: null, invalid: null
  };
}

/* ---------- всё вместе: частичные ошибки не роняют ответ ---------- */
let pbPausedUntil = 0;
export async function fnsData(inn, fetchImpl, pause, db = null, now = Date.now) {
  const isIp = inn.length === 12;
  const tasks = [
    isIp && now() > pbPausedUntil ? pb(inn, fetchImpl, pause) : Promise.resolve(null),
    isIp ? Promise.resolve(null) : girbo(inn, fetchImpl)
  ];
  const [p, b] = await Promise.allSettled(tasks);
  if (p.status === 'rejected') {
    console.error('ПБ', inn, p.reason?.message);
    if (/капч/i.test(p.reason?.message || '')) pbPausedUntil = now() + 2 * 3600e3;
  }
  if (b.status === 'rejected') console.error('ГИР БО', inn, b.reason?.message);
  return { pb: isIp ? (p.status === 'fulfilled' ? p.value : null) : openData(inn, db), bo: b.status === 'fulfilled' ? b.value : null };
}

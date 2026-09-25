// Подробная карточка компании из DataNewton (datanewton.ru): ЕГРЮЛ/ЕГРИП целиком, суды общей юрисдикции,
// арбитраж, исполнительные производства. Каждый метод — 1 единица лимита, поэтому ответ кешируется на сутки (index.mjs).
// Персональные данные: показываем только то, что открыто в ЕГРЮЛ (ФИО и должность руководителя, участники и доли).
// ИНН физлиц и личные контакты людей (контакты с указанной должностью владельца) наружу не отдаём.

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const arr = (v) => (Array.isArray(v) ? v : []);

async function call(cfg, fetchImpl, method, path, params) {
  const url = new URL(cfg.dnUrl + path);
  url.searchParams.set('key', cfg.dnKey);
  const opts = { method, headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) };
  if (method === 'GET') for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(params); }
  const r = await fetchImpl(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.error && j.error.code && !j.data && !j.company && !j.individual)) throw new Error(`DataNewton ${path} ${r.status} ${j.error?.message || j.message || ''}`.trim());
  return j;
}

// Отметки, которые стоит показать человеку (без вердиктов: только факт и где проверить)
const FLAGS = [
  ['false_info', 'В ЕГРЮЛ есть отметка о недостоверности сведений'],
  ['address_false_info', 'Адрес отмечен в ЕГРЮЛ как недостоверный'],
  ['managers_false_info', 'Сведения о руководителе отмечены как недостоверные'],
  ['owner_false_info', 'Сведения об участнике отмечены как недостоверные'],
  ['disqualified_managers', 'Руководитель дисквалифицирован'],
  ['disqualified_owners', 'Участник дисквалифицирован'],
  ['disqualified_individual', 'Предприниматель дисквалифицирован'],
  ['unscrupulous_supplier44', 'В реестре недобросовестных поставщиков (44-ФЗ)'],
  ['unscrupulous_supplier223', 'В реестре недобросовестных поставщиков (223-ФЗ)'],
  ['in_bankruptcy', 'Идёт процедура банкротства'],
  ['has_bankruptcy_messages', 'За последний год на Федресурсе были сообщения о банкротстве'],
  ['has_liquidation_docs', 'В налоговую поданы документы о ликвидации или реорганизации'],
  ['fns_accounts_blocked', 'Налоговая приостановила операции по счетам'],
  ['has_fines_debts', 'Есть налоговая задолженность больше 1 000 ₽'],
  ['tax_offences', 'Были налоговые нарушения в прошлом году'],
  ['fssp_debt', 'Долги у приставов больше 300 000 ₽'],
  ['zsk_high_risk', 'Высокий риск по платформе ЦБ «Знай своего клиента»'],
  ['fin_illegal', 'Признаки нелегальной деятельности на финансовом рынке (ЦБ)'],
  ['in_sanctions_list', 'В санкционных списках'],
  ['foreigner_agent', 'В реестре иностранных агентов'],
  ['in_terrorists_extremists', 'В перечне Росфинмониторинга'],
  ['owners_offshore', 'Есть связь с офшорными зонами'],
  ['information_limited', 'Доступ к части сведений в ЕГРЮЛ ограничен']
];
// значение отметки бывает булевым или объектом вида { value: true, ... }
const flagOn = (v) => v === true || (v && typeof v === 'object' && (v.value === true || v.status === true || v.sign === true));

function workers(w) {
  if (!w) return [];
  if (Array.isArray(w)) return w.map((x) => ({ year: num(x.year), n: num(x.count ?? x.value ?? x.workers_count) })).filter((x) => x.year && x.n != null);
  return Object.entries(w).map(([y, n]) => ({ year: num(y), n: num(typeof n === 'object' && n ? n.count ?? n.value : n) }))
    .filter((x) => x.year && x.n != null).sort((a, b) => a.year - b.year);
}

// Контакты компании: без контактов конкретных людей (с должностью владельца), самые подтверждённые сверху
function contacts(c) {
  const pick = (list) => arr(list).filter((x) => x && x.value && !x.owner_position)
    .sort((a, b) => (b.weight || 0) - (a.weight || 0)).slice(0, 4)
    .map((x) => ({ value: String(x.value).trim(), source: x.source_label || (x.sources || [])[0] || null }));
  return { phones: pick(c?.phones), emails: pick(c?.emails), sites: pick(c?.websites) };
}

export function normCard(j) {
  const c = j.company || j.individual || {};
  const isIp = !j.company && !!j.individual;
  const own = c.owners || {};
  const owners = [...arr(own.fl).map((o) => ({ ...o, kind: 'fl' })), ...arr(own.ul_rus).map((o) => ({ ...o, kind: 'ul' })),
    ...arr(own.ul_foreign).map((o) => ({ ...o, kind: 'foreign' })), ...arr(own.gov).map((o) => ({ ...o, kind: 'gov' })),
    ...arr(own.pif).map((o) => ({ ...o, kind: 'pif' })), ...arr(own.ooo).map((o) => ({ ...o, kind: 'self' }))]
    .map((o) => ({
      name: o.name || null, kind: o.kind, share: o.share != null ? String(o.share) : null, sum: num(o.captable_size),
      inn: o.kind === 'fl' ? null : (o.inn || (o.company_inn ? String(o.company_inn) : null)),
      country: o.country || null, limited: !!o.information_limited, disqualified: !!o.disqualified_person, bankrupt: !!o.bankrupt_company_person, mass: !!o.mass_owner
    }));
  const neg = c.negative_lists || {};
  const tm = c.tax_mode_info || {};
  const regime = [['usn_sign', 'УСН'], ['ausn_sign', 'АУСН'], ['psn_sign', 'патент'], ['npd_sign', 'НПД'], ['eshn_sign', 'ЕСХН'], ['srp_sign', 'СРП'], ['envd_sign', 'ЕНВД']]
    .filter(([k]) => tm[k]).map(([, n]) => n);
  if (!regime.length && tm.common_mode) regime.push('общая система');
  return {
    type: isIp ? 'ip' : 'ul',
    name: c.company_names?.short_name || c.fio || null,
    fullName: c.company_names?.full_name || null,
    opf: c.opf || c.vid_iptext || null,
    kpp: c.kpp || null,
    registered: c.registration_date || null,
    years: num(c.years_from_registration),
    status: c.status ? { active: c.status.active_status !== false, text: c.status.status_rus_short || c.status.status_egr || null, date: c.status.date_end || null } : null,
    dissolved: c.dissolved_date || null,
    address: c.address ? { text: c.address.line_address || c.address.egrul_address || null, inaccurate: !!c.address.is_inaccuracy } : null,
    capital: num(c.charter_capital),
    managers: arr(c.managers).map((m) => ({ fio: m.fio || null, position: m.position || null, since: m.date || null, inaccurate: m.is_inaccuracy === false ? true : false, bankrupt: !!m.bankrupt_company_person })),
    managementCompany: c.management_company?.name ? { name: c.management_company.name, inn: c.management_company.inn || null, since: c.management_company.date || null } : null,
    owners,
    registryKeeper: own.share_registry_keeper?.name || null,
    okveds: arr(c.okveds).map((o) => ({ code: o.code, name: o.value, main: !!o.main })).sort((a, b) => b.main - a.main),
    workers: workers(c.workers_count),
    contacts: contacts(c.contacts),
    regime: regime.length ? { names: regime, date: tm.publication_date || null } : null,
    msp: c.msp_block?.category ? { category: c.msp_block.category, since: c.msp_block.msp_in_date || null, contracts: num(c.msp_block.contracts_count), licenses: num(c.msp_block.licenses_count) } : null,
    taxOffice: c.uchet_department?.department_name || null,
    branches: arr(c.branches_block?.branches || c.branches_block?.data).length || null,
    flags: FLAGS.filter(([k]) => flagOn(neg[k])).map(([k, t]) => ({ key: k, text: t })),
    fsspDebt: num(neg.fssp_debt_remaining_balance),
    bankruptcy: arr(neg.bankruptcy_info).map((b) => ({ stage: b.bankruptcy_stage || null, active: !!b.active, start: b.start_date || null, end: b.end_date || null, case: b.case_number || null }))
  };
}

// Роль компании в деле по списку участников
const roleOf = (text) => (/ответчик|должник|административный ответчик|лицо, в отношении/i.test(text || '') ? 'defendant'
  : /истец|заявитель|взыскатель|административный истец/i.test(text || '') ? 'plaintiff' : 'other');

export function normCourts(j, inn) {
  const data = arr(j.data);
  const cases = data.map((d) => {
    const me = arr(d.participants).find((p) => p.inn === inn);
    return {
      number: d.case_number || null, url: d.case_url || null, court: d.court_name || null, date: d.entry_date || null,
      category: d.category || null, status: d.status || null, result: d.result || null, essence: d.essence || null,
      role: me ? roleOf(me.role) : 'other', roleText: me?.role || null
    };
  });
  const count = (r) => cases.filter((c) => c.role === r).length;
  const categories = {};
  for (const c of cases) if (c.category) categories[c.category] = (categories[c.category] || 0) + 1;
  return { total: num(j.total) ?? cases.length, shown: cases.length, defendant: count('defendant'), plaintiff: count('plaintiff'), other: count('other'),
    categories: Object.entries(categories).sort((a, b) => b[1] - a[1]).slice(0, 5), years: j.year_stat || null, recent: cases.slice(0, 8) };
}

export function normArbitration(j, inn) {
  const data = arr(j.data);
  const has = (list) => arr(list).some((p) => p.inn === inn);
  const cases = data.map((d) => ({
    number: d.first_number || null, url: d.kad_arbitr_link || null, date: d.date_start || null, sum: num(d.sum),
    year: num(d.year) || num(String(d.date_start || '').slice(0, 4)),
    open: d.status === 0, outcome: d.party_result || (d.status === 0 ? 'IN_PROGRESS' : 'THIRD'),
    role: has(d.respondents) || has(d.debtors) ? 'defendant' : has(d.plaintiffs) || has(d.applicants) || has(d.creditors) ? 'plaintiff' : 'other'
  }));
  const of = (r) => cases.filter((c) => c.role === r);
  const sum = (l) => l.reduce((s, c) => s + (c.sum || 0), 0);
  const outcomes = {}, years = {};
  for (const c of cases) {
    outcomes[c.outcome] = (outcomes[c.outcome] || 0) + 1;
    if (c.year) { const y = (years[c.year] ||= { n: 0, sum: 0 }); y.n++; y.sum += c.sum || 0; }
  }
  return {
    total: num(j.total_cases) ?? cases.length, shown: cases.length, sum: sum(cases),
    defendant: of('defendant').length, defendantSum: sum(of('defendant')), plaintiff: of('plaintiff').length, plaintiffSum: sum(of('plaintiff')),
    other: of('other').length, open: cases.filter((c) => c.open).length, openDefendant: of('defendant').filter((c) => c.open).length,
    outcomes, years, recent: cases.slice(0, 8)
  };
}

export function normFssp(j, inn) {
  const data = arr(j.data).filter((d) => !d.debtor_inn || d.debtor_inn === inn);
  const open = data.filter((d) => d.status === 'OPEN');
  return {
    total: num(j.total) ?? data.length, open: open.length,
    openSum: open.reduce((s, d) => s + (num(d.debt_remaining_balance) ?? num(d.amount_due) ?? 0), 0),
    recent: data.slice(0, 8).map((d) => ({ date: d.ep_date || null, subject: d.executive_obj || d.executive_document_obj || null, sum: num(d.debt_remaining_balance) ?? num(d.amount_due), open: d.status === 'OPEN', collector: d.collector_name || null }))
  };
}

export async function dnData(inn, cfg, fetchImpl) {
  const filters = 'ADDRESS_BLOCK,MANAGER_BLOCK,OWNER_BLOCK,OKVED_BLOCK,NEGATIVE_LISTS_BLOCK,WORKERS_COUNT_BLOCK,CONTACT_BLOCK,MSP_BLOCK,BRANCHES_BLOCK';
  const [card, courts, arb, fssp] = await Promise.allSettled([
    call(cfg, fetchImpl, 'GET', '/v1/counterparty', { inn, filters }),
    call(cfg, fetchImpl, 'POST', '/v1/courtCases', { inn, limit: 50, sort: 'entry_date', order: 'desc' }),
    call(cfg, fetchImpl, 'GET', '/v1/arbitration-cases', { inn, limit: 100, company_role: 'ALL' }),
    inn.length === 10 ? call(cfg, fetchImpl, 'POST', '/v1/fssp', { inn, limit: 100, sort: 'date', order: 'desc' }) : Promise.resolve(null)
  ]);
  for (const [n, r] of [['карточка', card], ['суды', courts], ['арбитраж', arb], ['ФССП', fssp]]) if (r.status === 'rejected') console.error('DataNewton', n, inn, r.reason?.message);
  const ok = (r) => (r.status === 'fulfilled' ? r.value : null);
  return {
    card: ok(card) ? normCard(ok(card)) : null,
    courts: ok(courts) ? normCourts(ok(courts), inn) : null,
    arbitration: ok(arb) ? normArbitration(ok(arb), inn) : null,
    fssp: ok(fssp) ? normFssp(ok(fssp), inn) : null,
    left: ok(card) ? (ok(card).available_count || 0) + (ok(card).demo_available_count || 0) : null
  };
}

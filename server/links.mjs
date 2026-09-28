// Руководитель и учредители для сравнения компаний и поиск общих людей и компаний-владельцев — признак возможной
// взаимозависимости (ст. 105.1 НК). Сведения открытые, из ЕГРЮЛ (через DaData и DataNewton). Люди без ИНН сверяются
// по ФИО — совпадение ФИО не доказывает, что это один человек, поэтому такие совпадения помечаются как «по ФИО».
const norm = (s) => String(s || '').toUpperCase().replace(/Ё/g, 'Е').replace(/[^А-ЯA-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const fioOf = (f) => (f && typeof f === 'object' ? [f.surname, f.name, f.patronymic].filter(Boolean).join(' ') : '');

// party — карточка DaData ({ data }), card — карточка DataNewton (normCard); берём, что есть
export function peopleOf(party, card) {
  const d = (party && party.data) || {};
  const director = d.management && d.management.name ? { name: d.management.name, post: d.management.post || null }
    : card && card.managers && card.managers[0] && card.managers[0].fio ? { name: card.managers[0].fio, post: card.managers[0].position || null }
    : null;
  const mc = card && card.managementCompany;
  let founders = [];
  if (card && Array.isArray(card.owners) && card.owners.length) {
    founders = card.owners.map((o) => ({ name: o.name, inn: o.kind === 'fl' ? null : o.inn || null, person: o.kind === 'fl', share: o.share || null }));
  } else if (Array.isArray(d.founders)) {
    founders = d.founders.map((f) => ({ name: f.name || fioOf(f.fio), inn: f.type === 'PHYSICAL' ? null : f.inn || null, person: f.type === 'PHYSICAL' || !!f.fio, share: f.share && f.share.value != null ? String(f.share.value) : null }));
  }
  founders = founders.filter((f) => f.name);
  return { director, manager: mc ? { name: mc.name, inn: mc.inn || null } : null, founders, known: !!(party || card) };
}

// items: [{ inn, name, people }] → [{ name, exact, roles: [{ inn, role }] }] — только то, что встречается у двух и более компаний
export function commonPeople(items) {
  const map = new Map();
  const add = (key, name, exact, inn, role) => {
    if (!key) return;
    const e = map.get(key) || { name, exact, roles: [] };
    if (!e.roles.some((r) => r.inn === inn && r.role === role)) e.roles.push({ inn, role });
    map.set(key, e);
  };
  for (const it of items) {
    const p = it.people;
    add('inn:' + it.inn, it.name || 'ИНН ' + it.inn, true, it.inn, 'сама компания');
    if (!p) continue;
    if (p.director) add('fio:' + norm(p.director.name), p.director.name, false, it.inn, 'руководитель');
    if (p.manager) add(p.manager.inn ? 'inn:' + p.manager.inn : 'org:' + norm(p.manager.name), p.manager.name, !!p.manager.inn, it.inn, 'управляющая компания');
    for (const f of p.founders) add(f.inn ? 'inn:' + f.inn : (f.person ? 'fio:' : 'org:') + norm(f.name), f.name, !!f.inn, it.inn, 'учредитель');
  }
  return [...map.values()]
    .filter((e) => new Set(e.roles.map((r) => r.inn)).size >= 2)
    .map((e) => ({ ...e, roles: e.roles.filter((r) => r.role !== 'сама компания' || e.roles.length > 1) }));
}

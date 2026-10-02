/* INNSIDER: калькулятор «Налоговая нагрузка и выбор режима».
   Сравнивает ИП и ООО по режимам (УСН, патент, самозанятость, АУСН, ОСНО) при вашем доходе, расходах, числе сотрудников и виде
   деятельности. Все ставки и лимиты берём из config/finance.json (сборка кладёт их в страницу как #fin), цифры в коде не зашиты.
   Расчёт идёт в браузере, введённые суммы никуда не уходят. Функция compute чистая: её же проверяет scripts/test-burden.mjs. */
(function (root) {
  'use strict';

  function prog(scale, base) {
    var tax = 0, prev = 0;
    for (var i = 0; i < scale.length; i++) {
      var top = scale[i][0] == null ? Infinity : scale[i][0];
      if (base > prev) tax += (Math.min(base, top) - prev) * scale[i][1];
      prev = top;
    }
    return tax;
  }

  // p: { income, expenses, staff, salary (в месяц на одного), activity, legal (доля оплат от компаний, 0..1), pvd (потенциальный доход патента, ₽/год) }
  function compute(FIN, p) {
    var B = FIN.burden, R = FIN.regimes, IP = FIN.ip, N = FIN.npd;
    var inc = Math.max(0, p.income || 0), exp = Math.max(0, p.expenses || 0), staff = Math.max(0, Math.floor(p.staff || 0));
    var salary = Math.max(0, p.salary || 0), pvd = Math.max(0, p.pvd || 0);
    var legal = Math.min(1, Math.max(0, p.legal == null ? 0.5 : p.legal));
    var act = null;
    for (var a = 0; a < B.activities.length; a++) if (B.activities[a].id === p.activity) act = B.activities[a];
    act = act || B.activities[0];

    var yearly = salary * 12, F = staff * yearly;
    var C = B.contrib;
    var perPerson = C.rate * Math.min(yearly, C.base) + C.rateOver * Math.max(0, yearly - C.base) + C.injury * yearly;
    var cStaff = staff * perPerson;
    // страховые взносы ИП за себя: фиксированные и 1% с дохода сверх порога (не больше предела)
    var ownFor = function (base) { return IP.fixed + Math.min(IP.extraMax, Math.max(0, base - IP.extraFrom) * IP.extraRate); };
    // налог УСН и патента уменьшается на взносы: у ИП без сотрудников на всю сумму, с сотрудниками не больше чем наполовину
    var deduct = function (tax0, paid) { return Math.max(0, tax0 - Math.min(staff > 0 ? tax0 / 2 : tax0, paid)); };
    // на УСН выше порога дохода платится НДС по пониженной ставке без вычетов; выручка считается вместе с ним
    var ndsUsn = function () {
      if (inc <= R.ndsFrom) return { rate: 0, nds: 0, net: inc };
      var r = inc <= B.nds.lowTo ? B.nds.low : B.nds.high, nds = inc * r / (1 + r);
      return { rate: r, nds: nds, net: inc - nds };
    };
    var pct = function (x) { return String(Math.round(x * 1000) / 10).replace('.', ','); };

    var res = function (parts) {
      var total = 0;
      parts = parts.filter(function (x) { return x && x[1] > 0.5; });
      parts.forEach(function (x) { total += x[1]; });
      return { ok: true, total: total, parts: parts };
    };
    var no = function (why) { return { ok: false, why: why }; };

    var usnOk = function () {
      if (!act.usn) return 'для этого вида деятельности упрощённая система недоступна';
      if (inc > R.usnIncomeLimit) return 'доход больше ' + Math.round(R.usnIncomeLimit / 1e6) + ' млн ₽';
      if (staff > R.usnEmployees) return 'больше ' + R.usnEmployees + ' сотрудников';
      return '';
    };

    function usnIncome(form) {
      var why = usnOk(); if (why) return no(why);
      var n = ndsUsn(), own = form === 'ip' ? ownFor(n.net) : 0, tax0 = R.usnRateIncome * n.net;
      var tax = deduct(tax0, own + cStaff);
      return res([['налог', tax], form === 'ip' ? ['взносы ИП', own] : null, ['взносы за сотрудников', cStaff], n.nds ? ['НДС ' + pct(n.rate) + '%', n.nds] : null]);
    }
    function usnProfit(form) {
      var why = usnOk(); if (why) return no(why);
      var n = ndsUsn(), own = form === 'ip' ? ownFor(Math.max(0, n.net - exp - F - cStaff)) : 0;
      var tax = Math.max(R.usnRateProfit * Math.max(0, n.net - exp - F - cStaff - own), R.usnMinTax * n.net);
      return res([['налог', tax], form === 'ip' ? ['взносы ИП', own] : null, ['взносы за сотрудников', cStaff], n.nds ? ['НДС ' + pct(n.rate) + '%', n.nds] : null]);
    }
    function psn(form) {
      if (form !== 'ip') return no('патент только для ИП');
      if (!act.psn) return no('для этого вида деятельности патент недоступен');
      if (inc > R.psnIncomeLimit) return no('доход больше ' + Math.round(R.psnIncomeLimit / 1e6) + ' млн ₽');
      if (staff > R.psnEmployees) return no('больше ' + R.psnEmployees + ' сотрудников');
      if (!(pvd > 0)) return { ok: true, partial: true, why: 'стоимость патента зависит от региона: возьмите потенциальный доход из калькулятора ФНС и впишите его в поле выше' };
      var own = ownFor(pvd), tax = deduct(B.psnRate * pvd, own + cStaff);
      return res([['патент', tax], ['взносы ИП', own], ['взносы за сотрудников', cStaff]]);
    }
    function npd(form) {
      if (form !== 'ip') return no('самозанятым может быть только человек или ИП');
      if (!act.npd) return no('для этого вида деятельности самозанятость недоступна');
      if (staff > 0) return no('самозанятым нельзя нанимать сотрудников');
      if (inc > N.limit) return no('доход больше ' + (N.limit / 1e6).toString().replace('.', ',') + ' млн ₽');
      var people = inc * (1 - legal), firms = inc * legal;
      var tax = people * N.rateIndividuals + firms * N.rateCompanies - Math.min(N.deduction, people * N.deductionRateIndividuals + firms * N.deductionRateCompanies);
      return res([['налог', tax]]);
    }
    function ausn(form, profit) {
      var A = B.ausn;
      if (!act.ausn) return no('для этого вида деятельности АУСН недоступна');
      if (inc > R.ausnIncomeLimit) return no('доход больше ' + Math.round(R.ausnIncomeLimit / 1e6) + ' млн ₽');
      if (staff > R.ausnEmployees) return no('больше ' + R.ausnEmployees + ' сотрудников');
      var inj = staff > 0 ? A.injuryYear : 0;
      var tax = profit ? Math.max(A.rateProfit * Math.max(0, inc - exp - F - inj), A.minTax * inc) : A.rateIncome * inc;
      return res([['налог', tax], ['взнос на травматизм', inj]]);
    }
    function osno(form) {
      var incN = inc / (1 + B.nds.std), expN = exp / (1 + B.nds.std);
      var nds = Math.max(0, (incN - expN) * B.nds.std);
      if (form === 'ul') return res([['налог на прибыль', R.profitTax * Math.max(0, incN - expN - F - cStaff)], ['взносы за сотрудников', cStaff], ['НДС ' + pct(B.nds.std) + '%', nds]]);
      var docs = expN + F + cStaff, prof = B.professionalDeduction * incN;
      var own = ownFor(incN - Math.max(docs, prof));
      var ded = Math.max(docs + own, prof);
      return res([['НДФЛ', prog(B.ndflScale, Math.max(0, incN - ded))], ['взносы ИП', own], ['взносы за сотрудников', cStaff], ['НДС ' + pct(B.nds.std) + '%', nds]]);
    }

    var pc = function (x) { return pct(x); };
    var defs = [
      ['usn6', 'УСН «доходы» ' + pc(R.usnRateIncome) + '%', usnIncome],
      ['usn15', 'УСН «доходы минус расходы» ' + pc(R.usnRateProfit) + '%', usnProfit],
      ['psn', 'Патент', psn],
      ['npd', 'Самозанятость (НПД)', npd],
      ['ausn8', 'АУСН «доходы» ' + pc(B.ausn.rateIncome) + '%', function (f) { return ausn(f, false); }],
      ['ausn20', 'АУСН «доходы минус расходы» ' + pc(B.ausn.rateProfit) + '%', function (f) { return ausn(f, true); }],
      ['osno', 'Общая система (ОСНО)', osno]
    ];
    var rows = defs.map(function (d) { return { id: d[0], name: d[1], ip: d[2]('ip'), ul: d[2]('ul') }; });
    var best = {};
    ['ip', 'ul'].forEach(function (f) {
      rows.forEach(function (r) {
        var c = r[f];
        if (c.ok && !c.partial && (!best[f] || c.total < best[f].total)) best[f] = { id: r.id, name: r.name, total: c.total };
      });
    });
    return { rows: rows, best: best, income: inc, activity: act, staffContrib: cStaff, payroll: F };
  }

  var api = { compute: compute, prog: prog };
  root.INNBurden = api;

  /* ---------- страница ---------- */
  var doc = root.document;
  if (!doc || !doc.querySelector) return;
  var box = doc.querySelector('[data-calc=burden]');
  if (!box) return;
  var FIN = {};
  try { FIN = JSON.parse((doc.getElementById('fin') || {}).textContent || '{}'); } catch (e) { FIN = {}; }
  if (!FIN.burden || !FIN.regimes) return;

  var out = box.querySelector('.result');
  var read = function (name) {
    var el = box.querySelector('[name=' + name + ']');
    var v = parseFloat(String(el ? el.value : '').replace(/[\s  ]/g, '').replace(',', '.'));
    return isFinite(v) ? v : 0;
  };
  var rub = function (n) { return (n < 0 ? '−' : '') + Math.round(Math.abs(n)).toLocaleString('ru-RU') + ' ₽'; };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var pcs = function (x) { return (Math.round(x * 1000) / 10).toLocaleString('ru-RU') + '%'; };
  var FORM = { ip: 'ИП', ul: 'ООО' };

  function cell(c, form, income) {
    var label = FORM[form];
    if (!c.ok) return '<div class="bad"><span>' + label + '</span><strong>недоступно</strong></div><p class="note-sm">' + esc(c.why) + '</p>';
    if (c.partial) return '<div><span>' + label + '</span><strong>нужен расчёт по региону</strong></div><p class="note-sm">' + esc(c.why) + '</p>';
    return '<div><span>' + label + '</span><strong>' + rub(c.total) + (income > 0 ? ' · ' + pcs(c.total / income) : '') + '</strong></div>' +
      '<p class="note-sm">' + c.parts.map(function (x) { return esc(x[0]) + ' ' + rub(x[1]); }).join(', ') + '</p>';
  }

  function run() {
    var sel = box.querySelector('[name=activity]');
    var r = compute(FIN, {
      income: read('income'), expenses: read('expenses'), staff: read('staff'), salary: read('salary'),
      activity: sel ? sel.value : '', legal: Math.min(100, read('legal')) / 100, pvd: read('pvd')
    });
    if (!(r.income > 0)) { out.innerHTML = '<p class="verdict">Впишите доход за год.</p>'; return; }
    var html = r.rows.map(function (row) {
      var anyOk = row.ip.ok || row.ul.ok;
      var isBest = (r.best.ip && r.best.ip.id === row.id) || (r.best.ul && r.best.ul.id === row.id);
      return '<div class="opt' + (isBest ? ' best' : '') + (anyOk ? '' : ' off') + '"><h3>' + esc(row.name) + '</h3>' +
        cell(row.ip, 'ip', r.income) + cell(row.ul, 'ul', r.income) + '</div>';
    }).join('');
    var lines = [];
    ['ip', 'ul'].forEach(function (f) {
      var b = r.best[f];
      lines.push(b ? 'Для ' + FORM[f] + ' дешевле всего: ' + b.name + ' — ' + rub(b.total) + ' в год, ' + pcs(b.total / r.income) + ' дохода.' : 'Для ' + FORM[f] + ' посчитать нечего: все режимы недоступны или требуют данных по региону.');
    });
    if (r.best.ip && r.best.ul) {
      var d = r.best.ul.total - r.best.ip.total;
      lines.push(d > 0.5 ? 'ИП выходит дешевле ООО на ' + rub(d) + ' в год.' : d < -0.5 ? 'ООО выходит дешевле ИП на ' + rub(-d) + ' в год.' : 'ИП и ООО выходят одинаково.');
    }
    var notes = [];
    if (read('expenses') >= r.income) notes.push('Расходы не меньше дохода: прибыли нет. На режимах с налогом на прибыль налог нулевой или минимальный, на «доходах» он всё равно платится.');
    if (r.activity.note) notes.push(r.activity.note.charAt(0).toUpperCase() + r.activity.note.slice(1) + '.');
    out.innerHTML = html + '<p class="verdict"><b>Итог.</b> ' + esc(lines.join(' ')) + '</p>' + (notes.length ? '<p class="note-sm">' + esc(notes.join(' ')) + '</p>' : '');
  }

  Array.prototype.forEach.call(box.querySelectorAll('input, select'), function (i) { i.addEventListener('input', run); i.addEventListener('change', run); });
  run();
})(typeof window !== 'undefined' ? window : globalThis);

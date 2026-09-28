/* Сравнение компаний (/sravnenie/): 2–3 организации бок о бок по открытым данным ФНС (POST /api/compare).
   Лучшее значение в строке отмечено; ссылки ведут на полную проверку каждой компании. */
(function () {
  'use strict';
  var root = document.getElementById('cmp');
  if (!root) return;
  var api = root.getAttribute('data-api') || '', form = document.getElementById('cmp-form'), msg = document.getElementById('cmp-msg'), out = document.getElementById('cmp-out');
  var ins = [].slice.call(root.querySelectorAll('.cmp-inn'));
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var money = function (n) {
    if (n == null || !isFinite(n)) return '—';
    var a = Math.abs(n), s = n < 0 ? '−' : '';
    if (a >= 1e9) return s + (a / 1e9).toFixed(1).replace('.', ',') + ' млрд ₽';
    if (a >= 1e6) return s + (a / 1e6).toFixed(1).replace('.', ',') + ' млн ₽';
    if (a >= 1e3) return s + Math.round(a / 1e3) + ' тыс. ₽';
    return s + Math.round(a) + ' ₽';
  };
  var years = function (iso) { if (!iso) return null; var y = (Date.now() - Date.parse(iso)) / (365.25 * 864e5); return y; };
  var CAT = { 1: 'микро', 2: 'малое', 3: 'среднее' };
  // строки: подпись, значение, как показать, что лучше (1 — больше, -1 — меньше, 0 — не сравниваем)
  var ROWS = [
    ['Налоговый режим', function (c) { return c.regime; }, function (v) { return v ? esc(v) : '—'; }, 0],
    ['Категория МСП', function (c) { return c.category; }, function (v) { return v ? CAT[v] || '—' : '—'; }, 0],
    ['В реестре МСП', function (c) { return years(c.since); }, function (v) { return v == null ? '—' : v < 1 ? 'меньше года' : Math.floor(v) + ' ' + (Math.floor(v) % 10 === 1 && Math.floor(v) % 100 !== 11 ? 'год' : Math.floor(v) % 10 >= 2 && Math.floor(v) % 10 <= 4 && (Math.floor(v) % 100 < 10 || Math.floor(v) % 100 >= 20) ? 'года' : 'лет'); }, 1],
    ['Сотрудников', function (c) { return c.staff; }, function (v) { return v == null ? '—' : String(v); }, 1],
    ['Доходы', function (c) { return c.income; }, money, 1],
    ['Прибыль', function (c) { return c.profit; }, money, 1],
    ['Доходы выше, чем у сверстников', function (c) { return c.incomePercentile; }, function (v) { return v == null ? '—' : v + '%'; }, 1],
    ['Уплачено налогов и взносов', function (c) { return c.taxes; }, money, 1],
    ['Налоговая задолженность', function (c) { return c.debt; }, function (v) { return v == null ? '—' : v > 0 ? money(v) : 'нет'; }, -1]
  ];

  function render(items, lk) {
    var ok = items.filter(function (c) { return !c.missing; });
    var head = '<tr><th></th>' + items.map(function (c) {
      return '<th>' + (c.missing ? 'ИНН ' + esc(c.inn) : '<a href="/organizacii/' + esc(c.inn) + '/">' + esc(c.name || 'ИНН ' + c.inn) + '</a>') + '</th>';
    }).join('') + '</tr>';
    // руководитель и учредители — текстом, без «лучшего значения»
    var who = function (c) {
      var p = c.people;
      if (!p || !p.known) return '—';
      if (p.manager) return esc(p.manager.name) + '<br><span class="note-sm">управляющая компания</span>';
      return p.director ? esc(p.director.name) + (p.director.post ? '<br><span class="note-sm">' + esc(p.director.post.toLowerCase()) + '</span>' : '') : '—';
    };
    var owners = function (c) {
      var p = c.people;
      if (!p || !p.known || !p.founders.length) return '—';
      return p.founders.slice(0, 5).map(function (f) { return esc(f.name) + (f.share ? ' <span class="note-sm">' + esc(f.share) + (/%$/.test(f.share) ? '' : '%') + '</span>' : ''); }).join('<br>') +
        (p.founders.length > 5 ? '<br><span class="note-sm">и ещё ' + (p.founders.length - 5) + '</span>' : '');
    };
    var peopleRows = items.some(function (c) { return c.people && c.people.known; })
      ? '<tr><th>Руководитель</th>' + items.map(function (c) { return '<td>' + who(c) + '</td>'; }).join('') + '</tr>' +
        '<tr><th>Учредители</th>' + items.map(function (c) { return '<td>' + owners(c) + '</td>'; }).join('') + '</tr>'
      : '';
    var body = ROWS.map(function (r) {
      var vals = items.map(function (c) { return c.missing ? null : r[1](c); });
      if (vals.every(function (v) { return v == null; })) return '';   // ни у кого нет данных — строку не показываем
      var nums = vals.filter(function (v) { return typeof v === 'number' && isFinite(v); });
      var best = r[3] && nums.length > 1 ? (r[3] > 0 ? Math.max.apply(null, nums) : Math.min.apply(null, nums)) : null;
      var tie = best != null && nums.filter(function (v) { return v === best; }).length > 1;
      return '<tr><th>' + esc(r[0]) + '</th>' + vals.map(function (v) {
        return '<td' + (best != null && !tie && v === best ? ' class="best"' : '') + '>' + r[2](v) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    var year = ok.length && ok[0].year;
    var nameOf = function (inn) { var c = items.filter(function (x) { return x.inn === inn; })[0]; return c && c.name ? c.name : 'ИНН ' + inn; };
    var links = (lk || []).map(function (l) {
      return '<li><b>' + esc(l.name) + '</b> — ' + l.roles.map(function (r) { return esc(r.role) + ' ' + esc(nameOf(r.inn)); }).join(', ') +
        (l.exact ? '' : ' <span class="note-sm">(совпадает ФИО)</span>') + '</li>';
    }).join('');
    out.innerHTML = (links ? '<div class="cmp-links"><p class="fns-sub">Общие люди и владельцы</p><ul>' + links + '</ul><p class="note-sm">Общий руководитель или учредитель — признак возможной взаимозависимости компаний (ст. 105.1 НК). Совпадение ФИО ещё не значит, что это один человек: сверьте ИНН в выписке ЕГРЮЛ.</p></div>' : '') +
      '<div class="tbl-wrap"><table class="fns-table cmp-table">' + head + peopleRows + body + '</table></div>' +
      '<p class="note-sm">Отмечено лучшее значение в строке. Доходы и прибыль — по отчётности за ' + (year || 'последний') + ' год, прибыль — доходы минус расходы до налога. ' +
      (items.some(function (c) { return c.missing; }) ? 'По части ИНН нет данных в нашей базе: сравнение строится по реестру малого и среднего бизнеса, куда не входят крупные компании, ИП, новые и закрытые организации. ' : '') +
      'Руководитель и учредители — по ЕГРЮЛ; суды и приставы — в полной проверке каждой компании.</p>';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var inns = ins.map(function (i) { return i.value.replace(/\D/g, ''); }).filter(Boolean);
    if (inns.length < 2 || inns.some(function (x) { return !/^\d{10}$/.test(x); })) { msg.textContent = 'Введите хотя бы два ИНН организаций — по 10 цифр.'; return; }
    msg.textContent = ''; out.innerHTML = '<p class="note-sm">Сравниваем…</p>';
    try { history.replaceState(null, '', '#' + inns.join(',')); } catch (x) {}
    fetch(api + '/api/compare', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ inns: inns }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.status = r.status; return j; }); })
      .then(function (j) {
        if (j.status !== 200) { out.innerHTML = ''; msg.textContent = j.error || 'Не получилось сравнить. Попробуйте позже.'; return; }
        render(j.items, j.links);
        if (window.innExcel) window.innExcel(out);
        if (window.goal) window.goal('compare');
      })
      .catch(function () { out.innerHTML = ''; msg.textContent = 'Сервер не ответил. Попробуйте позже.'; });
  });
  // #7707083893,7736207543 или #a=7707083893 (со страницы компании)
  var h = location.hash.slice(1).replace(/^a=/, '').split(',').filter(function (x) { return /^\d{10}$/.test(x); });
  h.slice(0, 3).forEach(function (x, i) { ins[i].value = x; });
  if (h.length >= 2) form.requestSubmit(); else if (h.length === 1) ins[1].focus();
})();

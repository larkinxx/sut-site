/* INNSIDER: страница «Налоговый календарь» (/nalogi/kalendar/). Сроки считает public/taxcal.js (window.TaxCal).
   Выбор хранится в браузере; вошедший может включить напоминания на почту — тогда профиль уходит на сервер аккаунтов. */
(function () {
  'use strict';
  var box = document.getElementById('taxcal');
  if (!box || !window.TaxCal) return;
  var ACCT = (document.documentElement.getAttribute('data-acct') || '').replace(/\/$/, '');
  var out = document.getElementById('tc-out'), remind = document.getElementById('tc-remind');
  var f = function (n) { return box.querySelector('[name="' + n + '"]'); };
  var MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  var KIND = { pay: 'Заплатить', report: 'Сдать', notice: 'Сдать' };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function plural(n, a, b, c) { var m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; }

  function profile() {
    var p = { who: f('who').value, regime: f('regime').value, staff: f('staff').checked, nds: f('nds').checked };
    if (p.regime === 'psn') { p.patentFrom = f('patentFrom').value; p.patentTo = f('patentTo').value; }
    return p;
  }
  function apply(p) {
    if (!p) return;
    if (p.who) f('who').value = p.who;
    if (p.regime) f('regime').value = p.regime;
    f('staff').checked = !!p.staff; f('nds').checked = !!p.nds;
    if (p.patentFrom) f('patentFrom').value = p.patentFrom;
    if (p.patentTo) f('patentTo').value = p.patentTo;
  }
  function sync() {
    var ip = f('who').value === 'ip', psnOpt = f('regime').querySelector('option[value="psn"]');
    psnOpt.disabled = !ip;
    if (!ip && f('regime').value === 'psn') f('regime').value = 'usn6';
    var psn = f('regime').value === 'psn', usn = /^usn/.test(f('regime').value);
    Array.prototype.forEach.call(box.querySelectorAll('[data-psn]'), function (x) { x.hidden = !psn; });
    box.querySelector('[data-nds]').hidden = !usn;
    if (!usn) f('nds').checked = false;
  }

  function render() {
    var now = new Date(), today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    var to = new Date(Date.UTC(now.getFullYear() + 1, now.getMonth(), now.getDate()));
    var p = profile(), list = window.TaxCal.deadlines(p, today, to);
    out.textContent = '';
    if (p.regime === 'psn' && !(p.patentFrom && p.patentTo)) out.appendChild(el('p', 'note-sm', 'Укажите срок патента — покажем, когда его оплатить.'));
    if (!list.length) { out.appendChild(el('p', 'note-sm', 'Сроков в ближайшие 12 месяцев нет.')); return; }
    var month = '', ul, day = '', items;
    list.forEach(function (e) {
      var d = new Date(e.date + 'T00:00:00Z');
      var m = MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
      if (m !== month) { month = m; out.appendChild(el('h3', 'tc-m', m)); ul = el('ul', 'tc-list'); out.appendChild(ul); day = ''; }
      if (e.date !== day) {
        day = e.date;
        var li = el('li'), left = Math.round((d - today) / 864e5);
        var head = el('p', 'tc-d');
        head.appendChild(el('b', null, d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })));
        head.appendChild(el('span', 'note-sm', left === 0 ? 'сегодня' : left === 1 ? 'завтра' : 'через ' + left + ' ' + plural(left, 'день', 'дня', 'дней')));
        li.appendChild(head); items = el('ul', 'tc-items'); li.appendChild(items); ul.appendChild(li);
      }
      var it = el('li'); it.appendChild(el('span', 'tc-k', KIND[e.kind])); it.appendChild(document.createTextNode(e.title)); items.appendChild(it);
    });
  }

  // напоминания на почту — только вошедшим, через сервер аккаунтов
  var me = null;
  function api(method, body) {
    return fetch(ACCT + '/api/me', { method: method, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }); });
  }
  function drawRemind(msg) {
    if (!ACCT) return;
    remind.textContent = '';
    var btn = function (text, fn) { var b = el('button', 'btn', text); b.type = 'button'; b.addEventListener('click', fn); remind.appendChild(b); };
    if (!me) {
      remind.appendChild(document.createTextNode('Напоминания на почту за 3 дня до срока — после входа. '));
      var a = el('a', null, 'Войти'); a.href = box.getAttribute('data-login') || '/vhod/'; remind.appendChild(a);
    } else if (!me.email) {
      remind.appendChild(document.createTextNode('Напоминания приходят на почту — войдите по коду на почту, чтобы привязать её к аккаунту.'));
    } else if (me.tax) {
      remind.appendChild(document.createTextNode('Напоминания включены: письмо на ' + me.email + ' за 3 дня до срока. '));
      btn('Выключить', function () { api('PATCH', { tax: null }).then(function (j) { me = j.user || me; drawRemind(); }); });
    } else {
      btn('Напоминать на почту за 3 дня', function () {
        api('PATCH', { tax: profile() }).then(function (j) { if (j.user) me = j.user; drawRemind(j.error); });
      });
    }
    if (msg) remind.appendChild(el('p', 'note-sm', msg));
  }

  var saved = null;
  try { saved = JSON.parse(localStorage.getItem('taxcal') || 'null'); } catch (e) {}
  apply(saved); sync(); render();
  box.addEventListener('change', function () {
    sync(); render();
    var p = profile();
    try { localStorage.setItem('taxcal', JSON.stringify(p)); } catch (e) {}
    // напоминания уже включены — сервер получает новый режим сразу
    if (me && me.tax) api('PATCH', { tax: p }).then(function (j) { if (j.user) me = j.user; });
  });
  if (ACCT) api('GET').then(function (j) {
    me = j.user || null;
    if (me && me.tax && !saved) { apply(me.tax); sync(); render(); }
    drawRemind();
  }, function () {});
})();

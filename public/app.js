/* Суть: небольшой скрипт без зависимостей.
   1) лента: окно 24 часа, время «N минут назад», фильтр по аудитории;
   2) страница новости: вкладки по аудиториям;
   3) калькуляторы ипотеки и вклада.
   Без скрипта сайт остаётся читаемым: все новости и все блоки видны. */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function plural(n, f) {
    var a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return f[0];
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return f[1];
    return f[2];
  }
  function ago(ms) {
    var min = Math.max(0, Math.floor(ms / 60000));
    if (min < 1) return 'только что';
    if (min < 60) return min + ' ' + plural(min, ['минуту', 'минуты', 'минут']) + ' назад';
    var h = Math.floor(min / 60);
    if (h < 24) return h + ' ' + plural(h, ['час', 'часа', 'часов']) + ' назад';
    var d = Math.floor(h / 24);
    return d + ' ' + plural(d, ['день', 'дня', 'дней']) + ' назад';
  }
  function rub(n) {
    return isFinite(n) ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' ₽' : '—';
  }

  /* ---------- Лента ---------- */
  var feed = $('#feed');
  if (feed) {
    var windowMs = (parseFloat(feed.getAttribute('data-window')) || 24) * 3600e3;
    var VISIBLE = 5;
    var items = $$('.item', feed);
    var filter = '*', showAll = false;
    var more = $('#more');
    var empty = $('#empty');
    var now = Date.now();

    items.forEach(function (it) {
      var age = now - Number(it.getAttribute('data-ts'));
      it.__fresh = age <= windowMs;
      var t = $('.ago', it);
      if (t) t.textContent = ago(age);
    });

    /* если за сутки ничего нет, показываем последние 5 новостей с пояснением */
    if (items.length && !items.some(function (it) { return it.__fresh; })) {
      items.slice().sort(function (a, b) { return Number(b.getAttribute('data-ts')) - Number(a.getAttribute('data-ts')); })
        .slice(0, VISIBLE).forEach(function (it) { it.__fresh = true; });
      var note = document.createElement('p');
      note.className = 'empty';
      note.textContent = 'За последние 24 часа новых материалов нет. Показываем последние опубликованные.';
      feed.parentNode.insertBefore(note, feed);
    }

    var render = function () {
      var list = items.filter(function (it) {
        if (!it.__fresh) return false;
        if (filter === '*') return true;
        var a = (it.getAttribute('data-affects') || '').split(' ');
        return a.indexOf(filter) > -1 || a.indexOf('all') > -1;
      });
      items.forEach(function (it) { it.hidden = true; });
      var shown = showAll ? list : list.slice(0, VISIBLE);
      shown.forEach(function (it) { it.hidden = false; });
      var rest = list.length - shown.length;
      if (more) {
        more.hidden = rest <= 0;
        more.textContent = 'Ещё ' + rest + ' ' + plural(rest, ['новость', 'новости', 'новостей']);
      }
      if (empty) empty.hidden = list.length > 0;
    };

    $$('#filters .chip').forEach(function (b) {
      b.addEventListener('click', function () {
        filter = b.getAttribute('data-f'); showAll = false;
        $$('#filters .chip').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        render();
      });
    });
    if (more) more.addEventListener('click', function () { showAll = true; render(); });
    render();
  } else {
    /* на других страницах тоже обновим «N минут назад» */
    $$('.ago[data-ts]').forEach(function (t) {
      t.textContent = ago(Date.now() - Number(t.getAttribute('data-ts')));
    });
  }

  /* ---------- Вкладки на странице новости ---------- */
  var tabsBox = $('#aud-tabs');
  if (tabsBox) {
    var secs = $$('.aud');
    if (secs.length > 1) {
      tabsBox.hidden = false;
      var pick = function (id) {
        secs.forEach(function (s) { s.hidden = s.id !== 'aud-' + id; });
        $$('.tab', tabsBox).forEach(function (t) { t.setAttribute('aria-selected', String(t.getAttribute('data-a') === id)); });
      };
      $$('.tab', tabsBox).forEach(function (t) {
        t.addEventListener('click', function () { pick(t.getAttribute('data-a')); });
      });
      pick(secs[0].id.replace('aud-', ''));
    }
  }

  /* ---------- Калькуляторы ---------- */
  function num(root, name) { return parseFloat($('[name=' + name + ']', root).value); }

  function annuity(S, years, ratePct) {
    var n = years * 12, r = ratePct / 100 / 12;
    if (!(S > 0) || !(n > 0) || ratePct < 0) return NaN;
    return r === 0 ? S / n : S * r / (1 - Math.pow(1 + r, -n));
  }

  $$('[data-calc=mortgage]').forEach(function (root) {
    var out = $('.result', root);
    var run = function () {
      var S = num(root, 'sum'), y = num(root, 'years'), a = num(root, 'old'), b = num(root, 'new');
      var p1 = annuity(S, y, a), p2 = annuity(S, y, b), total = (p1 - p2) * y * 12;
      out.innerHTML =
        '<div><span>Платёж сейчас</span><strong>' + rub(p1) + ' / мес.</strong></div>' +
        '<div><span>Платёж после изменения</span><strong>' + rub(p2) + ' / мес.</strong></div>' +
        '<div class="gain"><span>Разница за весь срок</span><strong>' + rub(total) + '</strong></div>';
    };
    $$('input', root).forEach(function (i) { i.addEventListener('input', run); });
    run();
  });

  $$('[data-calc=deposit]').forEach(function (root) {
    var out = $('.result', root);
    var run = function () {
      var S = num(root, 'sum'), rate = num(root, 'rate'), m = num(root, 'months'), infl = num(root, 'infl');
      var cap = $('[name=cap]', root).checked;
      if (!(S > 0) || !(m > 0) || rate < 0) { out.innerHTML = ''; return; }
      var r = rate / 100;
      var income = cap ? S * (Math.pow(1 + r / 12, m) - 1) : S * r * m / 12;
      var end = S + income;
      var real = end / Math.pow(1 + (isFinite(infl) ? infl : 0) / 100, m / 12);
      out.innerHTML =
        '<div><span>Доход за срок</span><strong>' + rub(income) + '</strong></div>' +
        '<div><span>Сумма в конце</span><strong>' + rub(end) + '</strong></div>' +
        '<div class="gain"><span>С поправкой на инфляцию</span><strong>' + rub(real) + '</strong></div>';
    };
    $$('input', root).forEach(function (i) { i.addEventListener('input', run); });
    run();
  });
})();

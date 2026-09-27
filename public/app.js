/* СверкаИНН: небольшой скрипт без зависимостей.
   1) лента: окно 24 часа, время «N минут назад», фильтр по аудитории;
   2) страница новости: вкладки по аудиториям;
   3) калькуляторы ипотеки и вклада.
   Без скрипта сайт остаётся читаемым: все новости и все блоки видны. */
(function () {
  'use strict';

  // Главная: поле «ИНН или название» в первом экране ведёт на страницу проверки
  var hero = document.getElementById('hero-org');
  if (hero) hero.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = document.getElementById('hero-inn').value.trim(), d = v.replace(/\s/g, '');
    if (!v) { document.getElementById('hero-inn').focus(); return; }
    var base = hero.getAttribute('action');
    location.href = /^(\d{10}|\d{12})$/.test(d) ? (hero.getAttribute('data-pages') ? base + d + '/' : base + '#inn=' + d) : base + '#q=' + encodeURIComponent(v);
  });
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---------- Тема оформления ---------- */
  var themeBtn = $('#theme-toggle');
  if (themeBtn) {
    var THEME_LIGHT = '#FFFFFF', THEME_DARK = '#0A0A0A';
    var meta = $('#theme-color-meta');
    var setMeta = function (dark) { if (meta) meta.setAttribute('content', dark ? THEME_DARK : THEME_LIGHT); };
    setMeta(document.documentElement.getAttribute('data-theme') === 'dark');
    themeBtn.addEventListener('click', function () {
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (isDark) {
        document.documentElement.removeAttribute('data-theme');
        try { localStorage.setItem('theme', 'light'); } catch (e) {}
      } else {
        document.documentElement.setAttribute('data-theme', 'dark');
        try { localStorage.setItem('theme', 'dark'); } catch (e) {}
      }
      setMeta(!isDark);
    });
  }

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

  /* ---------- Ближайшее решение ЦБ: считаем в браузере, чтобы дата не устаревала между сборками ---------- */
  var nextCbr = $('.next-cbr');
  if (nextCbr) {
    var today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // дата по Москве
    var next = (nextCbr.getAttribute('data-dates') || '').split(' ').filter(function (d) { return d >= today; })[0];
    if (next) {
      $('b', nextCbr).textContent = next === today ? 'сегодня' : new Date(next + 'T12:00:00+03:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });
    } else {
      nextCbr.hidden = true;
    }
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

  // Налоговые константы собирает build.mjs из config/finance.json
  var FIN = {};
  try { FIN = JSON.parse(($('#fin') || {}).textContent || '{}'); } catch (e) { FIN = {}; }
  function latestYear() {
    return Object.keys((FIN.depositTax && FIN.depositTax.freeLimit) || {}).sort().pop();
  }
  // НДФЛ с процентов за год: сверх лимита, 13% и 15% с части свыше порога
  function depositTax(income, year) {
    var t = FIN.depositTax, lim = t.freeLimit[year] || 0;
    var base = Math.max(0, income - lim);
    return base <= t.highFrom ? base * t.rate : t.highFrom * t.rate + (base - t.highFrom) * t.highRate;
  }
  function termRu(months) {
    var m = Math.ceil(months - 1e-9), y = Math.floor(m / 12), r = m % 12;
    return (y ? y + ' ' + plural(y, ['год', 'года', 'лет']) : '') + (y && r ? ' ' : '') + (r ? r + ' мес.' : '') || '0 мес.';
  }
  function row(label, value, cls) {
    return '<div' + (cls ? ' class="' + cls + '"' : '') + '><span>' + label + '</span><strong>' + value + '</strong></div>';
  }
  function bind(root, run) {
    $$('input, select', root).forEach(function (i) { i.addEventListener('input', run); i.addEventListener('change', run); });
    run();
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
        '<div class="gain"><span>С поправкой на инфляцию</span><strong>' + rub(real) + '</strong></div>' +
        (m <= 12 && FIN.depositTax ? '<div><span>Налог, если других вкладов нет</span><strong>' + rub(depositTax(income, latestYear())) + '</strong></div>' : '');
    };
    $$('input', root).forEach(function (i) { i.addEventListener('input', run); });
    run();
  });

  $$('[data-calc=depositTax]').forEach(function (root) {
    var out = $('.result', root);
    var run = function () {
      var S = num(root, 'sum'), rate = num(root, 'rate'), year = $('[name=year]', root).value;
      if (!(S >= 0) || !(rate >= 0) || !FIN.depositTax) { out.innerHTML = ''; return; }
      var income = S * rate / 100, lim = FIN.depositTax.freeLimit[year] || 0;
      var tax = depositTax(income, year);
      out.innerHTML =
        row('Проценты за год, примерно', rub(income)) +
        row('Не облагается в ' + year + ' году', rub(lim)) +
        row('Облагается', rub(Math.max(0, income - lim))) +
        row('Налог к уплате', rub(tax), tax > 0 ? 'warn' : 'gain') +
        (rate > 0 ? row('Без налога при ставке ' + rate + '% можно держать до', rub(lim / (rate / 100))) : '');
    };
    bind(root, run);
  });

  $$('[data-calc=prepay]').forEach(function (root) {
    var out = $('.result', root);
    var run = function () {
      var D = num(root, 'debt'), rate = num(root, 'rate'), y = num(root, 'years'), X = num(root, 'extra') || 0;
      var n = y * 12, r = rate / 100 / 12, P = annuity(D, y, rate);
      if (!isFinite(P) || X < 0) { out.innerHTML = ''; return; }
      var interest0 = P * n - D, S2 = D - X;
      var head = row('Платёж сейчас', rub(P) + ' / мес.') + row('Переплата по процентам сейчас', rub(interest0));
      if (S2 <= 0) {
        out.innerHTML = head + row('Этой суммы хватит, чтобы закрыть кредит', 'экономия ' + rub(interest0), 'gain');
        return;
      }
      // Сократить срок: платёж прежний, считаем, за сколько месяцев выплатится остаток
      var n2 = r === 0 ? S2 / P : -Math.log(1 - S2 * r / P) / Math.log(1 + r);
      var savedA = interest0 - (P * n2 - S2);
      // Уменьшить платёж: срок прежний
      var P2 = annuity(S2, y, rate), savedB = interest0 - (P2 * n - S2);
      var best = savedA >= savedB ? 'a' : 'b';
      out.innerHTML = head +
        '<div class="opt' + (best === 'a' ? ' best' : '') + '"><h3>Сократить срок</h3>' +
          row('Платёж', rub(P) + ' / мес.') + row('Срок', termRu(n2) + ' вместо ' + termRu(n)) +
          row('Экономия на процентах', rub(savedA), 'gain') + '</div>' +
        '<div class="opt' + (best === 'b' ? ' best' : '') + '"><h3>Уменьшить платёж</h3>' +
          row('Платёж', rub(P2) + ' / мес.') + row('Срок', 'прежний, ' + termRu(n)) +
          row('Экономия на процентах', rub(savedB), 'gain') + '</div>' +
        '<p class="verdict">Сокращение срока выгоднее на ' + rub(Math.abs(savedA - savedB)) + '. Уменьшение платежа имеет смысл, если нужен запас в месячном бюджете.</p>';
    };
    bind(root, run);
  });

  $$('[data-calc=selfemployed]').forEach(function (root) {
    var out = $('.result', root);
    var run = function () {
      var monthly = num(root, 'income'), share = Math.min(100, Math.max(0, num(root, 'legal') || 0)) / 100;
      var n = FIN.npd, ip = FIN.ip;
      if (!(monthly >= 0) || !n || !ip) { out.innerHTML = ''; return; }
      var inc = monthly * 12, fromPeople = inc * (1 - share), fromCompanies = inc * share;
      // НПД: разовый вычет снижает ставку (4→3%, 6→4%), пока не израсходованы 10 000 ₽
      var npd = fromPeople * n.rateIndividuals + fromCompanies * n.rateCompanies;
      npd -= Math.min(n.deduction, fromPeople * n.deductionRateIndividuals + fromCompanies * n.deductionRateCompanies);
      var npdOk = inc <= n.limit;
      // ИП на УСН 6%: взносы обязательны, налог уменьшается на всю их сумму
      var contrib = ip.fixed + Math.min(ip.extraMax, Math.max(0, inc - ip.extraFrom) * ip.extraRate);
      var usn = Math.max(0, inc * ip.usnRate - contrib), ipTotal = contrib + usn;
      var verdict = !npdOk
        ? 'Доход больше ' + rub(n.limit) + ' в год: самозанятым оставаться нельзя, подходит только ИП.'
        : npd < ipTotal
          ? 'Самозанятость дешевле на ' + rub(ipTotal - npd) + ' в год. Но у самозанятого не идёт пенсионный стаж, а у ИП взносы его дают.'
          : 'ИП на упрощёнке дешевле на ' + rub(npd - ipTotal) + ' в год, и взносы ИП идут в пенсионный стаж.';
      out.innerHTML =
        row('Доход за год', rub(inc)) +
        '<div class="opt' + (npdOk && npd <= ipTotal ? ' best' : '') + (npdOk ? '' : ' off') + '"><h3>Самозанятый</h3>' +
          row('Налог за год', npdOk ? rub(npd) : 'недоступно') + row('В среднем в месяц', npdOk ? rub(npd / 12) : '—') +
          row('Взносы', 'не обязательны') + '</div>' +
        '<div class="opt' + (!npdOk || ipTotal < npd ? ' best' : '') + '"><h3>ИП на УСН ' + ip.usnRate * 100 + '%</h3>' +
          row('Страховые взносы', rub(contrib)) + row('Налог после вычета взносов', rub(usn)) +
          row('Итого за год', rub(ipTotal)) + row('В среднем в месяц', rub(ipTotal / 12)) + '</div>' +
        '<p class="verdict">' + verdict + '</p>' +
        (inc > ip.ndsFrom ? '<p class="verdict warn">Доход больше ' + rub(ip.ndsFrom) + ' в год: на упрощёнке придётся платить ещё и НДС, он здесь не учтён.</p>' : '');
    };
    bind(root, run);
  });

  // Перспективы бизнеса: статистика похожих компаний с сервера (POST /api/market), окупаемость считаем здесь
  function money(n) {
    if (n == null || !isFinite(n)) return '—';
    var a = Math.abs(n), s = n < 0 ? '−' : '';
    if (a >= 1e9) return s + (a / 1e9).toFixed(1).replace('.', ',') + ' млрд ₽';
    if (a >= 1e6) return s + (a / 1e6).toFixed(1).replace('.', ',') + ' млн ₽';
    if (a >= 1e3) return s + Math.round(a / 1e3) + ' тыс. ₽';
    return s + Math.round(a) + ' ₽';
  }
  function pctRu(x) { return Math.round(x * 100) + '%'; }
  function ageBucket(y) { return y < 3 ? y : y < 5 ? 3 : 5; }   // y — год работы с нуля; группы как в server/market.mjs
  // За сколько лет накопленная прибыль сценария (квантиль qi) догонит бюджет; null — не за horizon лет
  function payback(m, qi, budget, horizon) {
    var sum = 0;
    for (var y = 0; y < horizon; y++) {
      var g = m.byAge.filter(function (a) { return a.age === ageBucket(y); })[0] || m.total;
      sum += g.profit[qi];
      if (sum >= budget) return { years: y + 1, sum: sum };
    }
    return { years: null, sum: sum };
  }
  $$('[data-calc=prospects]').forEach(function (root) {
    var out = $('.result', root), api = root.getAttribute('data-api'), cache = {}, timer, seq = 0;
    var draw = function (m) {
      var budget = num(root, 'budget') || 0, horizon = Math.min(5, Math.max(1, Math.round(num(root, 'years') || 3)));
      if (!m.available) {
        out.innerHTML = '<p class="verdict">По этой отрасли мало компаний с отчётностью — статистика была бы случайной. Попробуйте более общий код ОКВЭД или всю Россию.</p>';
        return;
      }
      var c = m.competition, where = m.region === '00' ? 'по России' : 'в регионе';
      var hist = c.history || [], trend = '';
      if (hist.length > 1 && hist[0].n > 0) {
        var ch = hist[hist.length - 1].n / hist[0].n - 1;
        trend = row('Число компаний с ' + hist[0].month.split('-').reverse().join('.'), (ch >= 0 ? '+' : '−') + Math.abs(Math.round(ch * 100)) + '%');
      }
      var rus = false;
      var rows = m.byAge.map(function (a) {
        var mark = a.scope === 'russia' ? '*' : '';
        if (mark) rus = true;
        return '<tr><td>' + a.label + mark + '</td><td>' + money(a.income[2]) + '<br><small>' + money(a.income[1]) + ' – ' + money(a.income[3]) + '</small></td>' +
          '<td' + (a.profit[2] < 0 ? ' class="bad"' : '') + '>' + money(a.profit[2]) + '</td><td>' + pctRu(a.profitableShare) + '</td></tr>';
      }).join('');
      var sc = [['Как у лучших 25%', 3], ['Как у середины', 2], ['Как у худших 25%', 1]].map(function (s) {
        var p = payback(m, s[1], budget, horizon);
        var text = budget <= 0 ? 'прибыль за ' + horizon + ' ' + plural(horizon, ['год', 'года', 'лет']) + ': ' + money(p.sum)
          : p.years ? 'окупится за ' + p.years + ' ' + plural(p.years, ['год', 'года', 'лет'])
          : p.sum > 0 ? 'за ' + horizon + ' ' + plural(horizon, ['год', 'года', 'лет']) + ' вернётся ' + money(p.sum) + ' из ' + money(budget)
          : 'убыток ' + money(p.sum) + ' за ' + horizon + ' ' + plural(horizon, ['год', 'года', 'лет']);
        return row(s[0], text, p.years ? 'gain' : p.sum <= 0 ? 'warn' : '');
      }).join('');
      out.innerHTML =
        row('Организаций этой отрасли ' + where, new Intl.NumberFormat('ru-RU').format(c.companies) + (m.total.scope === 'russia' && m.region !== '00' ? ' — мало для статистики, ниже данные по России' : '')) +
        (c.newShare != null && c.companies ? row('Из них открылись за последний год', pctRu(c.newShare)) : '') + trend +
        row('В плюсе по итогам ' + m.total.year + ' года', pctRu(m.total.profitableShare)) +
        (m.total.marginMedian != null ? row('Типичная рентабельность', Math.round(m.total.marginMedian * 100) + '% от доходов') : '') +
        '<figure style="overflow-x:auto;margin:0"><table class="fns-table all-cols"><tr><th>Год работы</th><th>Доходы: середина<br><small>и обычный разброс</small></th><th>Прибыль: середина</th><th>В плюсе</th></tr>' + rows + '</table></figure>' +
        (rus ? '<p class="note-sm">* В регионе мало таких компаний — показана та же отрасль по России.</p>' : '') +
        '<div class="opt"><h3>' + (budget > 0 ? 'Вернутся ли ' + money(budget) + ' за ' + horizon + ' ' + plural(horizon, ['год', 'года', 'лет']) : 'Прибыль за первые ' + horizon + ' ' + plural(horizon, ['год', 'года', 'лет'])) + '</h3>' + sc + '</div>' +
        '<p class="verdict">Это не прогноз вашего дохода: у похожих компаний сейчас такой разброс результатов. ' + (m.total.profitableShare < 0.6 ? 'Заметная часть работает в минус — заложите запас на первые годы.' : 'Большинство компаний в плюсе, но первые годы обычно слабее.') + '</p>';
    };
    var run = function () {
      var code = $('[name=code]', root).value.trim(), okved = (code.match(/^\d{2}/) || [])[0] || $('[name=okved]', root).value;
      var region = $('[name=region]', root).value, key = okved + '|' + region, my = ++seq;
      if (cache[key]) { draw(cache[key]); return; }
      if (!api) { out.innerHTML = ''; return; }
      clearTimeout(timer);
      timer = setTimeout(function () {
        out.innerHTML = '<p class="note-sm">Загружаем статистику…</p>';
        fetch(api + '/api/market', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ okved: okved, region: region }) })
          .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
          .then(function (m) { cache[key] = m; if (my === seq) draw(m); })
          .catch(function () { if (my === seq) out.innerHTML = '<p class="verdict warn">Не получилось загрузить статистику. Попробуйте позже.</p>'; });
      }, 300);
    };
    bind(root, run);
  });

  /* ---------- Поделиться расчётом: введённые цифры сохраняются в адресе после # ---------- */
  var calcs = $$('[data-calc]');
  function fieldsOf(root) { return $$('input[name], select[name]', root); }
  function linkFor(root) {
    var p = ['calc=' + encodeURIComponent(root.getAttribute('data-calc'))];
    fieldsOf(root).forEach(function (f) {
      p.push(encodeURIComponent(f.name) + '=' + encodeURIComponent(f.type === 'checkbox' ? (f.checked ? '1' : '0') : f.value));
    });
    return location.origin + location.pathname + '#' + p.join('&');
  }
  // Открыли ссылку с расчётом: подставляем цифры и пересчитываем
  var hash = {};
  location.hash.replace(/^#/, '').split('&').forEach(function (kv) {
    var i = kv.indexOf('=');
    if (i > 0) { try { hash[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1)); } catch (e) { /* битая ссылка */ } }
  });
  calcs.forEach(function (root) {
    if (hash.calc && hash.calc === root.getAttribute('data-calc')) {
      fieldsOf(root).forEach(function (f) {
        if (!(f.name in hash)) return;
        if (f.type === 'checkbox') f.checked = hash[f.name] === '1';
        else f.value = hash[f.name];
        f.dispatchEvent(new Event('input'));
      });
      hash.calc = null; // только первый подходящий калькулятор на странице
      if (root.scrollIntoView) root.scrollIntoView({ block: 'start' });
    }
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'share';
    btn.textContent = 'Поделиться расчётом';
    var note = document.createElement('span');
    note.className = 'share-note';
    note.setAttribute('aria-live', 'polite');
    btn.addEventListener('click', function () {
      var link = linkFor(root);
      var done = function (t) { note.textContent = t; setTimeout(function () { note.textContent = ''; }, 3000); };
      if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
        navigator.share({ title: document.title, url: link }).catch(function () {});
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(link).then(function () { done('Ссылка скопирована'); }, function () { window.prompt('Скопируйте ссылку:', link); });
      } else {
        window.prompt('Скопируйте ссылку:', link);
      }
    });
    var res = $('.result', root);
    var bar = document.createElement('div');
    bar.className = 'share-bar';
    bar.appendChild(btn);
    bar.appendChild(note);
    res.parentNode.insertBefore(bar, res.nextSibling);
  });

  /* ---------- Вход (необязательный): значок в шапке и «Сохранить расчёт» ---------- */
  var ACCT = (document.documentElement.getAttribute('data-acct') || '').replace(/\/$/, '');
  if (ACCT) {
    fetch(ACCT + '/api/me', { credentials: 'include' }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.user) return;
      var b = $('#acct-btn');
      if (b) { b.href = '/kabinet/'; b.title = 'Кабинет: ' + j.user.name; b.setAttribute('aria-label', 'Кабинет: ' + j.user.name); b.classList.add('on'); }
      $$('.share-bar').forEach(function (bar) {
        var root = bar.closest('[data-calc]');
        var btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'share'; btn.textContent = 'Сохранить расчёт';
        var note = $('.share-note', bar);
        btn.addEventListener('click', function () {
          var h = $('h2', root);
          var vals = fieldsOf(root).filter(function (f) { return f.type !== 'checkbox'; }).slice(0, 2).map(function (f) {
            return f.tagName === 'SELECT' ? f.value : new Intl.NumberFormat('ru-RU').format(Number(f.value) || 0);
          });
          btn.disabled = true;
          fetch(ACCT + '/api/calcs', {
            method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ calc: root.getAttribute('data-calc'), title: (h ? h.textContent : 'Расчёт') + ' · ' + vals.join(', '), link: linkFor(root) })
          }).then(function (r) { return r.json(); }).then(function (res) {
            note.textContent = res.ok ? 'Сохранено в кабинете' : (res.error || 'Не получилось сохранить');
            btn.disabled = false;
          }, function () { note.textContent = 'Не получилось сохранить'; btn.disabled = false; });
        });
        bar.insertBefore(btn, note);
      });
    }).catch(function () { /* сервер входа недоступен — сайт работает как обычно */ });
  }
})();

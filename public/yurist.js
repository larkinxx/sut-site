/* Документы по ИНН (/yurist/dokumenty/): реквизиты сторон из ЕГРЮЛ/ЕГРИП через наш сервер (POST /api/org, DaData),
   расчёт процентов по ст. 395 ГК по истории ключевой ставки (config/finance.json → keyRateHistory) и договорной неустойки,
   готовый документ — предпросмотр, файл Word (.docx, собирается здесь же, без сервера) и печать в PDF.
   Всё, что вводит пользователь, остаётся в браузере: на сервер уходят только ИНН для поиска реквизитов. */
(function () {
  'use strict';
  var root = document.getElementById('docs');
  if (!root) return;
  var api = root.getAttribute('data-api') || '';
  var RATES = {};
  try { RATES = JSON.parse(document.getElementById('docs-rates').textContent || '{}'); } catch (e) { RATES = {}; }
  var $ = function (id) { return document.getElementById(id); };
  var val = function (id) { var e = $(id); return e ? String(e.value || '').trim() : ''; };
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var DAY = 864e5;

  // ---------- числа и даты ----------
  var num = function (s) { var n = parseFloat(String(s || '').replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : NaN; };
  var rub = function (n) { return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.round(n * 100) / 100) + ' ₽'; };
  var pctf = function (n) { return String(n).replace('.', ',') + '%'; };
  var toMs = function (iso) { var m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(iso || ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };
  var iso = function (ms) { return new Date(ms).toISOString().slice(0, 10); };
  var ru = function (x) { var d = typeof x === 'number' ? iso(x) : x; return d ? d.slice(8, 10) + '.' + d.slice(5, 7) + '.' + d.slice(0, 4) : '___.___.______'; };
  var yearDays = function (y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365; };
  var plural = function (n, a, b, c) { var m = n % 100, k = n % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };

  // Проценты по ст. 395 ГК: ключевая ставка по периодам её действия, дни — включительно, в году 365 или 366 дней
  function calc395(debt, fromIso, toIso) {
    var from = toMs(fromIso), to = toMs(toIso);
    if (!(debt > 0) || !(to >= from)) return null;
    var hist = (RATES.keyRateHistory || []).map(function (h) { return { from: toMs(h.from), rate: h.rate }; });
    var approx = false;
    if (!hist.length) { hist = [{ from: -Infinity, rate: RATES.keyRate }]; approx = true; }
    if (from < hist[0].from) approx = true;
    var rateAt = function (ms) { var r = hist[0].rate; for (var i = 0; i < hist.length && hist[i].from <= ms; i++) r = hist[i].rate; return r; };
    // точки разбиения: смена ставки и начало календарного года
    var cuts = [];
    hist.forEach(function (h) { if (h.from > from && h.from <= to) cuts.push(h.from); });
    for (var y = new Date(from).getUTCFullYear() + 1; Date.UTC(y, 0, 1) <= to; y++) cuts.push(Date.UTC(y, 0, 1));
    cuts.sort(function (a, b) { return a - b; });
    var rows = [], start = from, total = 0;
    cuts.concat([to + DAY]).forEach(function (c) {
      if (c <= start) return;
      var end = c - DAY, days = Math.round((end - start) / DAY) + 1, rate = rateAt(start), yd = yearDays(new Date(start).getUTCFullYear());
      var sum = debt * rate / 100 * days / yd;
      rows.push({ from: start, to: end, days: days, rate: rate, yd: yd, sum: sum });
      total += sum; start = c;
    });
    return { rows: rows, total: Math.round(total * 100) / 100, days: Math.round((to - from) / DAY) + 1, approx: approx };
  }
  // Договорная неустойка: % от долга за каждый день просрочки, с ограничением в % от долга (если есть)
  function calcPenalty(debt, fromIso, toIso, perDay, capPct) {
    var from = toMs(fromIso), to = toMs(toIso);
    if (!(debt > 0) || !(to >= from) || !(perDay > 0)) return null;
    var days = Math.round((to - from) / DAY) + 1, sum = debt * perDay / 100 * days, capped = false;
    if (capPct > 0 && sum > debt * capPct / 100) { sum = debt * capPct / 100; capped = true; }
    return { days: days, total: Math.round(sum * 100) / 100, capped: capped };
  }

  // ---------- реквизиты сторон ----------
  var parties = {};
  function party(s) {
    var d = (s && s.data) || {}, ip = d.type === 'INDIVIDUAL', m = d.management || {};
    return {
      ip: ip,
      name: (d.name && d.name.short_with_opf) || s.value || '',
      full: (d.name && d.name.full_with_opf) || s.value || '',
      inn: d.inn || '', kpp: d.kpp || '', ogrn: d.ogrn || '',
      address: (d.address && (d.address.unrestricted_value || d.address.value)) || '',
      post: ip ? 'Индивидуальный предприниматель' : (m.post ? m.post.charAt(0).toUpperCase() + m.post.slice(1).toLowerCase() : 'Руководитель'),
      head: ip ? ((d.name && d.name.full) || s.value || '') : (m.name || '')
    };
  }
  function lookup(which) {
    var inn = val(which + '-inn').replace(/\D/g, ''), out = $(which + '-found');
    if (!/^(\d{10}|\d{12})$/.test(inn)) { out.textContent = 'ИНН — 10 цифр у организации или 12 у ИП.'; delete parties[which]; return; }
    if (!api) { out.textContent = 'Поиск реквизитов сейчас недоступен — заполните документ вручную после скачивания.'; return; }
    out.textContent = 'Ищем в ЕГРЮЛ…';
    fetch(api + '/api/org', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ inn: inn }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.status = r.status; return j; }); })
      .then(function (j) {
        if (j.status !== 200 || !j.suggestion) { out.textContent = j.error || 'Не нашли организацию с таким ИНН.'; delete parties[which]; return; }
        var p = parties[which] = party(j.suggestion);
        out.textContent = p.name + (p.head && !p.ip ? ' — ' + p.post.toLowerCase() + ' ' + p.head : '') + (p.address ? ', ' + p.address : '');
      })
      .catch(function () { out.textContent = 'Сервер не ответил. Попробуйте ещё раз.'; });
  }
  ['me', 'them'].forEach(function (w) {
    var i = $(w + '-inn');
    if (!i) return;
    i.addEventListener('change', function () { lookup(w); });
    i.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); lookup(w); } });
  });
  var blank = function (label) { return { ip: false, name: '_______________ (' + label + ')', full: '', inn: '__________', kpp: '', ogrn: '', address: '_______________', post: 'Руководитель', head: '_______________' }; };
  var P = function (w, label) { return parties[w] || blank(label); };
  var reqs = function (p) { return [p.full || p.name, 'ИНН ' + p.inn + (p.kpp ? ', КПП ' + p.kpp : ''), p.ogrn ? (p.ip ? 'ОГРНИП ' : 'ОГРН ') + p.ogrn : '', p.address ? 'Адрес: ' + p.address : ''].filter(Boolean); };
  var initials = function (fio) { var a = String(fio || '').trim().split(/\s+/); return a.length >= 2 ? a[0] + ' ' + a.slice(1).map(function (x) { return x.charAt(0) + '.'; }).join(' ') : fio || '_______________'; };
  var sign = function (p) { return { t: 'p', text: (p.ip ? 'Индивидуальный предприниматель' : p.post + ' ' + p.name) + '\t_______________ / ' + initials(p.head) + ' /', space: 18 }; };

  // ---------- документы: список блоков → предпросмотр и .docx ----------
  var B = {
    p: function (text, o) { o = o || {}; o.t = 'p'; o.text = text; return o; },
    table: function (rows, o) { o = o || {}; o.t = 'table'; o.rows = rows; return o; }
  };
  var today = iso(Date.now() + 3 * 3600e3);
  var lines = function (s) { return String(s || '').split(/\n+/).map(function (x) { return x.trim(); }).filter(Boolean); };

  function claim() {
    var me = P('me', 'ваша организация'), them = P('them', 'должник');
    var debt = num(val('c-debt')), from = val('c-from'), to = val('c-to') || today, kind = val('c-kind');
    if (!(debt > 0)) return 'Укажите сумму долга.';
    if (!from) return 'Укажите первый день просрочки — следующий день после срока оплаты по договору.';
    var extra = null, p395 = null;
    if (kind === 'penalty') {
      extra = calcPenalty(debt, from, to, num(val('c-rate')), num(val('c-cap')));
      if (!extra) return 'Укажите неустойку из договора: процент в день.';
    } else {
      p395 = calc395(debt, from, to);
      if (!p395) return 'Проверьте даты: день начала просрочки должен быть не позже даты расчёта.';
    }
    var add = extra ? extra.total : p395.total, days = extra ? extra.days : p395.days, dn = val('c-num') || '___', dd = val('c-date');
    var term = Math.max(1, Math.round(num(val('c-term')) || 10));
    var b = [
      B.p('Кому:', { align: 'right', b: true }), ].concat(
      reqs(them).map(function (x) { return B.p(x, { align: 'right' }); }),
      [B.p(them.ip ? '' : (them.post + ' ' + them.head), { align: 'right' }), B.p('От:', { align: 'right', b: true })],
      reqs(me).map(function (x) { return B.p(x, { align: 'right' }); }),
      [B.p('Исх. № ____ от ' + ru(today)),
        B.p('ПРЕТЕНЗИЯ', { align: 'center', b: true, space: 12 }),
        B.p('о погашении задолженности по договору № ' + dn + (dd ? ' от ' + ru(dd) : ''), { align: 'center', b: true }),
        B.p('Между ' + me.name + ' и ' + them.name + ' заключён договор № ' + dn + (dd ? ' от ' + ru(dd) : '') + ' (далее — Договор). ' + me.name + ' исполнил(о) свои обязательства по Договору' + (val('c-docs') ? ', что подтверждается следующими документами: ' + val('c-docs') : '') + '.', { indent: true, align: 'both' }),
        B.p('Срок оплаты по Договору истёк, однако оплата в полном объёме не произведена. Задолженность ' + them.name + ' перед ' + me.name + ' составляет ' + rub(debt) + '. Просрочка — с ' + ru(from) + '.', { indent: true, align: 'both' }),
        B.p('В соответствии со статьями 309 и 310 Гражданского кодекса Российской Федерации обязательства должны исполняться надлежащим образом в соответствии с условиями договора, односторонний отказ от исполнения обязательства не допускается.', { indent: true, align: 'both' }),
        extra
          ? B.p('Договором (' + (val('c-point') ? 'пункт ' + val('c-point') : 'пункт ___') + ') за просрочку оплаты предусмотрена неустойка в размере ' + pctf(num(val('c-rate'))) + ' от неоплаченной суммы за каждый день просрочки' + (num(val('c-cap')) > 0 ? ', но не более ' + pctf(num(val('c-cap'))) + ' от неоплаченной суммы' : '') + '. За период с ' + ru(from) + ' по ' + ru(to) + ' (' + days + ' ' + plural(days, 'день', 'дня', 'дней') + ') неустойка составляет ' + rub(extra.total) + ' (статья 330 ГК РФ).', { indent: true, align: 'both' })
          : B.p('На сумму долга подлежат начислению проценты за пользование чужими денежными средствами по статье 395 ГК РФ в размере ключевой ставки Банка России, действовавшей в соответствующие периоды. За период с ' + ru(from) + ' по ' + ru(to) + ' (' + days + ' ' + plural(days, 'день', 'дня', 'дней') + ') проценты составляют ' + rub(p395.total) + '. Расчёт приведён в приложении.', { indent: true, align: 'both' }),
        B.p('На основании изложенного требуем в течение ' + term + ' ' + plural(term, 'календарного дня', 'календарных дней', 'календарных дней') + ' со дня получения настоящей претензии перечислить ' + me.name + ' задолженность в размере ' + rub(debt) + ' и ' + (extra ? 'неустойку' : 'проценты') + ' в размере ' + rub(add) + ', всего ' + rub(debt + add) + '. ' + (extra ? 'Неустойка' : 'Проценты') + ' продолжают начисляться до дня фактической оплаты долга.', { indent: true, align: 'both' }),
        B.p('Если требования не будут исполнены, ' + me.name + ' обратится в арбитражный суд с иском о взыскании задолженности, ' + (extra ? 'неустойки' : 'процентов') + ' и судебных расходов, включая государственную пошлину и расходы на представителя. Спор может быть передан в арбитражный суд по истечении 30 календарных дней со дня направления претензии, если иные срок и порядок не установлены Договором (часть 5 статьи 4 АПК РФ).', { indent: true, align: 'both' }),
        B.p('Приложение: ' + (extra ? '' : 'расчёт процентов по статье 395 ГК РФ; ') + 'копии документов, подтверждающих задолженность.', { indent: true }),
        sign(me)]);
    if (p395) {
      b.push(B.p('Приложение. Расчёт процентов по статье 395 ГК РФ', { b: true, align: 'center', space: 18, pageBreak: true }));
      b.push(B.p('Сумма долга: ' + rub(debt) + '. Период: с ' + ru(from) + ' по ' + ru(to) + '. Формула: долг × ключевая ставка × дни / дней в году.'));
      b.push(B.table([['Период', 'Дней', 'Ставка', 'Дней в году', 'Проценты']].concat(p395.rows.map(function (r) {
        return [ru(r.from) + ' – ' + ru(r.to), String(r.days), pctf(r.rate), String(r.yd), rub(r.sum)];
      }), [['Итого', String(p395.days), '', '', rub(p395.total)]]), { head: true, widths: [34, 12, 14, 16, 24] }));
    }
    return { title: 'Претензия о долге', file: 'pretenziya-' + (them.inn || 'dolg'), blocks: b, warn: p395 && p395.approx ? 'Нет полной истории ключевой ставки за этот период — проценты посчитаны приблизительно. Сверьте расчёт с калькулятором на сайте суда или consultant.ru.' : '' };
  }

  function reconciliation() {
    var me = P('me', 'ваша организация'), them = P('them', 'контрагент');
    var from = val('a-from'), to = val('a-to') || today, open = num(val('a-open')) || 0;
    if (!from) return 'Укажите начало периода сверки.';
    var ops = [].slice.call(document.querySelectorAll('#a-rows .a-row')).map(function (r) {
      var q = function (c) { var e = r.querySelector(c); return e ? String(e.value || '').trim() : ''; };
      return { date: q('.a-date'), doc: q('.a-doc'), sum: num(q('.a-sum')), kind: q('.a-kind') };
    }).filter(function (o) { return o.sum > 0; });
    ops.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var deb = 0, cred = 0;
    var money = function (n) { return n ? rub(n) : ''; };
    var rows = [['Дата', 'Документ', 'Дебет', 'Кредит', 'Дата', 'Документ', 'Дебет', 'Кредит'],
      ['', 'Сальдо на ' + ru(from), money(open > 0 ? open : 0), money(open < 0 ? -open : 0), '', '', '', '']];
    ops.forEach(function (o) {
      var d = o.kind === 'pay' ? 0 : o.sum, c = o.kind === 'pay' ? o.sum : 0;
      deb += d; cred += c;
      rows.push([ru(o.date), o.doc, money(d), money(c), '', '', '', '']);
    });
    var close = open + deb - cred;
    rows.push(['', 'Обороты за период', money(deb), money(cred), '', '', '', '']);
    rows.push(['', 'Сальдо на ' + ru(to), money(close > 0 ? close : 0), money(close < 0 ? -close : 0), '', '', '', '']);
    var result = Math.abs(close) < 0.005 ? 'задолженность отсутствует' : 'задолженность в пользу ' + (close > 0 ? me.name : them.name) + ' составляет ' + rub(Math.abs(close));
    var b = [
      B.p('АКТ СВЕРКИ ВЗАИМНЫХ РАСЧЁТОВ', { align: 'center', b: true }),
      B.p('за период с ' + ru(from) + ' по ' + ru(to), { align: 'center' }),
      B.p('между ' + me.name + ' и ' + them.name + (val('a-contract') ? ' по договору ' + val('a-contract') : ''), { align: 'center' }),
      B.p('Мы, нижеподписавшиеся, ' + (me.ip ? 'индивидуальный предприниматель ' + me.head : me.post.toLowerCase() + ' ' + me.name + ' ' + me.head) + ', с одной стороны, и ' + (them.ip ? 'индивидуальный предприниматель ' + them.head : them.post.toLowerCase() + ' ' + them.name + ' ' + them.head) + ', с другой стороны, составили настоящий акт о том, что состояние взаимных расчётов по данным учёта следующее:', { indent: true, align: 'both', space: 12 }),
      B.table([['По данным ' + me.name, '', '', '', 'По данным ' + them.name, '', '', '']].concat(rows), { head: true, small: true, widths: [10, 20, 10, 10, 10, 20, 10, 10], merge: [[0, 0, 4], [0, 4, 4]] }),
      B.p('По данным ' + me.name + ' на ' + ru(to) + ' ' + result + '.', { indent: true, space: 12 }),
      B.p('Правая часть акта заполняется ' + them.name + '. Расхождения просим указать и вернуть подписанный экземпляр.', { indent: true }),
      B.p('От ' + me.name, { b: true, space: 18 }), sign(me),
      B.p('От ' + them.name, { b: true, space: 12 }), sign(them)
    ];
    return { title: 'Акт сверки', file: 'akt-sverki-' + (them.inn || ''), blocks: b };
  }

  function taxAnswer() {
    var me = P('me', 'ваша организация'), kind = val('t-kind');
    var n = val('t-num') || '___', d = val('t-date'), ifns = val('t-ifns') || '_______________ (инспекция из требования)';
    var b = [B.p('В ' + ifns, { align: 'right' }), B.p('от', { align: 'right' })]
      .concat(reqs(me).map(function (x) { return B.p(x, { align: 'right' }); }))
      .concat([B.p('Исх. № ____ от ' + ru(today)),
        B.p('Ответ на требование № ' + n + (d ? ' от ' + ru(d) : ''), { align: 'center', b: true, space: 12 })]);
    if (kind === 'docs') {
      var list = lines(val('t-list'));
      if (!list.length) return 'Перечислите документы, которые направляете, — по одному в строке.';
      b.push(B.p('В ответ на требование № ' + n + (d ? ' от ' + ru(d) : '') + ' о представлении документов (информации) ' + me.name + ' направляет следующие документы:', { indent: true, align: 'both' }));
      list.forEach(function (x, i) { b.push(B.p((i + 1) + '. ' + x, { indent: true })); });
      if (val('t-missing')) b.push(B.p('Часть истребованных документов не может быть представлена по следующим причинам: ' + val('t-missing'), { indent: true, align: 'both' }));
      b.push(B.p('Копии документов заверены ' + (me.ip ? 'индивидуальным предпринимателем' : 'руководителем организации') + '.', { indent: true }));
    } else {
      var text = lines(val('t-text'));
      if (!text.length) return 'Напишите пояснения по существу вопросов из требования.';
      b.push(B.p('В ответ на требование № ' + n + (d ? ' от ' + ru(d) : '') + ' о представлении пояснений ' + (val('t-about') ? 'по ' + val('t-about') + ' ' : '') + me.name + ' сообщает следующее.', { indent: true, align: 'both' }));
      text.forEach(function (x) { b.push(B.p(x, { indent: true, align: 'both' })); });
    }
    b.push(sign(me));
    return { title: 'Ответ на требование налоговой', file: 'otvet-na-trebovanie-' + n.replace(/[^\w-]+/g, ''), blocks: b };
  }

  function termination() {
    var me = P('me', 'ваша организация'), them = P('them', 'контрагент');
    var dn = val('r-num') || '___', dd = val('r-date'), mode = val('r-mode'), reason = val('r-reason'), ask = val('r-ask');
    var head = [B.p('Кому:', { align: 'right', b: true })].concat(reqs(them).map(function (x) { return B.p(x, { align: 'right' }); }),
      [B.p('От:', { align: 'right', b: true })], reqs(me).map(function (x) { return B.p(x, { align: 'right' }); }), [B.p('Исх. № ____ от ' + ru(today))]);
    var contract = 'договор № ' + dn + (dd ? ' от ' + ru(dd) : '');
    var b;
    if (mode === 'offer') {
      var until = val('r-until');
      b = head.concat([
        B.p('ПРЕДЛОЖЕНИЕ О РАСТОРЖЕНИИ ДОГОВОРА', { align: 'center', b: true, space: 12 }),
        B.p('Между ' + me.name + ' и ' + them.name + ' заключён ' + contract + ' (далее — Договор).', { indent: true, align: 'both' }),
        reason ? B.p(reason, { indent: true, align: 'both' }) : null,
        B.p('На основании пункта 1 статьи 450 ГК РФ ' + me.name + ' предлагает расторгнуть Договор по соглашению сторон' + (val('r-end') ? ' с ' + ru(val('r-end')) : '') + '. Просим рассмотреть предложение и ' + (until ? 'до ' + ru(until) : 'в течение 30 дней') + ' подписать соглашение о расторжении либо сообщить о своём решении.', { indent: true, align: 'both' }),
        ask ? B.p(ask, { indent: true, align: 'both' }) : null,
        B.p('Если ответ не будет получен в этот срок, ' + me.name + ' вправе обратиться в суд с требованием о расторжении Договора при наличии оснований, предусмотренных пунктом 2 статьи 450 ГК РФ (пункт 2 статьи 452 ГК РФ).', { indent: true, align: 'both' }),
        sign(me)
      ]);
    } else {
      b = head.concat([
        B.p('УВЕДОМЛЕНИЕ', { align: 'center', b: true, space: 12 }),
        B.p('об одностороннем отказе от исполнения договора', { align: 'center', b: true }),
        B.p('Между ' + me.name + ' и ' + them.name + ' заключён ' + contract + ' (далее — Договор).', { indent: true, align: 'both' }),
        B.p('В соответствии с ' + (val('r-point') ? 'пунктом ' + val('r-point') + ' Договора и ' : '') + 'статьёй 450.1 ГК РФ ' + me.name + ' уведомляет об одностороннем отказе от исполнения Договора' + (reason ? ' в связи с тем, что ' + reason.replace(/^[А-ЯЁ]/, function (c) { return c.toLowerCase(); }).replace(/\.$/, '') : '') + '.', { indent: true, align: 'both' }),
        B.p(val('r-end') ? 'Договор считается прекращённым с ' + ru(val('r-end')) + '.' : 'Договор считается прекращённым с момента получения настоящего уведомления (пункт 1 статьи 450.1 ГК РФ).', { indent: true, align: 'both' }),
        ask ? B.p(ask, { indent: true, align: 'both' }) : null,
        sign(me)
      ]);
    }
    return { title: mode === 'offer' ? 'Предложение о расторжении' : 'Уведомление об отказе от договора', file: 'rastorzhenie-' + (them.inn || ''), blocks: b.filter(Boolean) };
  }

  function selfEmployed() {
    var me = P('me', 'заказчик'), fio = val('s-fio'), sinn = val('s-inn').replace(/\D/g, '');
    if (!fio) return 'Укажите ФИО исполнителя.';
    if (sinn && !/^\d{12}$/.test(sinn)) return 'ИНН самозанятого — 12 цифр.';
    var what = val('s-what'), price = num(val('s-price')), pay = Math.max(1, Math.round(num(val('s-pay')) || 5));
    if (!what) return 'Опишите, какие услуги или работы нужны.';
    if (!(price > 0)) return 'Укажите цену услуг.';
    var city = val('s-city') || '_______________', end = val('s-end');
    var n = 0, sec = function (t) { n++; return B.p(n + '. ' + t, { b: true, align: 'center', space: 10 }); }, k = 0, pt = function (t) { k++; return B.p(n + '.' + k + '. ' + t, { indent: true, align: 'both' }); };
    var sect = function (t) { k = 0; return sec(t); };
    var b = [
      B.p('ДОГОВОР ВОЗМЕЗДНОГО ОКАЗАНИЯ УСЛУГ № ____', { align: 'center', b: true }),
      B.p('г. ' + city + '\t' + ru(today), { space: 6 }),
      B.p(me.full + ', ' + (me.ip ? 'именуемый(ая)' : 'именуемое') + ' в дальнейшем «Заказчик», в лице ' + (me.ip ? 'индивидуального предпринимателя ' + me.head + ', действующего на основании свидетельства о государственной регистрации' : me.post.toLowerCase() + ' ' + me.head + ', действующего на основании устава') + ', с одной стороны, и ' + fio + (sinn ? ' (ИНН ' + sinn + ')' : '') + ', применяющий(ая) специальный налоговый режим «Налог на профессиональный доход» (Федеральный закон от 27.11.2018 № 422-ФЗ), именуемый(ая) в дальнейшем «Исполнитель», с другой стороны, заключили настоящий договор (далее — Договор) о нижеследующем.', { indent: true, align: 'both' }),
      sect('Предмет договора'),
      pt('Исполнитель обязуется по заданию Заказчика оказать следующие услуги: ' + what.replace(/\.$/, '') + ' (далее — Услуги), а Заказчик обязуется принять и оплатить Услуги.'),
      pt('Срок оказания Услуг: ' + (end ? 'до ' + ru(end) : 'в течение ____ дней с даты подписания Договора') + '. Результат оказания Услуг: ' + (val('s-result') || 'согласно заданию Заказчика') + '.'),
      sect('Порядок оказания услуг'),
      pt('Исполнитель оказывает Услуги лично, самостоятельно определяет способ, время и место оказания Услуг и использует собственные оборудование и материалы, если иное не согласовано Сторонами.'),
      pt('Исполнитель не подчиняется правилам внутреннего трудового распорядка Заказчика, не включается в его штат, и на него не распространяются гарантии трудового законодательства. Отношения Сторон регулируются главой 39 Гражданского кодекса РФ.'),
      pt('Заказчик вправе проверять ход и качество оказания Услуг, не вмешиваясь в деятельность Исполнителя.'),
      sect('Приёмка услуг'),
      pt('По окончании оказания Услуг Стороны подписывают акт об оказании услуг. Заказчик в течение 5 (пяти) рабочих дней со дня получения акта подписывает его или направляет Исполнителю мотивированный отказ.'),
      sect('Цена и порядок расчётов'),
      pt('Цена Услуг составляет ' + rub(price) + '. НДС не облагается в связи с применением Исполнителем налога на профессиональный доход.'),
      pt('Заказчик оплачивает Услуги в течение ' + pay + ' ' + plural(pay, 'рабочего дня', 'рабочих дней', 'рабочих дней') + ' после подписания акта об оказании услуг путём перечисления денежных средств на счёт Исполнителя.'),
      pt('Исполнитель формирует в приложении «Мой налог» чек на полученную сумму и передаёт его Заказчику в сроки, установленные статьёй 14 Федерального закона № 422-ФЗ.'),
      sect('Статус исполнителя'),
      pt('Исполнитель подтверждает, что на дату заключения Договора состоит на учёте в налоговом органе в качестве плательщика налога на профессиональный доход и не являлся работником Заказчика в течение двух лет до заключения Договора.'),
      pt('Исполнитель обязуется уведомить Заказчика о снятии с учёта в качестве плательщика налога на профессиональный доход или утрате права на его применение не позднее следующего рабочего дня. Если Исполнитель не уведомил Заказчика или не передал чек, он возмещает Заказчику налоги, взносы, пени и штрафы, начисленные Заказчику в связи с выплатами по Договору.'),
      sect('Ответственность и расторжение'),
      pt('За неисполнение или ненадлежащее исполнение Договора Стороны несут ответственность в соответствии с законодательством Российской Федерации.'),
      pt('Заказчик вправе отказаться от Договора при условии оплаты Исполнителю фактически понесённых им расходов, Исполнитель — при условии полного возмещения Заказчику убытков (статья 782 ГК РФ).'),
      pt('Споры разрешаются путём переговоров, а при недостижении согласия — в суде в порядке, установленном законодательством Российской Федерации.'),
      sect('Реквизиты и подписи сторон'),
      B.table([['Заказчик', 'Исполнитель'], [reqs(me).join('\n'), fio + (sinn ? '\nИНН ' + sinn : '') + '\nПлательщик налога на профессиональный доход' + (val('s-bank') ? '\n' + val('s-bank') : '\nСчёт: _______________')],
        ['_______________ / ' + initials(me.head) + ' /', '_______________ / ' + initials(fio) + ' /']], { head: true, widths: [50, 50] })
    ];
    return { title: 'Договор с самозанятым', file: 'dogovor-samozanyatyi', blocks: b };
  }

  var DOCS = { claim: claim, akt: reconciliation, tax: taxAnswer, end: termination, npd: selfEmployed };

  // ---------- предпросмотр ----------
  function html(doc) {
    return doc.blocks.map(function (x) {
      if (x.t === 'table') {
        var merged = {};
        (x.merge || []).forEach(function (m) { merged[m[0] + ':' + m[1]] = m[2]; for (var i = 1; i < m[2]; i++) merged[m[0] + ':' + (m[1] + i)] = -1; });
        return '<table class="doc-table' + (x.small ? ' small' : '') + '">' + x.rows.map(function (r, ri) {
          return '<tr>' + r.map(function (c, ci) {
            var m = merged[ri + ':' + ci]; if (m === -1) return '';
            var tag = x.head && ri === 0 ? 'th' : 'td';
            return '<' + tag + (m ? ' colspan="' + m + '"' : '') + '>' + esc(c).replace(/\n/g, '<br>') + '</' + tag + '>';
          }).join('') + '</tr>';
        }).join('') + '</table>';
      }
      var cls = [x.align ? 'a-' + x.align : '', x.b ? 'b' : '', x.indent ? 'ind' : '', x.pageBreak ? 'pb' : ''].filter(Boolean).join(' ');
      return '<p' + (cls ? ' class="' + cls + '"' : '') + (x.space ? ' style="margin-top:' + x.space + 'px"' : '') + '>' + esc(x.text).replace(/\t/g, ' ') + '</p>';
    }).join('');
  }

  // ---------- Word (.docx) ----------
  var CRC = (function () { var t = [], c; for (var n = 0; n < 256; n++) { c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { var c = 0xffffffff; for (var i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function zip(files, type) {
    var enc = new TextEncoder(), parts = [], dir = [], off = 0;
    var u16 = function (v) { return [v & 255, (v >>> 8) & 255]; }, u32 = function (v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; };
    files.forEach(function (f) {
      var name = enc.encode(f[0]), data = enc.encode(f[1]), crc = crc32(data);
      var head = [].concat(u32(0x04034b50), u16(20), u16(0x800), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0));
      parts.push(new Uint8Array(head), name, data);
      dir.push(new Uint8Array([].concat(u32(0x02014b50), u16(20), u16(20), u16(0x800), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off))), name);
      off += head.length + name.length + data.length;
    });
    var size = dir.reduce(function (s, d) { return s + d.length; }, 0);
    var end = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(size), u32(off), u16(0)));
    return new Blob(parts.concat(dir, [end]), { type: type });
  }
  var xe = function (t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  function runs(text, o) {
    var rpr = '<w:rPr>' + (o.b ? '<w:b/>' : '') + (o.small ? '<w:sz w:val="18"/>' : '') + '</w:rPr>';
    return String(text).split('\n').map(function (line, i) {
      return (i ? '<w:r><w:br/></w:r>' : '') + line.split('\t').map(function (seg, j) {
        return (j ? '<w:r><w:tab/></w:r>' : '') + '<w:r>' + rpr + '<w:t xml:space="preserve">' + xe(seg) + '</w:t></w:r>';
      }).join('');
    }).join('');
  }
  function para(x) {
    var ppr = '<w:pPr>' + (x.pageBreak ? '<w:pageBreakBefore/>' : '') + '<w:tabs><w:tab w:val="right" w:pos="9355"/></w:tabs><w:spacing w:before="' + ((x.space || 0) * 15) + '" w:after="60"/>' +
      (x.indent ? '<w:ind w:firstLine="709"/>' : '') + (x.align ? '<w:jc w:val="' + x.align + '"/>' : '') + '</w:pPr>';
    return '<w:p>' + ppr + runs(x.text || '', x) + '</w:p>';
  }
  function table(x) {
    var total = 9355, ws = x.widths.map(function (w) { return Math.round(total * w / 100); });
    var merged = {};
    (x.merge || []).forEach(function (m) { merged[m[0] + ':' + m[1]] = m[2]; for (var i = 1; i < m[2]; i++) merged[m[0] + ':' + (m[1] + i)] = -1; });
    var b = '<w:top w:val="single" w:sz="4" w:color="000000"/><w:left w:val="single" w:sz="4" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:color="000000"/><w:right w:val="single" w:sz="4" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:color="000000"/>';
    return '<w:tbl><w:tblPr><w:tblW w:w="' + total + '" w:type="dxa"/><w:tblBorders>' + b + '</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>' +
      ws.map(function (w) { return '<w:gridCol w:w="' + w + '"/>'; }).join('') + '</w:tblGrid>' +
      x.rows.map(function (r, ri) {
        return '<w:tr>' + r.map(function (c, ci) {
          var m = merged[ri + ':' + ci]; if (m === -1) return '';
          var w = m ? ws.slice(ci, ci + m).reduce(function (s, v) { return s + v; }, 0) : ws[ci];
          return '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/>' + (m ? '<w:gridSpan w:val="' + m + '"/>' : '') + '</w:tcPr>' +
            '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>' + runs(c, { b: x.head && ri === 0, small: x.small }) + '</w:p></w:tc>';
        }).join('') + '</w:tr>';
      }).join('') + '</w:tbl><w:p/>';
  }
  function docx(doc) {
    var body = doc.blocks.map(function (x) { return x.t === 'table' ? table(x) : para(x); }).join('');
    var W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    var x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    return zip([
      ['[Content_Types].xml', x + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'],
      ['_rels/.rels', x + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
      ['word/_rels/document.xml.rels', x + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
      ['word/styles.xml', x + '<w:styles ' + W + '><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman" w:eastAsia="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>'],
      ['word/document.xml', x + '<w:document ' + W + '><w:body>' + body + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>']
    ], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  }

  // ---------- интерфейс ----------
  var form = $('docs-form'), out = $('docs-out'), msg = $('docs-msg'), kindSel = $('doc-kind');
  function show() {
    var k = kindSel.value;
    [].forEach.call(root.querySelectorAll('[data-for]'), function (el) { el.hidden = el.getAttribute('data-for').split(' ').indexOf(k) < 0; });
    out.innerHTML = ''; msg.textContent = '';
  }
  kindSel.addEventListener('change', show);
  var ck = $('c-kind');
  if (ck) ck.addEventListener('change', function () { [].forEach.call(root.querySelectorAll('.c-pen'), function (e) { e.hidden = ck.value !== 'penalty'; }); });
  var tk = $('t-kind');
  if (tk) tk.addEventListener('change', function () { [].forEach.call(root.querySelectorAll('[data-t]'), function (e) { e.hidden = e.getAttribute('data-t') !== tk.value; }); });
  var rm = $('r-mode');
  if (rm) rm.addEventListener('change', function () { [].forEach.call(root.querySelectorAll('[data-r]'), function (e) { e.hidden = e.getAttribute('data-r') !== rm.value; }); });
  var addRow = $('a-add');
  if (addRow) addRow.addEventListener('click', function () {
    var tpl = document.querySelector('#a-rows .a-row'), row = tpl.cloneNode(true);
    [].forEach.call(row.querySelectorAll('input'), function (i) { i.value = ''; });
    $('a-rows').appendChild(row);
  });
  var params = new URLSearchParams(location.hash.slice(1));
  if (params.get('doc') && DOCS[params.get('doc')]) kindSel.value = params.get('doc');
  show();

  var current = null;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var r = DOCS[kindSel.value]();
    if (typeof r === 'string') { msg.textContent = r; out.innerHTML = ''; current = null; return; }
    msg.textContent = '';
    current = r;
    var missing = [];
    if (!parties.me) missing.push('ваших реквизитов');
    if (kindSel.value !== 'tax' && kindSel.value !== 'npd' && !parties.them) missing.push('реквизитов контрагента');
    out.innerHTML = (r.warn ? '<p class="verdict warn">' + esc(r.warn) + '</p>' : '') +
      (missing.length ? '<p class="note-sm">Нет ' + missing.join(' и ') + ' — в документе оставлены пропуски для заполнения. Введите ИНН и нажмите Enter, чтобы подставить их из ЕГРЮЛ.</p>' : '') +
      '<p class="doc-actions"><button class="btn" type="button" id="doc-word">Скачать Word</button> <button class="btn btn-ghost" type="button" id="doc-print">Печать или PDF</button></p>' +
      '<article class="doc-sheet" id="doc-sheet">' + html(r) + '</article>';
    $('doc-word').addEventListener('click', function () {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(docx(current));
      a.download = current.file + '.docx';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      if (window.goal) window.goal('doc');
    });
    $('doc-print').addEventListener('click', function () { document.body.classList.add('print-doc'); window.print(); setTimeout(function () { document.body.classList.remove('print-doc'); }, 500); });
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // для тестов
  window.__docs = { calc395: calc395, calcPenalty: calcPenalty, rates: RATES };
})();

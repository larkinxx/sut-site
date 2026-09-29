/* INNSIDER: налоговый календарь. Сроки по Налоговому кодексу (ЕНП: уведомления до 25-го, уплата до 28-го).
   Один и тот же код считает сроки на странице /nalogi/kalendar/ и на сервере для напоминаний на почту
   (server/accounts.mjs загружает этот файл). Срок, выпавший на выходной или праздник, переносится
   на следующий рабочий день (п. 7 ст. 6.1 НК). Правительственные переносы выходных учтены только известные.
   Профиль: { who: 'ul' | 'ip', regime: 'usn6' | 'usn15' | 'osn' | 'psn', staff: bool, nds: bool,
              patentFrom: 'ГГГГ-ММ-ДД', patentTo: 'ГГГГ-ММ-ДД' } */
(function (root) {
  'use strict';
  // нерабочие праздничные дни (ст. 112 ТК) и известные переносы; праздник в выходной сдвигает выходной на понедельник
  var HOLIDAYS = ['01-01', '01-02', '01-03', '01-04', '01-05', '01-06', '01-07', '01-08', '02-23', '03-08', '05-01', '05-09', '06-12', '11-04'];
  var EXTRA_OFF = ['2026-01-09', '2026-12-31'];
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var iso = function (d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); };
  var D = function (y, m, d) { return new Date(Date.UTC(y, m - 1, d)); };
  function off(d) {
    var wd = d.getUTCDay(), s = iso(d), md = s.slice(5);
    if (wd === 0 || wd === 6 || HOLIDAYS.indexOf(md) >= 0 || EXTRA_OFF.indexOf(s) >= 0) return true;
    // понедельник после праздника, выпавшего на субботу или воскресенье (кроме январских — их переносит правительство)
    if (wd === 1) for (var k = 1; k <= 2; k++) {
      var p = iso(new Date(d.getTime() - k * 864e5)).slice(5);
      if (HOLIDAYS.indexOf(p) >= 0 && p.slice(0, 2) !== '01') return true;
    }
    return false;
  }
  function workday(d) { while (off(d)) d = new Date(d.getTime() + 864e5); return d; }

  var Q = ['I квартал', 'полугодие', '9 месяцев'];
  var MON = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

  // все сроки с датами в [from, to) — массив { date: 'ГГГГ-ММ-ДД', kind: 'pay' | 'report' | 'notice', title }
  function deadlines(p, from, to) {
    p = p || {};
    var out = [], ip = p.who === 'ip', usn = p.regime === 'usn6' || p.regime === 'usn15', osn = p.regime === 'osn';
    var add = function (y, m, d, kind, title) {
      var dt = workday(D(y, m, d));
      if (dt >= from && dt < to) out.push({ date: iso(dt), kind: kind, title: title });
    };
    for (var y = from.getUTCFullYear() - 1; y <= to.getUTCFullYear(); y++) {
      // авансы по кварталам: уведомление или декларация — до 25-го, уплата — до 28-го месяца после квартала
      for (var q = 0; q < 3; q++) {
        var m = 4 + q * 3;
        if (usn) {
          add(y, m, 25, 'notice', 'Уведомление об авансе по УСН за ' + Q[q] + ' ' + y);
          add(y, m, 28, 'pay', 'Аванс по УСН за ' + Q[q] + ' ' + y);
        }
        if (osn && !ip) {
          add(y, m, 25, 'report', 'Декларация по налогу на прибыль за ' + Q[q] + ' ' + y);
          add(y, m, 28, 'pay', 'Аванс по налогу на прибыль за ' + Q[q] + ' ' + y);
        }
        if (osn && ip) {
          add(y, m, 25, 'notice', 'Уведомление об авансе по НДФЛ за ' + Q[q] + ' ' + y);
          add(y, m, 28, 'pay', 'Аванс по НДФЛ за ' + Q[q] + ' ' + y);
        }
      }
      // налог за прошлый год
      if (usn && !ip) { add(y, 3, 25, 'report', 'Декларация по УСН за ' + (y - 1)); add(y, 3, 28, 'pay', 'Налог по УСН за ' + (y - 1)); }
      if (usn && ip) { add(y, 4, 25, 'report', 'Декларация по УСН за ' + (y - 1)); add(y, 4, 28, 'pay', 'Налог по УСН за ' + (y - 1)); }
      if (osn && !ip) { add(y, 3, 25, 'report', 'Декларация по налогу на прибыль за ' + (y - 1)); add(y, 3, 28, 'pay', 'Налог на прибыль за ' + (y - 1)); }
      if (osn && ip) { add(y, 4, 30, 'report', 'Декларация 3-НДФЛ за ' + (y - 1)); add(y, 7, 15, 'pay', 'НДФЛ за ' + (y - 1) + ' (по декларации 3-НДФЛ)'); }
      if (!ip) add(y, 3, 31, 'report', 'Бухгалтерская отчётность за ' + (y - 1));
      // НДС: декларация до 25-го после квартала, налог — тремя равными частями до 28-го каждого из трёх следующих месяцев
      if (osn || p.nds) {
        for (var k = 0; k < 4; k++) add(y, 1 + k * 3, 25, 'report', 'Декларация по НДС за ' + (k ? ['I', 'II', 'III'][k - 1] + ' квартал ' + y : 'IV квартал ' + (y - 1)));
        for (var mm = 1; mm <= 12; mm++) {
          var qq = Math.floor((mm - 1) / 3);
          add(y, mm, 28, 'pay', 'НДС: ' + (mm - qq * 3) + '-я треть за ' + (qq ? ['I', 'II', 'III'][qq - 1] + ' квартал ' + y : 'IV квартал ' + (y - 1)));
        }
      }
      // ИП: фиксированные взносы за себя — до 28 декабря, 1% с дохода больше 300 тыс. ₽ — до 1 июля следующего года
      if (ip) {
        add(y, 12, 28, 'pay', 'Фиксированные страховые взносы ИП за ' + y);
        add(y, 7, 1, 'pay', 'Взнос 1% с дохода больше 300 тыс. ₽ за ' + (y - 1));
      }
      // сотрудники: каждый месяц — уведомление и уплата НДФЛ и взносов, ЕФС-1; раз в квартал — РСВ, 6-НДФЛ
      if (p.staff) {
        for (var n = 1; n <= 12; n++) {
          var prev = MON[(n + 10) % 12], span = n === 1 ? 'удержан с 1 по 22 января' : 'удержан с 23-го прошлого по 22-е этого месяца';
          add(y, n, 25, 'notice', 'Уведомление по НДФЛ за сотрудников (' + span + ') и по взносам за ' + prev);
          add(y, n, 25, 'report', 'ЕФС-1: сведения о сотрудниках за ' + prev);
          add(y, n, 28, 'pay', 'НДФЛ за сотрудников (' + span + ') и страховые взносы за ' + prev);
        }
        // НДФЛ, удержанный с 23 по 31 декабря, — уведомление и уплата в последний рабочий день года
        var last = D(y, 12, 31); while (off(last)) last = new Date(last.getTime() - 864e5);
        if (last >= from && last < to) out.push({ date: iso(last), kind: 'pay', title: 'НДФЛ за сотрудников, удержанный с 23 по 31 декабря: уведомление и уплата' });
        for (var r = 0; r < 4; r++) {
          var per = r ? Q[r - 1] + ' ' + y : (y - 1) + ' год';
          add(y, 1 + r * 3, 25, 'report', 'Расчёт по страховым взносам (РСВ) за ' + per);
          add(y, 1 + r * 3, 25, 'report', 'ЕФС-1: взносы на травматизм за ' + per);
          if (r) add(y, 1 + r * 3, 25, 'report', '6-НДФЛ за ' + per);
        }
        add(y, 2, 25, 'report', '6-НДФЛ за ' + (y - 1));
      }
      // патент: до 6 месяцев — весь до конца срока; от 6 до 12 месяцев — треть в первые 90 дней, остальное до конца срока
      if (p.regime === 'psn' && p.patentFrom && p.patentTo && y === from.getUTCFullYear()) {
        var a = new Date(p.patentFrom + 'T00:00:00Z'), b = new Date(p.patentTo + 'T00:00:00Z');
        if (!isNaN(a) && !isNaN(b) && b > a) {
          var months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
          var push = function (dt, title) { dt = workday(dt); if (dt >= from && dt < to) out.push({ date: iso(dt), kind: 'pay', title: title }); };
          if (months < 6) push(b, 'Патент: вся стоимость');
          else { push(new Date(a.getTime() + 90 * 864e5), 'Патент: треть стоимости'); push(b, 'Патент: оставшиеся две трети'); }
        }
      }
    }
    out.sort(function (x, z) { return x.date < z.date ? -1 : x.date > z.date ? 1 : 0; });
    return out;
  }

  var api = { deadlines: deadlines, workday: function (d) { return iso(workday(d)); }, iso: iso };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TaxCal = api;
})(typeof window !== 'undefined' ? window : this);

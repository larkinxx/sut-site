/* Прогноз действующей организации (/prognoz/): POST /api/forecast (server/market.mjs → orgForecast).
   Идея: компания сохраняет своё место среди сверстников той же отрасли и региона — какими будут доходы и прибыль
   у компаний на год, два и три старше. Факт — сплошной столбик, прогноз — светлый, линия — обычный разброс. */
(function () {
  'use strict';
  var root = document.getElementById('fc');
  if (!root) return;
  var api = root.getAttribute('data-api') || '', form = document.getElementById('fc-form'), inp = document.getElementById('fc-inn');
  var msg = document.getElementById('fc-msg'), out = document.getElementById('fc-out');
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var money = function (n) {
    if (n == null || !isFinite(n)) return '—';
    var a = Math.abs(n), s = n < 0 ? '−' : '';
    if (a >= 1e9) return s + (a / 1e9).toFixed(1).replace('.', ',') + ' млрд ₽';
    if (a >= 1e6) return s + (a / 1e6).toFixed(1).replace('.', ',') + ' млн ₽';
    if (a >= 1e3) return s + Math.round(a / 1e3) + ' тыс. ₽';
    return s + Math.round(a) + ' ₽';
  };
  var pct = function (x) { return x == null ? '—' : Math.round(x * 100) + '%'; };

  function chart(title, rows) {
    // rows: [{label, mid, low, high, fact}]
    var W = 560, H = 160, L = 8, R = 8, T = 10, B = 4, n = rows.length;
    var vals = [0];
    rows.forEach(function (r) { vals.push(r.mid, r.low == null ? r.mid : r.low, r.high == null ? r.mid : r.high); });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals) || 1;
    var y = function (v) { return T + (H - T - B) * (1 - (v - lo) / (hi - lo || 1)); }, band = (W - L - R) / n, bw = Math.min(28, band * 0.5);
    var svg = '<line class="axis" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(0) + '" y2="' + y(0) + '"/>';
    rows.forEach(function (r, i) {
      var cx = L + band * (i + 0.5), y0 = y(0), yv = y(r.mid), top = Math.min(y0, yv), h = Math.max(1, Math.abs(yv - y0));
      var tip = r.label + ': ' + money(r.mid) + (r.fact ? ' — факт' : ' — прогноз, обычно ' + money(r.low) + ' – ' + money(r.high));
      svg += '<g><title>' + esc(tip) + '</title>' +
        (r.fact ? '' : '<line class="range" x1="' + cx + '" x2="' + cx + '" y1="' + y(r.high) + '" y2="' + y(r.low) + '"/>') +
        '<rect class="' + (r.fact ? 'pos' : 'fcast') + (r.mid < 0 ? ' neg' : '') + '" x="' + (cx - bw / 2) + '" y="' + top + '" width="' + bw + '" height="' + h + '" rx="3"/></g>';
    });
    return '<figure class="ychart"><figcaption>' + esc(title) + '</figcaption><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(title) + '">' + svg +
      '</svg><div class="ychart-x" style="display:flex;justify-content:space-around">' + rows.map(function (r) { return '<span>' + esc(r.label) + '</span>'; }).join('') + '</div></figure>';
  }

  function render(j) {
    var where = j.scope === 'region' ? 'в том же регионе' : 'по России';
    var h = '<h2 class="h">' + esc(j.name || 'Организация') + '</h2>' +
      '<p>Сейчас, за ' + j.year + ' год: доходы ' + money(j.income) + (j.incomePercentile != null ? ' — больше, чем у ' + j.incomePercentile + '% сверстников' : '') +
      ', прибыль ' + money(j.profit) + (j.profitPercentile != null ? ' — больше, чем у ' + j.profitPercentile + '%' : '') + '. Сверстники — организации той же отрасли (ОКВЭД ' + esc(j.okved) + ') ' + where + ', которые работают ' + esc(j.ageLabel) + '.</p>';
    if (!j.steps.length) {
      h += '<p class="note-sm">По компаниям старше в этой отрасли пока мало отчётности — прогноз не строим.</p>';
    } else {
      var inc = [{ label: String(j.year), mid: j.income, fact: true }].concat(j.steps.filter(function (s) { return s.income; }).map(function (s) { return { label: String(s.year), mid: s.income.mid, low: s.income.low, high: s.income.high }; }));
      var pro = [{ label: String(j.year), mid: j.profit, fact: true }].concat(j.steps.filter(function (s) { return s.profit; }).map(function (s) { return { label: String(s.year), mid: s.profit.mid, low: s.profit.low, high: s.profit.high }; }));
      h += '<div class="bigstats">' + j.steps.slice(-1).map(function (s) {
        return '<div class="bigstat"><span class="bs-label">Доходы в ' + s.year + ' году</span><strong class="bs-val">' + money(s.income && s.income.mid) + '</strong><span class="bs-delta">обычно ' + money(s.income && s.income.low) + ' – ' + money(s.income && s.income.high) + '</span></div>' +
          '<div class="bigstat"><span class="bs-label">Сверстники в плюсе</span><strong class="bs-val">' + pct(s.profitableShare) + '</strong><span class="bs-delta">' + esc(s.ageLabel) + '</span></div>';
      }).join('') + '</div>';
      h += chart('Доходы: факт и прогноз', inc) + chart('Прибыль: факт и прогноз', pro);
      h += '<details class="fns-more"><summary>Таблица по годам</summary><table class="fns-table all-cols"><tr><th>Год</th><th>Возраст</th><th>Доходы</th><th>Прибыль</th><th>В плюсе</th></tr>' +
        j.steps.map(function (s) {
          return '<tr><td>' + s.year + '</td><td>' + esc(s.ageLabel) + '</td><td>' + (s.income ? money(s.income.low) + ' – ' + money(s.income.high) : '—') + '</td><td>' + (s.profit ? money(s.profit.low) + ' – ' + money(s.profit.high) : '—') + '</td><td>' + pct(s.profitableShare) + '</td></tr>';
        }).join('') + '</table></details>';
      if (j.mature) h += '<p class="note-sm">Компания старше пяти лет: дальше возраст не меняет группу сверстников, поэтому прогноз показывает, что будет, если она удержит своё место.</p>';
    }
    h += '<p class="note-sm">Прогноз строится по статистике прошлого года: если компания сохранит своё место среди сверстников, её доходы будут как у компаний на год, два и три старше; диапазон — это место ±15 процентилей. Это оценка, а не обещание: цены, рынок и сама компания меняются. ' +
      '<a href="/otrasli/' + encodeURIComponent(j.okved) + '/' + (j.scope === 'region' ? encodeURIComponent(j.region) + '/' : '') + '">Статистика отрасли</a> · <a href="/organizacii/' + encodeURIComponent(inp.value.replace(/\D/g, '')) + '/">Проверка компании</a></p>';
    out.innerHTML = h;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var inn = inp.value.replace(/\D/g, '');
    if (!/^\d{10}$/.test(inn)) { msg.textContent = 'Нужен ИНН организации — 10 цифр. По ИП налоговая не публикует отчётность, прогноз не построить.'; return; }
    msg.textContent = ''; out.innerHTML = '<p class="note-sm">Считаем…</p>';
    fetch(api + '/api/forecast', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ inn: inn }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.status = r.status; return j; }); })
      .then(function (j) {
        if (j.status !== 200) { out.innerHTML = ''; msg.textContent = j.error || 'Не получилось посчитать. Попробуйте позже.'; return; }
        if (!j.available) { out.innerHTML = ''; msg.textContent = 'По этой организации нет отчётности в открытых данных ФНС или слишком мало похожих компаний для сравнения.'; return; }
        render(j);
        if (window.goal) window.goal('forecast');
      })
      .catch(function () { out.innerHTML = ''; msg.textContent = 'Сервер не ответил. Попробуйте позже.'; });
  });
  var hash = new URLSearchParams(location.hash.slice(1));
  if (/^\d{10}$/.test(hash.get('inn') || '')) { inp.value = hash.get('inn'); form.requestSubmit(); }
})();

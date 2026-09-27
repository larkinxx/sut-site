/* Панель владельца INNSIDER (/admin/): сводка с сервера GET /api/admin/stats по ключу ADMIN_TOKEN (server/admin.mjs).
   Ключ хранится только в этом браузере (localStorage); на сервере — сравнение за постоянное время и лимит попыток. */
(function () {
  'use strict';
  var root = document.getElementById('admin');
  if (!root) return;
  var api = root.getAttribute('data-api'), out = document.getElementById('admin-out'), form = document.getElementById('admin-login');
  var KEY = 'innsider-admin-key';
  var getKey = function () { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
  var setKey = function (v) { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (e) {} };
  var esc = function (t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var int = function (n) { return new Intl.NumberFormat('ru-RU').format(n || 0); };
  var rub = function (n) { return int(n) + ' ₽'; };
  var dayRu = function (d) { return d.slice(8, 10) + '.' + d.slice(5, 7); };
  var sum = function (rows, k, from) { return rows.slice(from).reduce(function (s, r) { return s + (r[k] || 0); }, 0); };
  function stat(label, value, note) {
    return '<div class="bigstat"><span class="bs-label">' + esc(label) + '</span><strong class="bs-val">' + esc(value) + '</strong>' + (note ? '<span class="bs-delta">' + esc(note) + '</span>' : '') + '</div>';
  }
  // Проверки по ИНН за 30 дней: одна величина — без легенды; точные числа по наведению и в таблице под графиком
  function dayChart(rows) {
    var W = 600, H = 140, P = 4, n = rows.length, band = (W - 2 * P) / n, bw = Math.min(14, band * 0.6);
    var max = Math.max.apply(null, rows.map(function (r) { return r.checks; })) || 1, svg = '';
    rows.forEach(function (r, i) {
      var h = r.checks ? Math.max(2, (H - 8) * r.checks / max) : 0, x = P + band * i + (band - bw) / 2, y = H - h;
      svg += '<g><title>' + dayRu(r.day) + ': проверок ' + r.checks + ', разборов ' + r.ai + ', судов ' + r.courts + '</title>' +
        '<rect x="' + (P + band * i) + '" y="0" width="' + band + '" height="' + H + '" fill="transparent"/>' +
        (h ? '<rect class="pos" x="' + x + '" y="' + y + '" width="' + bw + '" height="' + h + '" rx="2"/>' : '') + '</g>';
    });
    var table = '<details class="fns-more"><summary>Таблица по дням</summary><table class="fns-table all-cols"><tr><th>День</th><th>Проверки</th><th>Разборы</th><th>Суды</th><th>Статистика</th></tr>' +
      rows.slice().reverse().map(function (r) { return '<tr><td>' + dayRu(r.day) + '</td><td>' + r.checks + '</td><td>' + r.ai + '</td><td>' + r.courts + '</td><td>' + r.market + '</td></tr>'; }).join('') + '</table></details>';
    return '<figure class="ychart"><figcaption>Проверки по ИНН за 30 дней (последний столбик — сегодня)</figcaption><svg viewBox="0 0 ' + W + ' ' + H +
      '" role="img" aria-label="Проверки по ИНН за 30 дней">' + '<line class="axis" x1="0" x2="' + W + '" y1="' + H + '" y2="' + H + '"/>' + svg +
      '</svg><div class="ychart-x" style="display:flex;justify-content:space-between"><span>' + dayRu(rows[0].day) + '</span><span>' + dayRu(rows[n - 1].day) + '</span></div></figure>' + table;
  }
  function render(j) {
    var u = j.usage || [], h = '';
    h += '<div class="bigstats">' +
      stat('Проверок сегодня', int(u.length ? u[u.length - 1].checks : 0), 'за 7 дней: ' + int(sum(u, 'checks', -7))) +
      stat('Разборов за 7 дней', int(sum(u, 'ai', -7)), 'новых, платных') +
      stat('Судов за 7 дней', int(sum(u, 'courts', -7)), 'DataNewton сегодня: ' + int(j.datanewton ? j.datanewton.usedToday : 0) + ' ед.') +
      '</div>';
    if (j.users) {
      h += '<div class="bigstats">' +
        stat('Подписок Ultima', int(j.subscriptions.active), 'месяц: ' + int(j.subscriptions.byPlan.month || 0) + ', год: ' + int(j.subscriptions.byPlan.year || 0)) +
        stat('Оплаты за 30 дней', rub(j.payments30.sum), int(j.payments30.count) + ' платежей') +
        stat('Пользователей', int(j.users.total), 'новых за 7 дней: ' + int(j.users.new7) + ', заходили: ' + int(j.users.active7)) +
        '</div>';
    }
    if (u.length) h += dayChart(u);
    if (j.fns) {
      h += '<h2 class="h" style="margin-top:22px">Данные ФНС</h2><table class="fns-table all-cols"><tr><th>Набор</th><th>Строк</th><th>Загружен</th></tr>' +
        j.fns.datasets.map(function (d) { return '<tr><td>' + esc(d.dataset) + '</td><td>' + int(d.rows) + '</td><td>' + esc(String(d.loadedAt).slice(0, 10).split('-').reverse().join('.')) + '</td></tr>'; }).join('') +
        '</table><p class="note-sm">Групп статистики похожих компаний: ' + int(j.fns.peerGroups) + (j.fns.peerGroups ? '' : ' — калькулятор «Перспективы бизнеса» пока пуст') + '.</p>';
    }
    h += '<p class="note-sm">Сервер работает ' + esc(j.server.uptimeHours) + ' ч, память ' + esc(j.server.memoryMb) + ' МБ, Node ' + esc(j.server.node) + '. Обновлено ' + new Date(j.generatedAt).toLocaleString('ru-RU') + '. ' +
      '<a href="#" id="admin-out-btn">Выйти</a></p>';
    out.innerHTML = h;
    document.getElementById('admin-out-btn').addEventListener('click', function (e) { e.preventDefault(); setKey(''); location.reload(); });
  }
  function load() {
    var key = getKey();
    if (!key) { form.hidden = false; out.innerHTML = ''; return; }
    out.innerHTML = '<p class="note-sm">Загружаем…</p>';
    fetch(api + '/api/admin/stats', { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.status = r.status; return j; }); })
      .then(function (j) {
        if (j.status === 200) { form.hidden = true; render(j); return; }
        if (j.status === 401) setKey('');
        form.hidden = j.status === 404;
        out.innerHTML = '<p class="verdict warn">' + esc(j.status === 404 ? 'Панель не включена: задайте ADMIN_TOKEN в /etc/sut/api.env и перезапустите сервер.' : j.error || 'Не получилось загрузить сводку.') + '</p>';
      })
      .catch(function () { out.innerHTML = '<p class="verdict warn">Сервер не ответил. Попробуйте позже.</p>'; });
  }
  form.addEventListener('submit', function (e) { e.preventDefault(); setKey(document.getElementById('admin-key').value.trim()); load(); });
  load();
})();

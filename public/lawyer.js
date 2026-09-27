/* Помощник юриста на /yurist/: вопрос → POST /api/lawyer (server/lawyer.mjs), только для подписчиков Ultima.
   Ответ ИИ показываем как текст (без HTML из ответа), статьи — ссылками на поиск текста закона. */
(function () {
  'use strict';
  var root = document.getElementById('lawyer');
  if (!root) return;
  var api = root.getAttribute('data-api'), form = document.getElementById('lawyer-form'), q = document.getElementById('lawyer-q');
  var msg = document.getElementById('lawyer-msg'), out = document.getElementById('lawyer-out');
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var link = function (href, text) { return '<a href="' + esc(href) + '">' + esc(text) + '</a>'; };

  function render(j) {
    var paras = String(j.answer || '').split(/\n{2,}/).map(function (p) {
      var lines = p.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      if (lines.length > 1 && lines.every(function (l) { return /^\d+[.)]\s/.test(l); })) {
        return '<ol>' + lines.map(function (l) { return '<li>' + esc(l.replace(/^\d+[.)]\s*/, '')) + '</li>'; }).join('') + '</ol>';
      }
      return '<p>' + lines.map(esc).join('<br>') + '</p>';
    }).join('');
    var laws = (j.laws || []).length ? '<p class="fns-sub">Статьи закона</p><ul>' + j.laws.map(function (l) {
      return '<li>' + link('https://yandex.ru/search/?text=' + encodeURIComponent(l + ' консультант плюс'), l) + '</li>';
    }).join('') + '</ul>' : '';
    out.innerHTML = '<div class="prose lawyer-answer">' + paras + laws +
      (j.needLawyer ? '<p class="verdict warn">Ситуация может зависеть от деталей — покажите документы юристу, прежде чем действовать.</p>' : '') +
      '<p class="note-sm">Ответ ИИ, не юридическая консультация.' + (j.left != null ? ' Вопросов на сегодня осталось: ' + j.left + '.' : '') + ' Документы по ситуации — в разделе ' + link('/yurist/dokumenty/', '«Документы по ИНН»') + '.</p></div>';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = q.value.trim();
    if (text.length < 10) { msg.textContent = 'Опишите ситуацию подробнее.'; return; }
    msg.textContent = ''; out.innerHTML = '<p class="note-sm">Готовим ответ — это займёт до минуты…</p>';
    var btn = form.querySelector('button'); btn.disabled = true;
    fetch(api + '/api/lawyer', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ question: text }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.status = r.status; return j; }); })
      .then(function (j) {
        if (j.status === 200) { render(j); if (window.goal) window.goal('lawyer'); return; }
        out.innerHTML = '';
        if (j.needLogin) { msg.innerHTML = esc(j.error) + ' ' + link(root.getAttribute('data-login'), 'Войти'); return; }
        if (j.needPro) { msg.innerHTML = esc(j.error) + ' ' + link(root.getAttribute('data-plans'), 'Тарифы'); return; }
        msg.textContent = j.error || 'Не получилось получить ответ. Попробуйте позже.';
      })
      .catch(function () { out.innerHTML = ''; msg.textContent = 'Сервер не ответил. Попробуйте позже.'; })
      .then(function () { btn.disabled = false; });
  });
})();

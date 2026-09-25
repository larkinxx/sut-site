/* Суть: страницы «Вход» и «Кабинет». Сервер аккаунтов — server/accounts.mjs (адрес в <html data-acct>).
   Сессия — cookie на общем домене, поэтому все запросы идут с credentials: 'include'. */
(function () {
  'use strict';
  var ACCT = (document.documentElement.getAttribute('data-acct') || '').replace(/\/$/, '');
  if (!ACCT) return;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  function api(method, path, body) {
    return fetch(ACCT + path, {
      method: method, credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.status = r.status; return j; }); });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function dateRu(ms) { return new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }); }
  var params = new URLSearchParams(location.search);
  var ret = /^\/(?!\/)/.test(params.get('return') || '') ? params.get('return') : '/kabinet/';

  /* ---------------- Вход ---------------- */
  var login = $('#login');
  if (login) {
    var err = $('#login-err'), msgEl = $('#login-msg'), consent = $('#consent');
    if (params.get('oshibka')) { err.textContent = params.get('oshibka'); err.hidden = false; }
    api('GET', '/api/me').then(function (j) {
      // вошедший попадает сюда только чтобы привязать ещё один способ входа (?privyazat=1)
      if (j.user && !params.get('privyazat')) { location.replace(ret); return; }
      if (j.user) { $('h1').textContent = 'Подключить способ входа'; $('#login-email').remove(); j.methods.email = false; }
      var m = j.methods || {};
      var ya = $('#login-yandex'), tg = $('#login-telegram'), form = $('#login-email');
      ya.hidden = !m.yandex; tg.hidden = !m.telegram; form.hidden = !m.email;
      if (!m.yandex && !m.telegram && !m.email) msgEl.textContent = 'Вход временно недоступен.';

      function sync() {
        var ok = consent.checked;
        ya.setAttribute('aria-disabled', String(!ok));
        ya.href = ok ? ACCT + '/auth/yandex?' + new URLSearchParams({ consent: '1', return: ret }) : '#';
      }
      consent.addEventListener('change', sync); sync();
      ya.addEventListener('click', function (e) { if (!consent.checked) { e.preventDefault(); msgEl.textContent = 'Отметьте согласие на обработку данных.'; } });

      // Вход через бота: открываем Telegram по ссылке t.me/<бот>?start=<код>, человек подтверждает вход кнопкой в боте,
      // а эта страница раз в 2 секунды спрашивает сервер, готово ли
      var polling = null;
      tg.addEventListener('click', function () {
        if (!consent.checked) { msgEl.textContent = 'Отметьте согласие на обработку данных.'; return; }
        var win = window.open('', '_blank');      // открываем окно сразу по нажатию, иначе браузер его заблокирует
        tg.disabled = true;
        api('POST', '/auth/telegram/start', { consent: true }).then(function (r) {
          tg.disabled = false;
          if (!r.url) { if (win) win.close(); msgEl.textContent = r.error || 'Не получилось начать вход.'; return; }
          if (win) { win.opener = null; win.location.href = r.url; }
          msgEl.textContent = '';
          msgEl.appendChild(document.createTextNode('В Telegram нажмите «Запустить», а затем «Войти на fin-check.shop». Эта страница обновится сама. Telegram не открылся? '));
          var a = el('a', null, 'Открыть бота'); a.href = r.url; a.target = '_blank'; a.rel = 'noopener';
          msgEl.appendChild(a);
          clearInterval(polling);
          var started = Date.now();
          polling = setInterval(function () {
            if (Date.now() - started > 10 * 60e3) { clearInterval(polling); msgEl.textContent = 'Время на вход истекло. Нажмите «Войти через Telegram» ещё раз.'; return; }
            api('GET', '/auth/telegram/status?nonce=' + encodeURIComponent(r.nonce)).then(function (s) {
              if (s.state === 'ok') { clearInterval(polling); location.replace(ret); }
              else if (s.state === 'expired' || s.state === 'error' || s.status === 403) { clearInterval(polling); msgEl.textContent = s.error || 'Время на вход истекло. Нажмите «Войти через Telegram» ещё раз.'; }
            }, function () {});
          }, 2000);
        }, function () { tg.disabled = false; if (win) win.close(); msgEl.textContent = 'Сервер входа не отвечает. Попробуйте позже.'; });
      });

      var step = 'email', email = $('#email'), code = $('#code'), btn = $('#email-btn');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!consent.checked) { msgEl.textContent = 'Отметьте согласие на обработку данных.'; return; }
        btn.disabled = true;
        if (step === 'email') {
          api('POST', '/auth/email/start', { email: email.value.trim() }).then(function (r) {
            btn.disabled = false;
            if (!r.ok) { msgEl.textContent = r.error || 'Не получилось отправить код.'; return; }
            step = 'code'; $('#code-row').hidden = false; email.readOnly = true; btn.textContent = 'Войти'; code.focus();
            msgEl.textContent = 'Код отправлен на ' + email.value.trim() + '. Если письма нет, проверьте папку «Спам».';
          });
        } else {
          api('POST', '/auth/email/verify', { email: email.value.trim(), code: code.value, consent: true }).then(function (r) {
            btn.disabled = false;
            if (r.user) location.replace(ret); else msgEl.textContent = r.error || 'Не получилось войти.';
          });
        }
      });
    }, function () { msgEl.textContent = 'Сервер входа не отвечает. Попробуйте позже.'; });
  }

  /* ---------------- Кабинет ---------------- */
  var cab = $('#cab');
  if (cab) {
    var STATUS = { ACTIVE: 'действует', LIQUIDATING: 'ликвидируется', LIQUIDATED: 'ликвидирована', BANKRUPT: 'банкротство', REORGANIZING: 'реорганизация' };
    var section = function (title, note) {
      var s = el('section', 'grp cab-sec'); s.appendChild(el('h2', null, title));
      if (note) s.appendChild(el('p', null, note));
      cab.appendChild(s); return s;
    };
    var link = function (text, href) { var a = el('a', null, text); a.href = href; return a; };
    var smallBtn = function (text, fn) { var b = el('button', 'linkbtn', text); b.type = 'button'; b.addEventListener('click', fn); return b; };
    var innForm = function (label, btnText, onSubmit) {
      var f = el('form', 'cab-form'); f.noValidate = true;
      var i = el('input'); i.type = 'text'; i.inputMode = 'numeric'; i.maxLength = 12; i.placeholder = 'ИНН'; i.setAttribute('aria-label', label);
      var b = el('button', 'btn', btnText); b.type = 'submit';
      var m = el('span', 'note-sm');
      f.appendChild(i); f.appendChild(b); f.appendChild(m);
      f.addEventListener('submit', function (e) { e.preventDefault(); b.disabled = true; onSubmit(i.value.replace(/\s/g, ''), m).then(function () { b.disabled = false; }); });
      return f;
    };
    var checkUrl = function (inn) { return '/organizacii/#inn=' + inn; };

    function render() {
      Promise.all([api('GET', '/api/me'), api('GET', '/api/watch'), api('GET', '/api/history'), api('GET', '/api/calcs')]).then(function (r) {
        var me = r[0];
        if (!me.user) { location.replace('/vhod/?return=/kabinet/'); return; }
        var u = me.user;
        cab.textContent = '';

        var head = el('div', 'cab-head');
        head.appendChild(el('p', 'lede', u.name + (u.email ? ' · ' + u.email : '')));
        head.appendChild(smallBtn('Выйти', function () { api('POST', '/auth/logout').then(function () { location.replace('/'); }); }));
        cab.appendChild(head);

        // Моя компания
        var sec = section('Моя компания', 'Укажите ИНН своей компании или ИП: откроем проверку и налоговые советы в один клик.');
        if (u.company_inn) {
          var p = el('p'); p.appendChild(link('Открыть проверку и советы по ИНН ' + u.company_inn, checkUrl(u.company_inn)));
          p.appendChild(document.createTextNode(' '));
          p.appendChild(smallBtn('убрать', function () { api('PATCH', '/api/me', { company_inn: null }).then(render); }));
          sec.appendChild(p);
        } else {
          sec.appendChild(innForm('ИНН вашей компании', 'Сохранить', function (inn, m) {
            return api('PATCH', '/api/me', { company_inn: inn }).then(function (j) { if (j.user) render(); else m.textContent = j.error || 'Не получилось.'; });
          }));
        }

        // Слежение
        sec = section('Слежение за компаниями', 'Раз в сутки сверяем статус, руководителя, адрес и налоговые долги и сообщаем об изменениях.');
        var items = r[1].items || [];
        if (items.length) {
          var ul = el('ul', 'cab-list');
          items.forEach(function (w) {
            var li = el('li');
            li.appendChild(link(w.name || w.inn, checkUrl(w.inn)));
            li.appendChild(el('span', 'note-sm', ' · ИНН ' + w.inn + (w.status ? ' · ' + (STATUS[w.status] || w.status) : '')));
            if (w.last_change) li.appendChild(el('span', 'cab-change', 'Изменения ' + dateRu(w.changed_at) + ': ' + w.last_change));
            li.appendChild(smallBtn('убрать', function () { api('DELETE', '/api/watch?inn=' + w.inn).then(render); }));
            ul.appendChild(li);
          });
          sec.appendChild(ul);
        }
        sec.appendChild(innForm('ИНН компании для слежения', 'Следить', function (inn, m) {
          return api('POST', '/api/watch', { inn: inn }).then(function (j) { if (j.ok) render(); else m.textContent = j.error || 'Не получилось.'; });
        }));

        // Уведомления
        sec = section('Уведомления об изменениях');
        var opts = [['telegram', 'В Telegram'], ['email', 'На почту'], ['none', 'Не присылать']];
        var fs = el('div', 'cab-notify');
        opts.forEach(function (o) {
          var lab = el('label'); var inp = el('input'); inp.type = 'radio'; inp.name = 'notify'; inp.value = o[0];
          inp.checked = u.notify === o[0];
          if ((o[0] === 'telegram' && !u.can_telegram) || (o[0] === 'email' && !u.can_email)) inp.disabled = true;
          inp.addEventListener('change', function () { api('PATCH', '/api/me', { notify: o[0] }); });
          lab.appendChild(inp); lab.appendChild(document.createTextNode(' ' + o[1])); fs.appendChild(lab);
        });
        sec.appendChild(fs);
        if (!u.can_telegram && me.methods && me.methods.telegram) {
          var tp = el('p', 'note-sm', 'Чтобы получать уведомления в Telegram, ');
          tp.appendChild(link('подключите Telegram', '/vhod/?privyazat=1&return=/kabinet/'));
          tp.appendChild(document.createTextNode(' к этому аккаунту.')); sec.appendChild(tp);
        }

        // История
        sec = section('История проверок');
        var hist = r[2].items || [];
        if (!hist.length) sec.appendChild(el('p', 'note-sm', 'Пока пусто: проверки появятся здесь, когда вы будете проверять компании, войдя в кабинет.'));
        else {
          var hl = el('ul', 'cab-list');
          hist.slice(0, 50).forEach(function (h) {
            var li = el('li'); li.appendChild(link(h.name || h.inn, checkUrl(h.inn)));
            li.appendChild(el('span', 'note-sm', ' · ' + dateRu(h.at))); hl.appendChild(li);
          });
          sec.appendChild(hl);
          sec.appendChild(smallBtn('Очистить историю', function () { if (confirm('Очистить всю историю проверок?')) api('DELETE', '/api/history').then(render); }));
        }

        // Расчёты
        sec = section('Сохранённые расчёты');
        var calcs = r[3].items || [];
        if (!calcs.length) {
          var pc = el('p', 'note-sm', 'Нажмите «Сохранить расчёт» в любом ');
          pc.appendChild(link('калькуляторе', '/kalkulyatory/')); pc.appendChild(document.createTextNode(', и он появится здесь.'));
          sec.appendChild(pc);
        } else {
          var cl = el('ul', 'cab-list');
          calcs.forEach(function (c) {
            var li = el('li'); li.appendChild(link(c.title, c.link));
            li.appendChild(el('span', 'note-sm', ' · ' + dateRu(c.saved_at)));
            li.appendChild(smallBtn('удалить', function () { api('DELETE', '/api/calcs?id=' + c.id).then(render); }));
            cl.appendChild(li);
          });
          sec.appendChild(cl);
        }

        // Удаление аккаунта
        sec = section('Аккаунт');
        sec.appendChild(smallBtn('Удалить аккаунт и все данные', function () {
          if (confirm('Удалить аккаунт? История, слежение и расчёты будут удалены без возможности восстановления.')) api('DELETE', '/api/me').then(function () { location.replace('/'); });
        }));
      }, function () { cab.textContent = 'Сервер кабинета не отвечает. Попробуйте позже.'; });
    }
    render();
  }
})();

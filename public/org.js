/* Суть: проверка организации по ИНН.
   Данные берём из открытых реестров через DaData (метод «Найти по ИНН»), памятку строим по простым правилам, без ИИ. */
(function () {
  'use strict';

  var API = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party';
  var STATUS = {
    ACTIVE: 'Действует',
    LIQUIDATING: 'Ликвидируется',
    LIQUIDATED: 'Ликвидирована',
    BANKRUPT: 'Банкротство',
    REORGANIZING: 'Реорганизация'
  };

  /* ---------- проверка ИНН по контрольным цифрам ---------- */
  function innValid(inn) {
    if (!/^\d{10}$|^\d{12}$/.test(inn)) return false;
    var d = inn.split('').map(Number);
    var check = function (coef) {
      var s = 0;
      for (var i = 0; i < coef.length; i++) s += coef[i] * d[i];
      return (s % 11) % 10;
    };
    if (d.length === 10) return check([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
    return check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
  }

  function rub(n) {
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' ₽';
  }
  function dateRu(ms) {
    return new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  /* ---------- памятка: простые правила по данным реестра ---------- */
  function advise(d, now) {
    var out = [];
    var add = function (level, title, text) { out.push({ level: level, title: title, text: text }); };
    var st = (d.state && d.state.status) || '';
    var isIp = d.type === 'INDIVIDUAL';
    var regMs = d.state && d.state.registration_date;
    var fin = d.finance || {};

    if (st && st !== 'ACTIVE') {
      add('warn', 'Статус: ' + (STATUS[st] || st),
        'Организация не в обычном рабочем состоянии. Прежде чем заключать договоры или вносить предоплату, проверьте выписку из ЕГРЮЛ или ЕГРИП на egrul.nalog.ru.');
    }
    if (d.invalid) {
      add('warn', 'Данные помечены как недостоверные',
        'В реестре есть отметка о недостоверности сведений (например, об адресе или руководителе). Уточните это в выписке.');
    }
    if (fin.debt > 0 || fin.penalty > 0) {
      var parts = [];
      if (fin.debt > 0) parts.push('недоимка ' + rub(fin.debt));
      if (fin.penalty > 0) parts.push('штрафы ' + rub(fin.penalty));
      add('warn', 'В открытых данных указана задолженность',
        parts.join(', ') + (fin.year ? ' (данные за ' + fin.year + ' год)' : '') + '. Сверьте с личным кабинетом налогоплательщика на nalog.gov.ru: сведения могли устареть.');
    }
    if (regMs && now - regMs < 365 * 864e5) {
      add('info', 'Организация зарегистрирована меньше года назад',
        'В первый год стоит выбрать и подтвердить режим налогообложения, настроить учёт и составить календарь платежей и отчётов. Если режим не выбран, применяется общий.');
    }
    if (isIp) {
      add('info', 'Взносы ИП «за себя»',
        'Страховые взносы ИП платит и без дохода: фиксированную часть обычно в течение года, а 1% с дохода свыше 300 000 ₽ до 1 июля следующего года. Суммы на текущий год смотрите на nalog.gov.ru.');
    } else {
      add('info', 'Годовая бухгалтерская отчётность',
        'Организации сдают годовую бухгалтерскую отчётность в налоговую (через ГИР БО), обычно до 31 марта следующего года.');
    }
    if (fin.tax_system === 'USN') {
      add('info', 'Упрощённая система налогообложения (УСН)',
        'Декларация за год обычно сдаётся до 25 марта для организаций и до 25 апреля для ИП. Авансовые платежи платят до 28 числа после каждого квартала: в апреле, июле и октябре.');
    } else if (!fin.tax_system) {
      add('info', 'Режим налогообложения в открытых данных не указан',
        'Убедитесь, что применяете именно тот режим, о котором уведомили налоговую, и что вы вписываетесь в его лимиты по доходам и работникам.');
    }
    if (d.employee_count > 0) {
      add('info', 'Есть работники',
        'У работодателя есть ежемесячные платежи и уведомления по налогам и взносам с зарплаты, а также отчётность по работникам в налоговую и Социальный фонд. Точные сроки смотрите в календаре на nalog.gov.ru.');
    }
    if (d.okved) {
      add('info', 'Виды деятельности',
        'Основной вид деятельности в реестре: ' + d.okved + '. Если вы занимаетесь чем-то ещё, проверьте, что эти виды указаны в реестре и подходят под ваш налоговый режим.');
    }
    add('info', 'Как быть в курсе',
      'Раз в квартал сверяйте свою карточку в ЕГРЮЛ или ЕГРИП, следите за письмами налоговой в личном кабинете и подключите напоминания о сроках платежей.');
    return out;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { innValid: innValid, advise: advise };
    return;
  }

  /* ---------- страница ---------- */
  var root = document.getElementById('org');
  if (!root) return;
  var token = root.getAttribute('data-token') || '';
  var form = document.getElementById('org-form');
  var input = document.getElementById('org-inn');
  var msg = document.getElementById('org-msg');
  var out = document.getElementById('org-out');

  var el = function (tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  var row = function (parent, label, value) {
    if (!value) return;
    var r = el('div');
    r.appendChild(el('span', null, label));
    r.appendChild(el('strong', null, value));
    parent.appendChild(r);
  };

  if (!token) {
    form.hidden = true;
    msg.textContent = 'Проверка организаций ещё не подключена: нужен ключ сервиса. Загляните позже.';
    return;
  }

  function render(s) {
    var d = s.data || {};
    out.textContent = '';
    var head = el('h2', null, (d.name && d.name.short_with_opf) || s.value);
    head.style.marginTop = '18px';
    out.appendChild(head);

    var box = el('div', 'result');
    var st = (d.state && d.state.status) || '';
    row(box, 'Статус', STATUS[st] || st);
    row(box, 'ИНН', d.inn);
    row(box, 'ОГРН', d.ogrn);
    row(box, 'Зарегистрирована', d.state && d.state.registration_date ? dateRu(d.state.registration_date) : '');
    row(box, 'Руководитель', d.management && d.management.name);
    row(box, 'Адрес', d.address && d.address.value);
    row(box, 'Работников', d.employee_count != null ? String(d.employee_count) : '');
    out.appendChild(box);

    out.appendChild(el('h2', null, 'Памятка')).style.marginTop = '22px';
    advise(d, Date.now()).forEach(function (a) {
      var p = el('p', 'tip');
      var b = el('b', null, a.title + '. ');
      if (a.level === 'warn') p.style.borderLeftColor = 'var(--crit-line)';
      p.appendChild(b);
      p.appendChild(document.createTextNode(a.text));
      p.style.margin = '10px 0';
      out.appendChild(p);
    });
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var inn = input.value.replace(/\s/g, '');
    out.textContent = '';
    if (!innValid(inn)) {
      msg.textContent = 'Проверьте ИНН: у организации 10 цифр, у ИП 12, и контрольные цифры должны сходиться.';
      return;
    }
    msg.textContent = 'Ищем в реестрах…';
    fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Token ' + token },
      body: JSON.stringify({ query: inn })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var list = j.suggestions || [];
      if (!list.length) { msg.textContent = 'По этому ИНН ничего не найдено.'; return; }
      var main = list.filter(function (s) { return s.data && s.data.branch_type === 'MAIN'; })[0] || list[0];
      msg.textContent = '';
      render(main);
    }).catch(function () {
      msg.textContent = 'Не получилось получить данные. Попробуйте позже.';
    });
  });
})();

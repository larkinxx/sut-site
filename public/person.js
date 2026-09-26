/* ИННфакт: проверка физлица — памятка со ссылками на бесплатные официальные реестры.
   Автоматического поиска по ФИО тут нет и быть не должно: закон не даёт "пробивать" человека по одной кнопке,
   как компанию по ИНН. Поэтому страница ничего никуда не отправляет — только подставляет введённое ФИО
   в текст памятки и даёт прямые ссылки на официальные бесплатные реестры, где искать нужно вручную. */
(function () {
  'use strict';

  var form = document.getElementById('person-form');
  if (!form) return;
  var fio = document.getElementById('person-fio');
  var out = document.getElementById('person-out');

  var el = function (tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  var SOURCES = [
    {
      title: 'Федресурс — банкротство физлиц',
      href: 'https://fedresurs.ru/search/bankrupts',
      desc: 'сообщения о процедурах банкротства гражданина, поиск по ФИО.'
    },
    {
      title: 'ФССП — банк исполнительных производств',
      href: 'https://fssp.gov.ru/iss/ip',
      desc: 'долги по решению суда: алименты, штрафы, кредиты. Понадобятся ФИО, регион и дата рождения.'
    },
    {
      title: 'Прозрачный бизнес — участие в организациях',
      href: 'https://pb.nalog.ru/search.html#search-upr-uchr',
      desc: 'в каких компаниях человек указан руководителем, учредителем или единственным акционером.'
    },
    {
      title: 'Прозрачный бизнес — реестр дисквалифицированных лиц',
      href: 'https://pb.nalog.ru/search.html#search-rdl',
      desc: 'запрещено ли человеку занимать руководящие должности по решению суда.'
    },
    {
      title: 'Реестр залогов движимого имущества',
      href: 'https://www.reestr-zalogov.ru/search/index',
      desc: 'не заложено ли имущество, где человек указан залогодателем.'
    }
  ];

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var name = (fio.value || '').trim();
    out.textContent = '';
    if (!name) {
      out.appendChild(el('p', 'note-sm', 'Введите ФИО, чтобы получить памятку со ссылками.'));
      return;
    }

    var head = el('h2', null, name);
    head.style.marginTop = '18px';
    out.appendChild(head);

    out.appendChild(el('p', 'note-sm',
      'Мы ничего не ищем сами и никуда не отправляем ФИО: ни один российский сервис не даёт «пробить» ' +
      'человека по одной кнопке, это персональные данные. Ниже — официальные бесплатные реестры, ' +
      'в которых можно проверить «' + name + '» вручную, по ФИО (иногда ещё пригодятся регион и дата рождения).'));

    var ul = el('ul');
    ul.style.margin = '14px 0 0';
    ul.style.paddingLeft = '20px';
    SOURCES.forEach(function (s) {
      var li = el('li');
      li.style.margin = '10px 0';
      var a = document.createElement('a');
      a.href = s.href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = s.title;
      li.appendChild(a);
      li.appendChild(document.createTextNode(' — ' + s.desc));
      ul.appendChild(li);
    });
    out.appendChild(ul);
  });
})();

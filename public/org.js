/* Суть: проверка организации по ИНН.
   Данные берём из открытых реестров через DaData (метод «Найти по ИНН»), памятку строим по простым правилам.
   Если у страницы задан data-api (наш сервер, см. server/index.mjs), запросы идут через него: ключи не видны в браузере,
   а после данных реестра сервер присылает ИИ-разбор простым языком. Без data-api — старый режим, прямо в DaData. */
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
    // Финансовые услуги (ОКВЭД 64–66): без лицензии или записи в реестре ЦБ работать нельзя
    if (/^6[456]\./.test(d.okved || '')) {
      add('warn', 'Финансовая организация: проверьте её в ЦБ',
        'Основной вид деятельности ' + d.okved + ' относится к финансовым услугам. Прежде чем отдавать деньги, найдите организацию в справочнике участников финансового рынка на cbr.ru: у банка, МФО, брокера, страховщика или кредитного кооператива должна быть лицензия или запись в реестре. Проверьте и список компаний с признаками нелегальной деятельности на том же сайте.');
    }
    if (d.okved) {
      add('info', 'Виды деятельности',
        'Основной вид деятельности в реестре: ' + d.okved + '. Если вы занимаетесь чем-то ещё, проверьте, что эти виды указаны в реестре и подходят под ваш налоговый режим.');
    }
    add('info', 'Как быть в курсе',
      'Раз в квартал сверяйте свою карточку в ЕГРЮЛ или ЕГРИП, следите за письмами налоговой в личном кабинете и подключите напоминания о сроках платежей.');
    return out;
  }

  /* ---------- как законно снизить налоги: только безопасные способы и только если к ним есть повод в данных ----------
     Лимиты и ставки берём из config/finance.json (сборка кладёт их в страницу как #fin). */
  function taxIdeas(d, R) {
    var out = [];
    if (!R || !R.usnIncomeLimit) return out;
    var add = function (level, title, text, link) { out.push({ level: level, title: title, text: text, link: link || null }); };
    var isIp = d.type === 'INDIVIDUAL';
    var fin = d.finance || {};
    var ts = String(fin.tax_system || '');
    var onUsn = ts.indexOf('USN') >= 0, onAusn = ts.indexOf('AUSN') >= 0, special = !!ts;
    var inc = typeof fin.income === 'number' ? fin.income : null;
    var exp = typeof fin.expense === 'number' ? fin.expense : null;
    var emp = typeof d.employee_count === 'number' ? d.employee_count : null;
    var yr = fin.year ? ' за ' + fin.year + ' год' : '';
    var pct = function (x) { return String(Math.round(x * 1000) / 10).replace('.', ',') + '%'; };
    var rn = /^\d{2}/.test(d.inn || '') ? d.inn.slice(0, 2) : '77';
    var nalog = function (tax) { return 'https://www.nalog.gov.ru/rn' + rn + '/taxation/taxes/' + tax + '/'; };
    var regionName = d.address && d.address.data && d.address.data.region_with_type;
    var inRegion = regionName ? 'в регионе ' + regionName : 'в вашем регионе';
    var people = function (n) { var m10 = n % 10, m100 = n % 100; return n + ' ' + (m10 === 1 && m100 !== 11 ? 'работник' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'работника' : 'работников'); };
    if (d.state && d.state.status && d.state.status !== 'ACTIVE') return out;

    // 1. Общая система -> упрощёнка, если проходят лимиты
    if (!special && (inc == null || inc <= R.usnIncomeLimit) && (emp == null || emp <= R.usnEmployees)) {
      var cmp = '';
      if (!isIp && inc > 0 && exp != null) {
        var profit = Math.max(0, inc - exp);
        cmp = ' По данным' + yr + ' (доходы ' + rub(inc) + ', расходы ' + rub(exp) + '): налог на прибыль ' + pct(R.profitTax) + ' был бы около ' + rub(profit * R.profitTax) +
          ', на УСН «Доходы» ' + pct(R.usnRateIncome) + ' — около ' + rub(inc * R.usnRateIncome) +
          ', на УСН «Доходы минус расходы» ' + pct(R.usnRateProfit) + ' — около ' + rub(Math.max(profit * R.usnRateProfit, inc * R.usnMinTax)) + '. Это грубая оценка без НДС и взносов.';
      }
      add('idea', 'Упрощёнка вместо общей системы',
        'В открытых данных нет спецрежима, значит, скорее всего, применяется общая система. ' +
        (inc != null ? 'Доход' + yr + ' ' + rub(inc) : 'Доход') + (emp != null ? ' и ' + people(emp) : '') +
        ' укладываются в лимиты УСН на ' + R.year + ' год: ' + rub(R.usnIncomeLimit) + ' дохода, ' + R.usnEmployees + ' человек, основные средства до ' + rub(R.usnAssets) + '.' + cmp +
        ' Перейти можно с 1 января, если подать уведомление до 31 декабря. При доходе больше ' + rub(R.ndsFrom) + ' на УСН платится НДС.',
        nalog('usn'));
    }

    // 1а. Общая система и небольшая выручка: освобождение от НДС по ст. 145 НК
    if (!special && inc != null && inc > 0 && inc <= 8000000) {
      add('idea', 'Освобождение от НДС на общей системе',
        'Если выручка без НДС за три месяца подряд не больше 2 млн ₽, можно не платить НДС, подав уведомление в налоговую (статья 145 НК). Доход' + yr + ' ' + rub(inc) +
        ', это в среднем ' + rub(inc / 4) + ' за квартал. Освобождение не действует для подакцизных товаров и на ввоз, а через 12 месяцев его нужно подтвердить.', nalog('nds'));
    }

    // 2. Общая система у организации: законные способы раньше учесть расходы
    if (!special && !isIp) {
      add('idea', 'Если остаётесь на общей системе',
        'Обсудите с бухгалтером способы раньше учесть расходы: амортизационная премия (до 10% или до 30% стоимости основного средства сразу в расходы, в зависимости от группы), нелинейная амортизация и минимальный срок полезного использования в группе, ' +
        'резервы на отпуска и сомнительные долги, перечень прямых расходов в учётной политике. Всё это закреплено в Налоговом кодексе и меняет, когда платить налог на прибыль, а не заменяет его.',
        nalog('profitul'));
    }

    // 3. Упрощёнка: региональная ставка, выбор объекта, пороги
    if (onUsn) {
      add('idea', 'Пониженная ставка УСН в регионе',
        'Регионы вправе снижать ставку УСН «Доходы» с ' + pct(R.usnRateIncome) + ' до ' + pct(R.usnRegionalMinIncome) + ', а «Доходы минус расходы» с ' + pct(R.usnRateProfit) + ' до ' + pct(R.usnRegionalMinProfit) +
        ', обычно для отдельных видов деятельности' + (d.okved ? ' (ваш основной ОКВЭД ' + d.okved + ')' : '') + '. Проверьте закон, который действует ' + inRegion +
        ': он есть на странице УСН в разделе «Особенности регионального законодательства». Если вы подходите под условия, отдельного заявления не нужно.',
        nalog('usn'));
      if (!isIp && inc > 0 && exp != null) {
        var t6 = inc * R.usnRateIncome, t15 = Math.max((inc - exp) * R.usnRateProfit, inc * R.usnMinTax);
        var better = t15 < t6 ? '«Доходы минус расходы»' : '«Доходы»';
        add('idea', 'Какой объект УСН выгоднее',
          'По данным' + yr + ': на «Доходах» налог был бы около ' + rub(t6) + ', на «Доходах минус расходы» около ' + rub(t15) + ' (без учёта уменьшения на взносы). При этих цифрах выгоднее ' + better +
          '. Сменить объект можно с 1 января, уведомив налоговую до 31 декабря.', nalog('usn'));
      }
      if (inc != null && inc > R.ndsFrom * 0.8) {
        add(inc > R.ndsFrom ? 'warn' : 'idea', inc > R.ndsFrom ? 'Доход выше порога НДС на упрощёнке' : 'Доход близок к порогу НДС',
          'Доход' + yr + ' ' + rub(inc) + ', порог освобождения от НДС на УСН ' + rub(R.ndsFrom) + '. Выше него есть выбор: НДС 5% или 7% без вычетов входящего налога или общая ставка с вычетами. ' +
          'Если большинство покупателей — компании на общей системе, им выгоднее общая ставка с вычетами; если частные лица, обычно дешевле пониженная. Посчитайте оба варианта заранее.', nalog('nds'));
      }
      if (inc != null && inc > R.usnIncomeLimit * 0.85) {
        add('warn', 'Доход близок к лимиту УСН',
          'Доход' + yr + ' ' + rub(inc) + ' при лимите ' + rub(R.usnIncomeLimit) + ' на ' + R.year + ' год. При превышении право на УСН теряется с начала квартала, в котором оно случилось.', nalog('usn'));
      }
      if (isIp || exp == null) {
        add('idea', 'Проверьте объект УСН',
          'Ориентир: если расходы, которые можно подтвердить документами, больше 60% дохода, «Доходы минус расходы» ' + pct(R.usnRateProfit) + ' обычно выгоднее, чем «Доходы» ' + pct(R.usnRateIncome) +
          '. На «Доходах» налог уменьшается на страховые взносы, поэтому при большом фонде оплаты труда они тоже могут выиграть. Сменить объект можно с 1 января, уведомив налоговую до 31 декабря.',
          nalog('usn'));
      }
      if (isIp) {
        add('idea', 'Уменьшайте налог на взносы',
          'ИП на УСН «Доходы» уменьшает налог на страховые взносы: без работников на всю сумму взносов «за себя», с работниками не больше чем наполовину. Взносы, уплаченные в течение года, уменьшают и авансовые платежи.', nalog('usn'));
      }
    }

    // 4. ИП: патент и самозанятость
    if (isIp) {
      if (ts.indexOf('PSN') < 0 && (emp == null || emp <= R.psnEmployees)) {
        add('idea', 'Патент для части деятельности',
          'Если вы занимаетесь розницей, бытовыми услугами, сдачей жилья и другими видами из списка ПСН, патент бывает дешевле УСН: его стоимость не зависит от фактического дохода. ' +
          'Условия: до ' + R.psnEmployees + ' работников и доход до ' + rub(R.psnIncomeLimit) + ' в ' + R.year + ' году (в 2027 году порог 15 млн ₽, с 2028 года 10 млн ₽). Стоимость патента ' + inRegion + ' есть на сайте ФНС.',
          nalog('patent'));
      }
      if (emp === 0 || emp == null) {
        add('idea', 'Сравните с самозанятостью',
          'Если работников нет, а доход до 2,4 млн ₽ в год, налог на профессиональный доход (4% с оплат от людей, 6% от компаний) часто дешевле, а обязательных взносов нет. ИП может перейти на него без закрытия ИП.',
          '/kalkulyatory/samozanyatyj-ili-ip/');
      }
    }

    // 4а. Есть работники: выплаты, с которых по закону не начисляются взносы
    if (emp != null && emp >= 1) {
      add('idea', 'Выплаты сотрудникам без взносов',
        'Компенсация за использование личной машины или другого имущества сотрудника в работе не облагается ни НДФЛ, ни взносами, если размер закреплён в договоре и подтверждён документами. ' +
        'С арендной платы за имущество сотрудника удерживается НДФЛ, но взносы не начисляются. Стипендия по ученическому договору тоже не облагается взносами. Всё это должно отражать реальное использование имущества и реальное обучение.');
      add('idea', 'Разовые работы — самозанятым',
        'Проектные и разовые задачи можно отдавать самозанятым: с их вознаграждения компания не платит взносы и не удерживает НДФЛ. Нельзя платить так бывшим сотрудникам в течение двух лет после увольнения, ' +
        'а постоянная работа по графику и под контролем руководителя будет признана трудовыми отношениями с доначислением взносов.');
    }

    // 5. АУСН для небольших компаний с сотрудниками
    if (!onAusn && emp != null && emp >= 1 && emp <= R.ausnEmployees && (inc == null || inc <= R.ausnIncomeLimit)) {
      add('idea', 'Автоматизированная упрощёнка (АУСН)',
        'У вас ' + people(emp) + (inc != null ? ' и доход' + yr + ' ' + rub(inc) : '') + ': это в пределах АУСН (до ' + R.ausnEmployees + ' человек и ' + rub(R.ausnIncomeLimit) + '). ' +
        'На АУСН ставка 8% с доходов или 20% с разницы доходов и расходов, но нет страховых взносов с зарплаты и большей части отчётности. Режим действует не во всех регионах и до конца 2027 года, проверьте свой регион.',
        nalog('autotax_system'));
    }

    // 6. Чего делать нельзя — показываем всегда, если есть хоть одна идея
    if (out.length) {
      add('warn', 'Чего не делать',
        'Не делите бизнес на связанные компании и ИП только ради лимитов спецрежимов, не переоформляйте штатных сотрудников в самозанятых или ИП и не проводите расходы через фирмы без реальной деятельности. ' +
        'Налоговая находит это автоматически по общим адресам, телефонам, IP-адресам, сотрудникам и контрагентам. Итог — доначисление налогов, пени, штраф 40% и возможная уголовная ответственность.',
        '/nalogovye-shemy/');
    }
    return out;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { innValid: innValid, advise: advise, taxIdeas: taxIdeas };
    return;
  }

  /* ---------- страница ---------- */
  var root = document.getElementById('org');
  if (!root) return;
  var FIN = {};
  try { FIN = JSON.parse((document.getElementById('fin') || {}).textContent || '{}'); } catch (e) { FIN = {}; }
  var token = root.getAttribute('data-token') || '';
  var api = (root.getAttribute('data-api') || '').replace(/\/$/, '');
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

  if (!token && !api) {
    form.hidden = true;
    msg.textContent = 'Проверка организаций ещё не подключена: нужен ключ сервиса. Загляните позже.';
    return;
  }

  function freeSourcesBox(d) {
    var wrap = el('div');
    wrap.appendChild(el('h2', null, 'Больше данных бесплатно')).style.marginTop = '22px';
    wrap.appendChild(el('p', 'note-sm', 'В открытых базах ФНС можно бесплатно посмотреть то, чего нет в этой карточке: учредителей, финансовые показатели, долги и лицензии. На этих сайтах найдите организацию по ИНН ' + (d.inn || '') + (d.ogrn ? ' или ОГРН ' + d.ogrn : '') + '.'));
    var ul = el('ul');
    ul.style.margin = '10px 0 0';
    ul.style.paddingLeft = '20px';
    var addLink = function (label, href, desc) {
      var li = el('li');
      li.style.margin = '6px 0';
      var a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = label;
      li.appendChild(a);
      li.appendChild(document.createTextNode(' — ' + desc));
      ul.appendChild(li);
    };
    addLink('ЕГРЮЛ/ЕГРИП на egrul.nalog.ru', 'https://egrul.nalog.ru/index.html', 'учредители, руководители, история изменений — официальная выписка');
    addLink('Бухотчётность на bo.nalog.gov.ru', 'https://bo.nalog.gov.ru/', 'выручка, прибыль, баланс, если организация обязана их сдавать');
    addLink('Прозрачный бизнес на pb.nalog.ru', 'https://pb.nalog.ru/', 'налоговый режим, риски, участие в других организациях');
    addLink('Исполнительные производства на fssp.gov.ru', 'https://fssp.gov.ru/iss/ip', 'долги по решениям суда и приставам');
    addLink('Реестр залогов на reestr-zalogov.ru', 'https://www.reestr-zalogov.ru/search/index', 'заложено ли имущество компании — движимые залоги, бесплатно и без регистрации');
    addLink('Список нелегалов Банка России', 'https://www.cbr.ru/inside/warning-list/', 'компании и сайты с признаками нелегальной деятельности на финансовом рынке: финансовые пирамиды, «чёрные» кредиторы и брокеры');
    addLink('Справочник участников финансового рынка', 'https://www.cbr.ru/finorg/', 'есть ли у банка, МФО, брокера или страховщика лицензия или запись в реестре ЦБ');
    wrap.appendChild(ul);
    return wrap;
  }

  function render(s, advice) {
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

    out.appendChild(freeSourcesBox(d));

    if (api) {
      var aiBox = el('div');
      aiBox.id = 'org-ai';
      out.appendChild(aiBox);
    }

    out.appendChild(el('h2', null, 'Памятка')).style.marginTop = '22px';
    (advice || advise(d, Date.now())).forEach(function (a) {
      var p = el('p', 'tip');
      var b = el('b', null, a.title + '. ');
      if (a.level === 'warn') p.style.borderLeftColor = 'var(--crit-line)';
      p.appendChild(b);
      p.appendChild(document.createTextNode(a.text));
      p.style.margin = '10px 0';
      out.appendChild(p);
    });

    var ideas = taxIdeas(d, FIN.regimes);
    if (ideas.length) {
      out.appendChild(el('h2', null, 'Если это ваша компания: как законно снизить налоги')).style.marginTop = '26px';
      out.appendChild(el('p', 'note-sm', 'Советы по данным реестра' + (d.finance && d.finance.year ? ' за ' + d.finance.year + ' год' : '') + ' и правилам на ' + FIN.regimes.year + ' год. Это не налоговая консультация: перед сменой режима посчитайте всё вместе с бухгалтером.'));
      ideas.forEach(function (a) {
        var p = el('p', 'tip' + (a.level === 'idea' ? ' idea' : ''));
        if (a.level === 'warn') p.style.borderLeftColor = 'var(--crit-line)';
        p.appendChild(el('b', null, a.title + '. '));
        p.appendChild(document.createTextNode(a.text + ' '));
        if (a.link) {
          var l = el('a', null, a.link === '/nalogovye-shemy/' ? 'Какие схемы опасны и почему' : a.link.charAt(0) === '/' ? 'Посчитать' : 'Подробнее на nalog.gov.ru');
          l.href = a.link;
          if (a.link.charAt(0) !== '/') l.rel = 'noopener';
          p.appendChild(l);
        }
        p.style.margin = '10px 0';
        out.appendChild(p);
      });
    }
  }

  /* ---------- ИИ-разбор ---------- */
  function renderAi(box, j) {
    box.textContent = '';
    var h = el('h2', null, 'Экспресс-разбор');
    h.style.marginTop = '22px';
    box.appendChild(h);
    var label = el('p', 'note-sm', 'Подготовлено автоматически по данным реестра. Это не проверка благонадёжности и не консультация: перепроверяйте по ссылкам в шагах.');
    box.appendChild(label);
    var a = j && j.ai;
    if (!a) {
      box.appendChild(el('p', 'note-sm', (j && (j.reason || j.error)) || 'Разбор сейчас недоступен.'));
      return;
    }
    var sum = el('p', null, a.summary);
    sum.style.margin = '10px 0';
    box.appendChild(sum);
    (a.signals || []).forEach(function (sg) {
      var p = el('p', 'tip');
      p.style.margin = '8px 0';
      if (sg.level === 'warn') p.style.borderLeftColor = 'var(--crit-line)';
      p.appendChild(el('b', null, (sg.level === 'warn' ? 'Обратите внимание. ' : sg.level === 'ok' ? 'В порядке. ' : 'К сведению. ')));
      p.appendChild(document.createTextNode(sg.text));
      box.appendChild(p);
    });
    if (a.next_steps && a.next_steps.length) {
      box.appendChild(el('p', null, 'Что проверить дальше:')).style.margin = '14px 0 4px';
      var ol = el('ol');
      a.next_steps.forEach(function (t) { ol.appendChild(el('li', null, t)); });
      box.appendChild(ol);
    }
    if (a.tax_ideas && a.tax_ideas.length) {
      box.appendChild(el('p', null, 'Налоговые идеи для владельца:')).style.margin = '14px 0 4px';
      var ul = el('ul');
      a.tax_ideas.forEach(function (t) { ul.appendChild(el('li', null, t)); });
      box.appendChild(ul);
    }
    if (a.caveat) box.appendChild(el('p', 'note-sm', a.caveat));
  }

  function postApi(path, inn) {
    return fetch(api + path, {
      method: 'POST',
      // с сессией — только когда на сайте включён вход: проверка попадёт в историю вошедшего
      credentials: document.documentElement.getAttribute('data-acct') ? 'include' : 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ inn: inn })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { j.status = r.status; return j; });
    });
  }

  function viaApi(inn) {
    postApi('/api/org', inn).then(function (j) {
      if (j.status !== 200 || !j.suggestion) { msg.textContent = j.error || 'Не получилось получить данные. Попробуйте позже.'; return; }
      msg.textContent = '';
      render(j.suggestion, j.advice);
      accountActions(j.suggestion, j.signedIn);
      var box = document.getElementById('org-ai');
      if (!box) return;
      var pending = el('div', 'ai-pending');
      var spin = el('span', 'spin');
      spin.setAttribute('aria-hidden', 'true');
      pending.appendChild(spin);
      pending.appendChild(document.createTextNode('Готовим разбор — обычно 5–15 секунд, иногда до минуты, если сервер «просыпался» после паузы. Страница не зависла, просто подождите.'));
      box.appendChild(pending);
      postApi('/api/org/ai', inn).then(function (a) { renderAi(box, a); })
        .catch(function () { renderAi(box, { reason: 'Разбор сейчас недоступен. Попробуйте позже.' }); });
    }).catch(function () {
      msg.textContent = 'Не получилось получить данные. Попробуйте позже.';
    });
  }

  /* ---------- кабинет: следить за компанией, «моя компания» ---------- */
  var ACCT = (document.documentElement.getAttribute('data-acct') || '').replace(/\/$/, '');
  function acctCall(method, path, body) {
    return fetch(ACCT + path, {
      method: method, credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.status = r.status; return j; }); });
  }
  function accountActions(s, signedIn) {
    if (!ACCT || !s || !s.data) return;
    var inn = s.data.inn;
    var box = el('div', 'acct-actions');
    if (!signedIn) {
      var p = el('p', 'note-sm');
      var a = el('a', null, 'Войдите');
      a.href = '/vhod/?return=' + encodeURIComponent('/organizacii/#inn=' + inn);
      p.appendChild(a);
      p.appendChild(document.createTextNode(', чтобы следить за изменениями этой компании и сохранять историю проверок.'));
      box.appendChild(p);
    } else {
      var note = el('span', 'note-sm');
      var btn = function (label, fn) {
        var b = el('button', 'share', label); b.type = 'button';
        b.addEventListener('click', function () { b.disabled = true; fn().then(function (t) { note.textContent = t; }, function () { note.textContent = 'Не получилось, попробуйте позже.'; b.disabled = false; }); });
        box.appendChild(b);
      };
      btn('Следить за изменениями', function () {
        return acctCall('POST', '/api/watch', { inn: inn }).then(function (j) { return j.ok ? 'Добавлено в слежение: сообщим, если сменится статус, руководитель или появится долг.' : (j.error || 'Не получилось.'); });
      });
      btn('Это моя компания', function () {
        return acctCall('PATCH', '/api/me', { company_inn: inn }).then(function (j) { return j.user ? 'Сохранено в кабинете как ваша компания.' : (j.error || 'Не получилось.'); });
      });
      box.appendChild(note);
    }
    out.insertBefore(box, out.children[2] || null);
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
    if (api) { viaApi(inn); return; }
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

  var m = /(?:^#|&)inn=(\d{10}|\d{12})/.exec(location.hash);
  if (m) { input.value = m[1]; form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit')); }
})();

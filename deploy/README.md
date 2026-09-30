# Запуск сервера INNSIDER с аккаунтами на Timeweb

Сервер проверки организаций, экспресс-разбора и аккаунтов. Данные пользователей по 152-ФЗ
хранятся только здесь, на сервере в России. После переезда сервер на Render можно отключить.

## 1. Сервер и адрес

1. Timeweb Cloud → Облачные серверы → Создать: Ubuntu 24.04, самая маленькая конфигурация,
   регион — Москва или Санкт-Петербург. Добавьте свой SSH-ключ.
2. В DNS домена fin-check.shop добавьте A-запись `api` → IP сервера.

## 2. Установка

```sh
ssh root@IP_СЕРВЕРА
curl -fsSL https://raw.githubusercontent.com/larkinxx/sut-site/main/deploy/setup.sh -o setup.sh && sh setup.sh
nano /etc/sut/api.env          # заполнить ключи (см. шаг 3)
systemctl restart sut-api caddy
curl https://api.fin-check.shop/health   # должно быть "accounts":true
```

## 3. Ключи

- **DaData и Gemini** — те же, что сейчас на Render.
- **Яндекс ID**: oauth.yandex.ru → «Создать приложение» → веб-сервисы.
  Redirect URI: `https://api.inn-sider.ru/auth/yandex/callback` — ровно `PUBLIC_API_URL` + `/auth/yandex/callback`
  (иначе Яндекс отвечает 400 «redirect_uri не совпадает»; старый `https://api.fin-check.shop/…` можно оставить вторым). Доступы: «Доступ к логину, имени и фамилии»,
  «Доступ к адресу электронной почты». ClientID и Client secret → `YANDEX_CLIENT_ID`, `YANDEX_CLIENT_SECRET`.
- **VK ID**: id.vk.com → «Создать приложение» → платформа «Web». Базовый домен — `inn-sider.ru`,
  доверенный Redirect URL: `https://api.inn-sider.ru/auth/vk/callback` (и `https://api.fin-check.shop/auth/vk/callback`,
  если API открывают по старому адресу). В доступах включите почту. ID приложения → `VK_CLIENT_ID`; секрет не нужен.
- **Telegram**: @BotFather → `/newbot` (или бот канала) → токен в `TELEGRAM_BOT_TOKEN`, имя бота без @ в
  `TELEGRAM_BOT_NAME`. Затем в @BotFather: `/setdomain` → `fin-check.shop` — без этого виджет входа не работает.
- **Почта**: ящик для рассылки кодов (например, noreply@ на Яндекс Почте для домена). В настройках ящика
  создайте пароль приложения для почтовых программ → `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`.

## 4. Сайт

1. В `config/site.json` заполните `operator` — ФИО или название и ИНН оператора персональных данных.
   Без этого сборка с включённым входом остановится: политика конфиденциальности обязательна.
2. В приложении сайта на Timeweb добавьте переменные:
   `ORG_API_URL=https://api.fin-check.shop` и `ACCOUNT_API_URL=https://api.fin-check.shop`, пересоберите сайт.
3. Проверьте вход, кабинет и проверку организации. После этого сервер на Render можно остановить.

## 5. Закон о персональных данных

Подайте уведомление об обработке персональных данных в Роскомнадзор (pd.rkn.gov.ru, один раз, онлайн).
Цели и состав данных — как в политике конфиденциальности на сайте (`/politika/`).

## Обслуживание

- Обновить сервер после изменений в GitHub: `sh /opt/sut-site/deploy/update.sh`
- Логи: `journalctl -u sut-api -f`
- Копии базы: каждый день в 04:30 в `/var/backups/sut/`, хранятся 14 дней.
- Данные ФНС о налогах и численности (`/var/lib/sut/fns.db`): обновляются 26-го числа каждого месяца, лог — `/var/log/sut-fns-import.log`.
  Первый раз после установки (или чтобы обновить вне расписания) запустите вручную — отдельной системной задачей, она не зависит от SSH:
  `systemd-run --unit=fns-import -p User=sut /usr/bin/node /opt/sut-site/scripts/fns-import.mjs /var/lib/sut/fns.db` (от 15 минут до часа: реестр МСП — архив больше 2 ГБ).
  Ход: `journalctl -u fns-import -f`. Не запускайте через `runuser … &` — при обрыве SSH импорт зависает и держит базу.
- Слежение за компаниями запускается само раз в сутки после 08:00 по Москве.

## Команды на сервере из GitHub (без SSH с компьютера)

Задача **Actions → «Сервер: команда»** (`.github/workflows/server.yml`) выполняет на сервере одно из действий `deploy/ops.sh`:
`status` (службы, ход импорта ФНС, число записей в базе, диск и память), `import` (запустить импорт ФНС), `import-stop`,
`update` (то же, что `deploy/update.sh`), `archive-check` (архивы ФНС и итог проверки архива). Её может запускать и Claude.

Скрипт работает от root, поэтому ставится отдельной копией, которую может менять только root: папку `/opt/sut-site`
меняет пользователь сайта `sut`, и запуск скрипта прямо оттуда означал бы, что взлом сайта даёт root. Ключ задачи
привязан к этой копии: по нему нельзя выполнить ничего, кроме действий из списка. Репозиторий публичный, поэтому
скрипт выводит в лог только статусы и счётчики. Настройка — один раз, на сервере под root:

```
install -o root -g root -m 755 /opt/sut-site/deploy/ops.sh /usr/local/sbin/sut-ops
ssh-keygen -t ed25519 -N "" -C github-ops -f /root/github-ops
sed -i '/github-ops/d' /root/.ssh/authorized_keys
echo "restrict,command=\"/usr/local/sbin/sut-ops\" $(cat /root/github-ops.pub)" >> /root/.ssh/authorized_keys
cat /root/github-ops
```

Весь вывод последней команды (от `-----BEGIN` до `-----END … KEY-----`) — в GitHub: **Settings → Secrets and variables →
Actions → New repository secret**, имя `SERVER_SSH_KEY`. Затем `rm /root/github-ops /root/github-ops.pub`.
Ключ сервера, чтобы задача проверяла, что говорит именно с ним: `cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub` —
вывод в **Settings → Secrets and variables → Actions → Variables → New repository variable**, имя `SERVER_HOST_KEY`.

Когда в репозитории меняется `deploy/ops.sh`, новая версия начинает работать только после того, как root поставит её той же
командой `install …` (действие `status` предупреждает, что копия устарела). Отозвать доступ — удалить строку с `github-ops`
из `/root/.ssh/authorized_keys`.

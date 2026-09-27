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
  Redirect URI: `https://api.fin-check.shop/auth/yandex/callback`. Доступы: «Доступ к логину, имени и фамилии»,
  «Доступ к адресу электронной почты». ClientID и Client secret → `YANDEX_CLIENT_ID`, `YANDEX_CLIENT_SECRET`.
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

Ключ задачи привязан к `ops.sh`: по нему нельзя выполнить ничего, кроме этих действий. Репозиторий публичный, поэтому
`ops.sh` выводит в лог только статусы и счётчики. Настройка — один раз, на сервере под root (после `update.sh`, чтобы `ops.sh` уже был):

```
ssh-keygen -t ed25519 -N "" -C github-ops -f /root/github-ops
echo "command=\"/opt/sut-site/deploy/ops.sh\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $(cat /root/github-ops.pub)" >> /root/.ssh/authorized_keys
cat /root/github-ops
```

Скопируйте весь вывод последней команды (от `-----BEGIN` до `-----END … KEY-----` включительно) в GitHub:
**Settings → Secrets and variables → Actions → New repository secret**, имя `SERVER_SSH_KEY`. Затем удалите ключ с сервера:
`rm /root/github-ops /root/github-ops.pub`. Ключ никуда больше не отправляйте. Отозвать доступ — удалить строку с `github-ops`
из `/root/.ssh/authorized_keys`.

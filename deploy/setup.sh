#!/bin/sh
# Первичная настройка облачного сервера Timeweb (Ubuntu 24.04). Запуск под root: sh setup.sh
set -e
apt-get update
apt-get install -y ca-certificates curl gnupg git unzip debian-keyring debian-archive-keyring apt-transport-https
# Node.js 24 (нужна встроенная SQLite)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
# Caddy — HTTPS и прокси
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
# пользователь, код, папки
id sut >/dev/null 2>&1 || useradd --system --home /opt/sut-site --shell /usr/sbin/nologin sut
[ -d /opt/sut-site/.git ] || git clone https://github.com/larkinxx/sut-site.git /opt/sut-site
mkdir -p /var/lib/sut /etc/sut /var/backups/sut
chown -R sut:sut /var/lib/sut /opt/sut-site
[ -f /etc/sut/api.env ] || install -m 600 /opt/sut-site/deploy/api.env.example /etc/sut/api.env
cp /opt/sut-site/deploy/sut-api.service /etc/systemd/system/sut-api.service
cp /opt/sut-site/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable sut-api caddy
# «|| true»: при первой установке заданий ещё нет, и grep без совпадений не должен прерывать скрипт
( crontab -l 2>/dev/null | grep -vE 'sut-site/(deploy/backup.sh|scripts/fns-import.mjs)' || true
  echo '30 4 * * * /opt/sut-site/deploy/backup.sh'
  # открытые данные ФНС обновляются около 25 числа — забираем 26-го
  echo '30 3 26 * * runuser -u sut -- node /opt/sut-site/scripts/fns-import.mjs /var/lib/sut/fns.db >> /var/log/sut-fns-import.log 2>&1' ) | crontab -
echo
echo 'Готово. Дальше: заполните /etc/sut/api.env (nano /etc/sut/api.env), затем: systemctl restart sut-api caddy'
echo 'Данные ФНС (10–15 минут): runuser -u sut -- node /opt/sut-site/scripts/fns-import.mjs /var/lib/sut/fns.db'

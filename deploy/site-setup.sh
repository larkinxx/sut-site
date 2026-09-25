#!/bin/sh
# Перенести сайт fin-check.shop на этот сервер. Запускать ПОСЛЕ того, как в DNS записи @ и www указывают на этот сервер:
#   sh /opt/sut-site/deploy/site-setup.sh
set -e
FORCE=1 sh /opt/sut-site/deploy/site-build.sh
grep -q 'Caddyfile.site' /etc/caddy/Caddyfile || printf '\nimport /opt/sut-site/deploy/Caddyfile.site\n' >> /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy
( crontab -l 2>/dev/null | grep -v site-build.sh || true; echo '*/10 * * * * sh /opt/sut-site/deploy/site-build.sh >> /var/log/sut-site-build.log 2>&1' ) | crontab -
echo "Готово: https://fin-check.shop отдаётся с этого сервера, пересборка каждые 10 минут."

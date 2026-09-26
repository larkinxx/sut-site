#!/bin/sh
# Переезд сайта на новый адрес (по умолчанию innfact.ru) и включение сайта на этом сервере.
# Запускать, когда в DNS нового домена записи @, www и api указывают на этот сервер:
#   sh /opt/sut-site/deploy/move-domain.sh            (или DOMAIN=другой.ru sh …)
set -e
DOMAIN=${DOMAIN:-innfact.ru}
OLD=fin-check.shop
set_env() {   # set_env файл КЛЮЧ значение — заменить строку или добавить в конец
  if grep -q "^$2=" "$1"; then sed -i "s#^$2=.*#$2=$3#" "$1"; else echo "$2=$3" >> "$1"; fi
}
E=/etc/sut/api.env
set_env $E SITE_URL "https://$DOMAIN"
set_env $E PUBLIC_API_URL "https://api.$DOMAIN"
set_env $E COOKIE_DOMAIN ".$DOMAIN"
set_env $E ALLOWED_ORIGINS "https://$DOMAIN,https://www.$DOMAIN,https://$OLD,https://www.$OLD"
S=/etc/sut/site.env
touch $S
set_env $S SITE_URL "https://$DOMAIN"
set_env $S ORG_API_URL "https://api.$DOMAIN"
set_env $S ACCOUNT_API_URL "https://api.$DOMAIN"
set_env $S COMPANY_PAGES 1
FORCE=1 sh /opt/sut-site/deploy/site-build.sh
grep -q 'Caddyfile.site' /etc/caddy/Caddyfile || printf '\nimport /opt/sut-site/deploy/Caddyfile.site\n' >> /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy
systemctl restart sut-api
( crontab -l 2>/dev/null | grep -v site-build.sh || true; echo '*/10 * * * * sh /opt/sut-site/deploy/site-build.sh >> /var/log/sut-site-build.log 2>&1' ) | crontab -
echo "Готово: https://$DOMAIN отдаётся с этого сервера, $OLD перенаправляется на него, пересборка каждые 10 минут."

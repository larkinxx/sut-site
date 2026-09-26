#!/bin/sh
# Собрать сайт на этом сервере (вместо Timeweb App Platform) и выложить в /var/www/fin-check.shop.
# Запуск: sh /opt/sut-site/deploy/site-build.sh   (cron запускает его каждые 10 минут: новости обновляются каждый час)
# Пересобирает, только если в GitHub есть новые коммиты или сайта ещё нет. FORCE=1 — собрать в любом случае.
set -e
REPO=/opt/sut-site
OUT=/var/www/fin-check.shop
mkdir -p /var/www
cd "$REPO"
# git — от имени владельца папки (sut): от root git откажется работать с чужим репозиторием
G="sudo -u sut git"
OLD=$($G rev-parse HEAD)
$G pull -q --ff-only || true
NEW=$($G rev-parse HEAD)
if [ "$OLD" = "$NEW" ] && [ -f "$OUT/index.html" ] && [ -z "$FORCE" ]; then exit 0; fi
# настройки сборки: адрес сайта, адрес API, страницы компаний
if [ ! -f /etc/sut/site.env ]; then
  printf 'SITE_URL=https://innfact.ru\nORG_API_URL=https://api.innfact.ru\nACCOUNT_API_URL=https://api.innfact.ru\nCOMPANY_PAGES=1\n' > /etc/sut/site.env
fi
set -a; . /etc/sut/site.env; set +a
sudo -u sut -E node src/build.mjs >/dev/null
rm -rf "$OUT.new" && cp -a "$REPO/dist" "$OUT.new" && chmod -R a+rX "$OUT.new"
[ -d "$OUT" ] && mv "$OUT" "$OUT.old"
mv "$OUT.new" "$OUT" && rm -rf "$OUT.old"
# если изменился сервер — перезапустить его
if [ "$OLD" != "$NEW" ] && $G diff --name-only "$OLD" "$NEW" | grep -q '^server/'; then systemctl restart sut-api; fi
echo "$(date '+%F %T') сайт собран: $NEW"

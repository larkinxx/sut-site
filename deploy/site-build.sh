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
# последний собранный коммит храним отдельно: код могли обновить и без этой сборки (ops update, deploy/update.sh),
# и тогда сравнение «до и после git pull» ничего не заметило бы
MARK=/var/lib/sut/site-built
$G pull -q --ff-only || true
NEW=$($G rev-parse HEAD)
OLD=$(cat "$MARK" 2>/dev/null || true)
if [ "$OLD" = "$NEW" ] && [ -f "$OUT/index.html" ] && [ -z "$FORCE" ]; then exit 0; fi
# что поменялось с прошлой сборки; неизвестно (первая сборка или история переписана) — считаем, что всё
changed() { [ -z "$OLD" ] || ! $G cat-file -e "$OLD^{commit}" 2>/dev/null || $G diff --name-only "$OLD" "$NEW" | grep -q "$1"; }
# настройки сборки: адрес сайта, адрес API, страницы компаний
if [ ! -f /etc/sut/site.env ]; then
  printf 'SITE_URL=https://inn-sider.ru\nORG_API_URL=https://api.inn-sider.ru\nACCOUNT_API_URL=https://api.inn-sider.ru\nCOMPANY_PAGES=1\n' > /etc/sut/site.env
fi
set -a; . /etc/sut/site.env; set +a
sudo -u sut -E node src/build.mjs >/dev/null
rm -rf "$OUT.new" && cp -a "$REPO/dist" "$OUT.new" && chmod -R a+rX "$OUT.new"
[ -d "$OUT" ] && mv "$OUT" "$OUT.old"
mv "$OUT.new" "$OUT" && rm -rf "$OUT.old"
# если изменился сервер — перезапустить его (шаблоны страниц компаний и отраслей он перечитывает сам)
if [ "$OLD" != "$NEW" ] && changed '^server/'; then systemctl restart sut-api; fi
# если изменились настройки Caddy для сайта — проверить и применить (при ошибке остаются прежние)
if [ "$OLD" != "$NEW" ] && changed '^deploy/Caddyfile.site'; then
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 && systemctl reload caddy || echo "Caddyfile.site с ошибкой — не применён"
fi
echo "$NEW" > "$MARK"
# сообщить Яндексу о новых и изменившихся страницах (IndexNow); сбой отправки сборке не мешает
INDEXNOW_STATE=/var/lib/sut/indexnow.json node scripts/indexnow.mjs || true
echo "$(date '+%F %T') сайт собран: $NEW"

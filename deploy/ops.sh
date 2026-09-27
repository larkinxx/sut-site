#!/bin/sh
# Действия на сервере для задачи GitHub Actions «Сервер: команда» (.github/workflows/server.yml).
# Работает от root, поэтому ставится отдельной копией в /usr/local/sbin/sut-ops (владелец root): папку /opt/sut-site
# может менять пользователь сайта sut, и если бы root запускал скрипт прямо оттуда, взлом сайта давал бы root.
# По той же причине скрипт не вызывает от root ничего из /opt/sut-site — код сайта запускается только от sut.
# Ключ задачи в /root/.ssh/authorized_keys привязан к этой копии (restrict,command="/usr/local/sbin/sut-ops"):
# по нему нельзя выполнить ничего, кроме действий ниже. Новая версия скрипта начинает работать, только когда root
# сам поставит её заново (deploy/README.md) — status подскажет, что копия устарела.
# Репозиторий публичный, вывод виден всем в логе GitHub Actions: только статусы и счётчики,
# без журналов сайта, данных пользователей и секретов.
set -u
DB=/var/lib/sut/fns.db
DATA=/var/lib/sut/opendata
REPO=/opt/sut-site
ACTION=${SSH_ORIGINAL_COMMAND:-status}

counts() {
  # число строк в таблицах ФНС и когда загружен каждый набор — только цифры
  runuser -u sut -- /usr/bin/node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const n = (t) => { try { return db.prepare(`SELECT count(*) AS c FROM ${t}`).get().c; } catch { return "нет таблицы"; } };
    for (const t of ["fns_msp", "fns_finance", "fns_peers", "fns_staff", "fns_tax"]) console.log(`  ${t}: ${n(t)}`);
    try { for (const r of db.prepare("SELECT dataset, rows, loaded_at FROM fns_meta ORDER BY dataset").all()) console.log(`  набор ${r.dataset}: ${r.rows} строк, ${r.loaded_at}`); } catch {}
  ' "$DB"
}

case "$ACTION" in
  status)
    echo "== $(date -u '+%Y-%m-%d %H:%M UTC'), код: $(runuser -u sut -- git -C "$REPO" log -1 --format='%h %s')"
    if [ "$0" != "$REPO/deploy/ops.sh" ] && ! cmp -s "$0" "$REPO/deploy/ops.sh"; then
      echo "== внимание: установленная копия $0 отличается от $REPO/deploy/ops.sh — root должен поставить новую (deploy/README.md)"
    fi
    echo "== службы: сайт $(systemctl is-active sut-api), импорт ФНС $(systemctl is-active fns-import 2>/dev/null || true)"
    echo "== журнал импорта ФНС (последние строки)"
    journalctl -u fns-import --no-pager -o short-iso -n 12 2>/dev/null | sed -E 's/^([^ ]+) [^ ]+ [^ ]+: /\1 /' || true
    echo "== пересчёт статистики: $(systemctl is-active fns-peers 2>/dev/null || true)"
    journalctl -u fns-peers --no-pager -o short-iso -n 3 2>/dev/null | sed -E 's/^([^ ]+) [^ ]+ [^ ]+: /\1 /' || true
    echo "== база ФНС"
    counts
    echo "== диск и память"
    df -h / | tail -1
    free -m | sed -n 2p
    # для ежечасной проверки: сайт не работает или диск почти полон — ошибка, GitHub пришлёт письмо
    if ! systemctl is-active --quiet sut-api; then echo "ТРЕВОГА: сайт на сервере (sut-api) не работает"; exit 1; fi
    used=$(df --output=pcent / | tail -1 | tr -dc 0-9)
    if [ "${used:-0}" -ge 90 ]; then echo "ТРЕВОГА: диск заполнен на ${used}%"; exit 1; fi
    ;;
  import)
    if systemctl is-active --quiet fns-import; then echo "Импорт уже идёт — второй не запускаю."; exit 0; fi
    systemctl reset-failed fns-import 2>/dev/null || true
    systemd-run --unit=fns-import -p User=sut /usr/bin/node /opt/sut-site/scripts/fns-import.mjs "$DB"
    echo "Импорт запущен. Ход — действием status."
    ;;
  peers)
    # только пересчёт статистики похожих компаний (fns_peers, fns_market) по уже загруженным данным — без скачивания
    if systemctl is-active --quiet fns-import || systemctl is-active --quiet fns-peers; then echo "Импорт или пересчёт уже идёт."; exit 0; fi
    systemctl reset-failed fns-peers 2>/dev/null || true
    systemd-run --unit=fns-peers -p User=sut /usr/bin/node /opt/sut-site/scripts/fns-peers.mjs "$DB"
    echo "Пересчёт запущен. Итог — действием status (журнал fns-peers)."
    ;;
  import-stop)
    systemctl stop fns-import 2>/dev/null || true
    pkill -f "unzip-stream.py $DATA" || true
    echo "Импорт остановлен."
    ;;
  update)
    # то же, что deploy/update.sh, но без запуска файлов из репозитория от root
    out=$(runuser -u sut -- git -C "$REPO" pull --ff-only 2>&1); code=$?
    echo "$out" | tail -6
    if [ $code -ne 0 ]; then echo "Обновление не удалось (git pull, код $code)."; exit $code; fi
    systemctl restart sut-api || { echo "Сайт не перезапустился."; exit 1; }
    echo "Сайт перезапущен: $(systemctl is-active sut-api)."
    ;;
  archive-check)
    echo "== архивы ФНС"
    ls -la "$DATA" | tail -n +2 | awk '{print $5, $6, $7, $8, $9}'
    echo "== скачивание и распаковка по журналу импорта (перепроверки частей, битые файлы, итоги)"
    journalctl -u fns-import --no-pager -o short-iso -n 400 2>/dev/null \
      | grep -E 'ИТОГО|битый|повреждён|контрольная|перепроверяю|заменено|испорчен|скачан' | tail -15 \
      | sed -E 's/^([^ ]+) [^ ]+ [^ ]+: /\1 /' || true
    ;;
  *)
    echo "Неизвестное действие: $ACTION. Можно: status, import, peers, import-stop, update, archive-check."
    exit 2
    ;;
esac

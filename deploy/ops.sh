#!/bin/sh
# Действия на сервере для задачи GitHub Actions «Сервер: команда» (.github/workflows/server.yml).
# Ключ этой задачи в /root/.ssh/authorized_keys привязан к скрипту (command="/opt/sut-site/deploy/ops.sh"):
# по нему нельзя выполнить ничего, кроме действий ниже, даже если ключ утечёт. Настройка — deploy/README.md.
# Репозиторий публичный, вывод виден всем в логе GitHub Actions: только статусы и счётчики,
# без журналов сайта, данных пользователей и секретов.
set -u
DB=/var/lib/sut/fns.db
DATA=/var/lib/sut/opendata
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
    echo "== $(date -u '+%Y-%m-%d %H:%M UTC'), код: $(runuser -u sut -- git -C /opt/sut-site log -1 --format='%h %s')"
    echo "== службы: сайт $(systemctl is-active sut-api), импорт ФНС $(systemctl is-active fns-import 2>/dev/null || true)"
    echo "== журнал импорта ФНС (последние строки)"
    journalctl -u fns-import --no-pager -o short-iso -n 12 2>/dev/null | sed -E 's/^([^ ]+) [^ ]+ [^ ]+: /\1 /' || true
    echo "== база ФНС"
    counts
    echo "== диск и память"
    df -h / | tail -1
    free -m | sed -n 2p
    ;;
  import)
    if systemctl is-active --quiet fns-import; then echo "Импорт уже идёт — второй не запускаю."; exit 0; fi
    systemctl reset-failed fns-import 2>/dev/null || true
    systemd-run --unit=fns-import -p User=sut /usr/bin/node /opt/sut-site/scripts/fns-import.mjs "$DB"
    echo "Импорт запущен. Ход — действием status."
    ;;
  import-stop)
    systemctl stop fns-import 2>/dev/null || true
    pkill -f "unzip -p $DATA" || true
    echo "Импорт остановлен."
    ;;
  update)
    sh /opt/sut-site/deploy/update.sh 2>&1 | grep -vE 'Main PID|CGroup|Tasks|Memory|CPU' | tail -8
    ;;
  archive-check)
    echo "== архивы ФНС"
    ls -la "$DATA" | tail -n +2 | awk '{print $5, $6, $7, $8, $9}'
    if [ -f "$DATA/check.txt" ]; then
      echo "== проверка архива реестра МСП (unzip -t)"
      tail -4 "$DATA/check.txt"
      echo "повреждённых файлов: $(grep -c 'bad zipfile' "$DATA/check.txt" || true)"
    else
      echo "Проверки архива не было."
    fi
    ;;
  *)
    echo "Неизвестное действие: $ACTION. Можно: status, import, import-stop, update, archive-check."
    exit 2
    ;;
esac

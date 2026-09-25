#!/bin/sh
# Ежедневная копия базы аккаунтов (cron: 30 4 * * * /opt/sut-site/deploy/backup.sh). Хранит 14 последних копий.
set -e
umask 077   # в копиях персональные данные — читать может только root
DIR=/var/backups/sut
OUT="$DIR/sut-$(date +%F).db"
mkdir -p "$DIR"
rm -f "$OUT.tmp"
# VACUUM INTO не перезаписывает файл, поэтому пишем во временный и заменяем (повторный запуск в тот же день не падает)
node -e "new (require('node:sqlite').DatabaseSync)('/var/lib/sut/sut.db').exec(\"VACUUM INTO '$OUT.tmp'\")"
mv -f "$OUT.tmp" "$OUT"
find "$DIR" -name 'sut-*.db' -mtime +14 -delete

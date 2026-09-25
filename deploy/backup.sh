#!/bin/sh
# Ежедневная копия базы аккаунтов (cron: 30 4 * * * /opt/sut-site/deploy/backup.sh). Хранит 14 последних копий.
set -e
umask 077   # в копиях персональные данные — читать может только root
DIR=/var/backups/sut
mkdir -p "$DIR"
node -e "new (require('node:sqlite').DatabaseSync)('/var/lib/sut/sut.db').exec(\"VACUUM INTO '$DIR/sut-$(date +%F).db'\")"
find "$DIR" -name 'sut-*.db' -mtime +14 -delete

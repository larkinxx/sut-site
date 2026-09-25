#!/bin/sh
# Обновить сервер до свежей версии из GitHub: sh /opt/sut-site/deploy/update.sh
set -e
cd /opt/sut-site && sudo -u sut git pull --ff-only && systemctl restart sut-api && systemctl --no-pager status sut-api | head -5

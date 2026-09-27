#!/bin/bash
# Подготовка облачной сессии Claude Code: у проекта нет npm-зависимостей (только встроенные модули Node),
# поэтому ставить нечего — проверяем, что версии подходят для тестов (npm run test:server) и проверки (npm run lint).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# node:sqlite (база ФНС, аккаунты) — Node 22.5 и новее
node -e '
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) { console.error("Нужен Node 22.5+, сейчас " + process.versions.node); process.exit(1); }
'
# распаковка архивов ФНС — scripts/unzip-stream.py
command -v python3 >/dev/null || { echo "Нужен python3 (scripts/unzip-stream.py)" >&2; exit 1; }

# node:sqlite пока «экспериментальный» — без этого предупреждение забивает вывод тестов
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export NODE_OPTIONS="--disable-warning=ExperimentalWarning"' >> "$CLAUDE_ENV_FILE"
fi
echo "Окружение готово: Node $(node --version), $(python3 --version)"

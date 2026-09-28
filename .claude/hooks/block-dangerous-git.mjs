// PreToolUse-хук: не даёт Claude выполнять необратимые команды git (по мотивам mattpocock/skills git-guardrails).
// Обычный push в рабочую ветку разрешён; запрещены перезапись истории, push в main и удаление несохранённой работы.
let raw = '';
process.stdin.on('data', (c) => { raw += c; }).on('end', () => {
  let cmd = '';
  try { cmd = String(JSON.parse(raw).tool_input?.command || ''); } catch { process.exit(0); }
  const RULES = [
    [/\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/, 'принудительный push перезаписывает историю'],
    [/\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*\s(origin\s+)?(\S+:)?(main|master)\b/, 'push напрямую в main — только через PR и «слей» владельца'],
    [/\bgit\b[^\n;&|]*\breset\s+--hard\b/, 'reset --hard стирает несохранённые изменения'],
    [/\bgit\b[^\n;&|]*\bclean\s+-\S*f/, 'clean -f удаляет неотслеживаемые файлы'],
    [/\bgit\b[^\n;&|]*\bbranch\s+(-D|--delete\s+--force)\b/, 'branch -D удаляет неслитую ветку'],
    [/\bgit\b[^\n;&|]*\b(checkout|restore)\s+(--\s+)?\.(\s|$)/, 'checkout/restore . отбрасывает все правки']
  ];
  for (const [re, why] of RULES) {
    if (re.test(cmd)) { process.stderr.write(`Заблокировано хуком git-guardrails: ${why}. Если это действительно нужно — попросите владельца выполнить команду самому.\n`); process.exit(2); }
  }
  process.exit(0);
});

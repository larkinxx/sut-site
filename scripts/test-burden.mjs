// Тесты калькулятора «Налоговая нагрузка» (public/burden.js): цифры сверены вручную по формулам НК
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const FIN = JSON.parse(fs.readFileSync(new URL('../config/finance.json', import.meta.url), 'utf8'));
const ctx = { globalThis: null };
ctx.globalThis = ctx;
vm.runInNewContext(fs.readFileSync(new URL('../public/burden.js', import.meta.url), 'utf8'), ctx);
const { compute, prog } = ctx.INNBurden;
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1, `${m}: ${a} вместо ${b}`);
const row = (r, id) => r.rows.find((x) => x.id === id);

// шкала НДФЛ: 2,4 млн × 13% + 2,6 млн × 15% + 5 млн × 18% = 312 000 + 390 000 + 900 000 (пороги из ст. 224 НК)
near(prog(FIN.burden.ndflScale, 10e6), 312000 + 390000 + 900000, 'шкала НДФЛ');
near(prog(FIN.burden.ndflScale, 1e6), 130000, 'шкала НДФЛ, первая ступень');

// пример для ручной проверки: ИП, услуги, доход 6 млн, расходы 1,5 млн, без сотрудников
const base = { income: 6e6, expenses: 1.5e6, staff: 0, salary: 60000, activity: 'uslugi', legal: 0.5, pvd: 0 };
let r = compute(FIN, base);
// взносы ИП: 57 390 + 1% × (6 000 000 − 300 000) = 114 390, налог 360 000 − 114 390 → вместе ровно 6%
near(row(r, 'usn6').ip.total, 360000, 'УСН 6% ИП');
near(row(r, 'usn6').ul.total, 360000, 'УСН 6% ООО без сотрудников');
// УСН 15%: взносы 57 390 + 1% × 4 200 000 = 99 390; налог 15% × (4 500 000 − 99 390) = 660 091,5
near(row(r, 'usn15').ip.total, 660091.5 + 99390, 'УСН 15% ИП');
near(row(r, 'usn15').ul.total, 675000, 'УСН 15% ООО');
// ОСНО ИП: доход и расход без НДС 5 млн и 1,25 млн; взносы 57 390 + 1% × (3 750 000 − 300 000); НДФЛ по шкале; НДС 750 000
const own = 57390 + 34500;
near(row(r, 'osno').ip.total, prog(FIN.burden.ndflScale, 5e6 - (1.25e6 + own)) + own + 750000, 'ОСНО ИП');
near(row(r, 'osno').ul.total, 937500 + 750000, 'ОСНО ООО: прибыль 25% и НДС');
near(row(r, 'ausn8').ip.total, 480000, 'АУСН 8%');
near(row(r, 'ausn20').ip.total, 900000, 'АУСН 20%');
assert.equal(row(r, 'npd').ip.ok, false, 'доход больше 2,4 млн — самозанятость недоступна');
assert.equal(row(r, 'npd').ul.ok, false);
assert.equal(row(r, 'psn').ip.partial, true, 'без потенциального дохода патент не считаем');
assert.equal(row(r, 'psn').ul.ok, false, 'патент только для ИП');
assert.equal(r.best.ip.id, 'usn6');
r = compute(FIN, { ...base, pvd: 1e6 });
// патент: 6% × 1 млн = 60 000, взносы 57 390 + 1% × 700 000 = 64 390 закрывают налог целиком
near(row(r, 'psn').ip.total, 64390, 'патент: остаются только взносы');
assert.equal(r.best.ip.id, 'psn');

// с сотрудниками: двое по 60 000 ₽ в месяц; взносы 30% + 0,2% = 217 440 на человека
r = compute(FIN, { ...base, staff: 2 });
near(r.staffContrib, 434880, 'взносы за сотрудников');
// УСН 6% с сотрудниками: вычет не больше половины налога → 180 000 + взносы ИП 114 390 + 434 880
near(row(r, 'usn6').ip.total, 180000 + 114390 + 434880, 'УСН 6% ИП с сотрудниками');
near(row(r, 'ausn8').ip.total, 480000 + FIN.burden.ausn.injuryYear, 'АУСН: только взнос на травматизм');
assert.equal(row(r, 'npd').ip.ok, false, 'самозанятым нельзя нанимать');
assert.equal(compute(FIN, { ...base, staff: 6 }).rows.find((x) => x.id === 'ausn8').ip.ok, false, 'АУСН до 5 сотрудников');

// самозанятый: 1,2 млн, половина от компаний — как в калькуляторе «Самозанятый или ИП»: 600к × 4% + 600к × 6% − 10 000
r = compute(FIN, { ...base, income: 1.2e6, expenses: 0, legal: 0.5 });
near(row(r, 'npd').ip.total, 600000 * 0.04 + 600000 * 0.06 - 10000, 'НПД');
// торговля: самозанятость недоступна, оптовая торговля — ещё и патент
r = compute(FIN, { ...base, income: 1.2e6, activity: 'retail' });
assert.equal(row(r, 'npd').ip.ok, false);
assert.equal(row(r, 'psn').ip.ok, true);
r = compute(FIN, { ...base, income: 1.2e6, activity: 'wholesale' });
assert.equal(row(r, 'psn').ip.ok, false);
// финансы: упрощённые режимы недоступны, остаётся ОСНО
r = compute(FIN, { ...base, activity: 'finance' });
assert.equal(r.best.ip.id, 'osno');

// НДС на УСН с превышением порога: доход 30 млн → ставка 7% не нужна, до 272,5 млн ставка 5% и выручка включает НДС
r = compute(FIN, { ...base, income: 30e6, expenses: 0 });
const nds = 30e6 * 0.05 / 1.05;
near(row(r, 'usn6').ul.total, (30e6 - nds) * 0.06 + nds, 'УСН ООО с НДС 5%');
// лимит УСН
assert.equal(compute(FIN, { ...base, income: FIN.regimes.usnIncomeLimit + 1 }).rows.find((x) => x.id === 'usn6').ip.ok, false);
console.log('Все тесты калькулятора налоговой нагрузки прошли');

// ИИ-помощник раздела «Юрист»: POST /api/lawyer { question } — только для подписчиков INNSIDER Ultima.
// Отвечает по законодательству РФ со ссылками на статьи, с пометкой, что это не юридическая консультация,
// и советует юриста, когда дело спорное. Вопросы не сохраняем и не пишем в журнал — только счётчик за день.

export const LAWYER_SYSTEM = `Ты — помощник юриста для владельцев малого бизнеса в России на сайте INNSIDER. Отвечаешь на вопросы по законодательству Российской Федерации: гражданскому, налоговому, трудовому, арбитражному процессу, закону о самозанятых.

ПРАВИЛА
1. Опирайся только на действующее законодательство РФ. Каждое утверждение о правах, обязанностях, сроках и суммах подкрепляй ссылкой на конкретную статью (например, «статья 395 ГК РФ», «пункт 3 статьи 88 НК РФ»).
2. Не выдумывай номера статей, сроки и суммы. Если не уверен в номере статьи или цифре — так и напиши и предложи уточнить норму в КонсультантПлюс или Гаранте. Лучше меньше ссылок, но верных.
3. Не помогай уклоняться от налогов, скрывать доходы, выводить имущество от кредиторов, оформлять фиктивные документы или обходить закон — вежливо откажи и объясни риски.
4. Если ситуация спорная, сумма значительная, уже идёт суд или проверка, есть риск уголовной ответственности или увольнения с нарушением — прямо советуй обратиться к юристу (needLawyer = true).
5. Пиши простым языком для предпринимателя без юридического образования: суть, что делать по шагам, сроки, риски. Без воды, не длиннее 2500 знаков.
6. Если вопрос не юридический — коротко скажи, что помогаешь только с правовыми вопросами бизнеса.
7. Если на сайте есть подходящий документ, упомяни его: претензия о долге с расчётом процентов, акт сверки, ответ на требование налоговой, уведомление о расторжении договора, договор с самозанятым (раздел «Документы по ИНН»).

Ответь строго JSON без пояснений вокруг:
{"answer": "текст ответа, абзацы через \\n\\n, шаги — строками, начинающимися с «1.», «2.»…", "laws": ["статья 395 ГК РФ", "…"], "needLawyer": true|false}`;

const MAX_Q = 2000, MIN_Q = 10;

export function createLawyer({ ask, isPro, userOf, perUserDay = 30, dailyLimit = 1000, now = () => Date.now(), count = () => {} }) {
  let day = { key: '', n: 0, users: new Map() };
  const today = () => new Date(now() + 3 * 3600e3).toISOString().slice(0, 10);

  function parse(text) {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    let j = null;
    if (a >= 0 && b > a) { try { j = JSON.parse(text.slice(a, b + 1)); } catch { j = null; } }
    if (!j || typeof j.answer !== 'string') j = { answer: String(text || '').trim(), laws: [], needLawyer: true };
    return {
      answer: j.answer.slice(0, 6000),
      laws: (Array.isArray(j.laws) ? j.laws : []).filter((x) => typeof x === 'string').map((x) => x.slice(0, 120)).slice(0, 12),
      needLawyer: j.needLawyer !== false
    };
  }

  // true — запрос обработан здесь
  async function handle(req, res, url, { send, readBody }) {
    if (url.pathname !== '/api/lawyer') return false;
    if (req.method !== 'POST') { send(res, 405, { error: 'Только POST' }); return true; }
    if (!ask) { send(res, 503, { error: 'Помощник сейчас не подключён.' }); return true; }
    const u = userOf(req);
    if (!u) { send(res, 401, { error: 'Войдите, чтобы задать вопрос.', needLogin: true }); return true; }
    if (!isPro(u)) { send(res, 403, { error: 'Помощник юриста доступен по подписке INNSIDER Ultima.', needPro: true }); return true; }
    let body;
    try { body = await readBody(req, 16 * 1024); } catch { send(res, 400, { error: 'Не удалось прочитать вопрос.' }); return true; }
    const q = String((body && body.question) || '').replace(/\s+/g, ' ').trim();
    if (q.length < MIN_Q) { send(res, 400, { error: 'Опишите ситуацию подробнее.' }); return true; }
    if (q.length > MAX_Q) { send(res, 400, { error: `Вопрос длиннее ${MAX_Q} знаков — сократите его.` }); return true; }
    const k = today();
    if (day.key !== k) day = { key: k, n: 0, users: new Map() };
    const mine = day.users.get(u.id) || 0;
    if (mine >= perUserDay) { send(res, 429, { error: `На сегодня лимит — ${perUserDay} вопросов. Продолжим завтра.` }); return true; }
    if (day.n >= dailyLimit) { send(res, 429, { error: 'Помощник сегодня перегружен. Попробуйте завтра.' }); return true; }
    day.n++; day.users.set(u.id, mine + 1);
    count('lawyer');
    try {
      const out = parse(await ask(`Вопрос предпринимателя:\n${q}`, LAWYER_SYSTEM));
      send(res, 200, { ...out, left: perUserDay - mine - 1 });
    } catch (e) {
      console.error('lawyer:', e.message);
      day.users.set(u.id, mine); day.n--;   // неудачная попытка не расходует лимит
      send(res, 502, { error: 'Помощник не ответил. Попробуйте ещё раз через минуту.' });
    }
    return true;
  }
  return { handle, parse };
}

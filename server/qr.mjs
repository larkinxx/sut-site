// QR-код в SVG без зависимостей: байтовый режим, уровень коррекции M (15%), версии 1–6 (до 106 байт) —
// хватает для адреса сертификата. Нужен, чтобы с бумажного отчёта сертификат проверялся телефоном.

// версия → [кодовых слов коррекции на блок, [число блоков, данных в блоке]…], уровень M
const EC_M = { 1: [10, [1, 16]], 2: [16, [1, 28]], 3: [26, [1, 44]], 4: [18, [2, 32]], 5: [24, [2, 43]], 6: [16, [4, 27]] };
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };

// арифметика в поле Галуа GF(256) с порождающим многочленом 0x11d
const EXP = new Array(512), LOG = new Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsEc(data, n) {
  let g = [1];   // порождающий многочлен (x - α^0)…(x - α^(n-1))
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    g.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= mul(c, EXP[i]); });
    g = next;
  }
  const r = data.concat(new Array(n).fill(0));
  for (let i = 0; i < data.length; i++) {
    const c = r[i];
    if (c) for (let j = 0; j < g.length; j++) r[i + j] ^= mul(g[j], c);
  }
  return r.slice(data.length);
}

function codewords(bytes, ver) {
  const [ecn, [blocks, per]] = EC_M[ver], cap = blocks * per;
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(0b0100, 4); put(bytes.length, 8); bytes.forEach((b) => put(b, 8));
  put(0, Math.min(4, cap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad);
  const ds = [], es = [];
  for (let b = 0; b < blocks; b++) { const d = data.slice(b * per, (b + 1) * per); ds.push(d); es.push(rsEc(d, ecn)); }
  const out = [];
  for (let i = 0; i < per; i++) ds.forEach((d) => out.push(d[i]));
  for (let i = 0; i < ecn; i++) es.forEach((e) => out.push(e[i]));
  return out;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

function formatBits(mask) {
  const d = (0b00 << 3) | mask;   // уровень M = 00
  let v = d << 10;
  for (let i = 14; i >= 10; i--) if ((v >>> i) & 1) v ^= 0x537 << (i - 10);
  return ((d << 10) | v) ^ 0x5412;
}

function build(ver, cw, mask) {
  const n = 17 + ver * 4, m = [...Array(n)].map(() => new Array(n).fill(null)), fn = [...Array(n)].map(() => new Array(n).fill(false));
  const set = (r, c, v) => { m[r][c] = v; fn[r][c] = true; };
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const y = r0 + r, x = c0 + c;
      if (y < 0 || x < 0 || y >= n || x >= n) continue;
      const inR = r >= 0 && r <= 6, inC = c >= 0 && c <= 6;
      set(y, x, inR && inC && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)));
    }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const al = ALIGN[ver];
  for (const r of al) for (const c of al) {
    if ((r === 6 && c === 6) || (r === 6 && c === al[al.length - 1]) || (r === al[al.length - 1] && c === 6)) continue;
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) set(r + y, c + x, Math.max(Math.abs(y), Math.abs(x)) !== 1);
  }
  // места под формат (заполним ниже)
  for (let i = 0; i < 9; i++) { if (!fn[8][i]) set(8, i, false); if (!fn[i][8]) set(i, 8, false); }
  for (let i = 0; i < 8; i++) { set(8, n - 1 - i, false); set(n - 1 - i, 8, false); }
  set(n - 8, 8, true);   // тёмный модуль — после резерва под формат, иначе затрётся
  // данные змейкой снизу вверх по парам столбцов
  let bit = 0;
  const bits = cw.flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (b >>> i) & 1));
  for (let col = n - 1, up = true; col > 0; col -= 2, up = !up) {
    if (col === 6) col--;
    for (let k = 0; k < n; k++) {
      const r = up ? n - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (fn[r][c]) continue;
        const v = bit < bits.length ? bits[bit] === 1 : false;
        bit++;
        m[r][c] = MASKS[mask](r, c) ? !v : v;
      }
    }
  }
  const f = formatBits(mask), fb = (i) => ((f >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) m[i][8] = fb(i);
  m[7][8] = fb(6); m[8][8] = fb(7); m[8][7] = fb(8);
  for (let i = 9; i < 15; i++) m[8][14 - i] = fb(i);
  for (let i = 0; i < 8; i++) m[8][n - 1 - i] = fb(i);
  for (let i = 8; i < 15; i++) m[n - 15 + i][8] = fb(i);
  return m;
}

// штраф по правилам стандарта: выбираем маску, при которой кодом легче читать
function penalty(m) {
  const n = m.length;
  let p = 0;
  for (const line of [m, m[0].map((_, c) => m.map((row) => row[c]))]) {
    for (const row of line) {
      for (let i = 0, run = 1; i < n; i++) {
        if (i + 1 < n && row[i + 1] === row[i]) run++;
        else { if (run >= 5) p += run - 2; run = 1; }
      }
      const s = row.map((v) => (v ? 1 : 0)).join('');
      p += 40 * ((s.match(/(?=10111010000|00001011101)/g) || []).length);
    }
  }
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) p += 3;
  const dark = m.flat().filter(Boolean).length;
  return p + Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
}

export function qrMatrix(text) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  const ver = [1, 2, 3, 4, 5, 6].find((v) => { const [, [b, per]] = EC_M[v]; return 12 + bytes.length * 8 <= b * per * 8; });
  if (!ver) throw new Error('QR: слишком длинный текст');
  const cw = codewords(bytes, ver);
  let best = null, bestP = Infinity;
  for (let mask = 0; mask < 8; mask++) { const m = build(ver, cw, mask), p = penalty(m); if (p < bestP) { best = m; bestP = p; } }
  return best;
}

// SVG: один path, поле 4 модуля, цвет берётся из currentColor — в тёмной теме и в печати выглядит правильно
export function qrSvg(text, { size = 132, label = 'QR-код' } = {}) {
  const m = qrMatrix(text), n = m.length, q = 4;
  let d = '';
  m.forEach((row, r) => row.forEach((v, c) => { if (v) d += `M${c + q} ${r + q}h1v1h-1z`; }));
  return `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" width="${size}" height="${size}" role="img" aria-label="${label}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path fill="#111" d="${d}"/></svg>`;
}

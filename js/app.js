import { Chess, validateFen, DEFAULT_POSITION } from '../lib/chess.js';
import { Engine } from './engine.js';
import { Board, loadPieceSymbols } from './board.js';

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------
const LS_KEY = 'chess-advisor:v1';
const TIMES = [500, 1000, 2000, 5000];

// Сила игры бота. «Как человек» и «Слабее» иногда играют не лучший ход, а один из
// следующих вариантов MultiPV, если он теряет не больше maxDrop процентных пунктов
// шанса на победу (та же шкала, что у «точности» в разборах партий).
// Грубых зевков бот не делает; мат в N ходов не упускает.
// «Монстр» — полная сила: один вариант вместо четырёх (весь поиск уходит в лучший ход)
// и обдумывание на времени соперника (кэш движка уже заполнен, когда тот сходит).
const STRENGTHS = {
  monster: { pBest: 1, maxDrop: 0, multiPv: 1, ponder: true },
  max:   { pBest: 1,    maxDrop: 0 },
  human: { pBest: 0.55, maxDrop: 7 },   // ≈ 88–92 % точности
  weak:  { pBest: 0.35, maxDrop: 14 },  // ≈ 78–85 % точности
};

const state = {
  startFen: DEFAULT_POSITION,
  moves: [],          // ходы в UCI (e2e4, e7e8q)
  botColor: 'w',      // бот всегда снизу
  mode: 'auto',       // 'auto' | 'hint'
  movetime: 2000,
  strength: 'max',    // ключ STRENGTHS
  started: false,
};

let game = new Chess();
let history = [];     // verbose-ходы chess.js, параллельно state.moves
let analysis = null;  // { fen, lines, depth, best, final }
let lastEval = null;  // { cp|mate (с точки зрения белых), depth }
let engineReady = false;
let engineFailed = false;
let piecesReady = false;
let promoResolve = null;
let fenBotColor = 'w';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Хранилище
// ---------------------------------------------------------------------------
function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch (_) { /* приватный режим и т.п. */ }
}

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s && typeof s === 'object') {
      if (typeof s.startFen === 'string' && validateFen(s.startFen).ok) state.startFen = s.startFen;
      if (Array.isArray(s.moves)) state.moves = s.moves.filter((m) => typeof m === 'string');
      if (s.botColor === 'w' || s.botColor === 'b') state.botColor = s.botColor;
      if (s.mode === 'auto' || s.mode === 'hint') state.mode = s.mode;
      if (TIMES.includes(s.movetime)) state.movetime = s.movetime;
      if (s.strength in STRENGTHS) state.strength = s.strength;
      state.started = !!s.started;
    }
  } catch (_) { /* испорченные данные — начинаем заново */ }
}

// ---------------------------------------------------------------------------
// Нотация
// ---------------------------------------------------------------------------
const RU = { K: 'Кр', Q: 'Ф', R: 'Л', B: 'С', N: 'К' };

function sanRu(san) {
  if (san === PASS) return 'пропуск';
  return san
    .replace(/^O-O-O/, '0-0-0')
    .replace(/^O-O/, '0-0')
    .replace(/^([KQRBN])/, (_, p) => RU[p])
    .replace(/=([QRBN])/, (_, p) => RU[p]);
}

/** Развёрнутая запись для повторения на доске: Кg1–f3, e7:d8Ф, 0-0. */
function longRu(m) {
  if (m.san.startsWith('O-O')) return sanRu(m.san);
  const piece = m.piece === 'p' ? '' : RU[m.piece.toUpperCase()];
  const sep = m.captured ? '×' : '–';
  const promo = m.promotion ? RU[m.promotion.toUpperCase()] : '';
  const suffix = /[+#]$/.test(m.san) ? m.san.slice(-1) : '';
  return piece + m.from + sep + m.to + promo + suffix;
}

function uciToMove(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined };
}

/** Пропуск хода соперника (он сходил и отменил ход) хранится как '--'. */
const PASS = '--';

function applyUci(g, uci) {
  return uci === PASS ? g.move(null) : g.move(uciToMove(uci));
}

function colorName(c, gen = false) {
  if (gen) return c === 'w' ? 'белых' : 'чёрных';
  return c === 'w' ? 'белые' : 'чёрные';
}

// ---------------------------------------------------------------------------
// Партия
// ---------------------------------------------------------------------------
function rebuild() {
  game = new Chess(state.startFen);
  history = [];
  const ok = [];
  for (const uci of state.moves) {
    let m = null;
    try { m = applyUci(game, uci); } catch (_) { m = null; }
    if (!m) break;
    ok.push(uci);
    history.push(m);
  }
  state.moves = ok;
}

function isBotTurn() {
  return state.started && game.turn() === state.botColor;
}

function gameOverText() {
  if (game.isCheckmate()) {
    const loser = game.turn();
    const winner = loser === 'w' ? 'b' : 'w';
    const who = winner === state.botColor ? 'Победил бот' : 'Победил соперник';
    return `Мат! ${who} (${colorName(winner)}).`;
  }
  if (game.isStalemate()) return 'Пат — ничья.';
  if (game.isInsufficientMaterial()) return 'Ничья: недостаточно материала для мата.';
  if (game.isThreefoldRepetition()) return 'Ничья: троекратное повторение позиции.';
  if (game.isDrawByFiftyMoves()) return 'Ничья по правилу 50 ходов.';
  if (game.isDraw()) return 'Ничья.';
  return null;
}

function resultTag() {
  if (game.isCheckmate()) return game.turn() === 'w' ? '0-1' : '1-0';
  if (game.isGameOver()) return '1/2-1/2';
  return '*';
}

/** Сделать ход. Возвращает true, если ход легален. */
function playMove(uci) {
  let m = null;
  try { m = game.move(uciToMove(uci)); } catch (_) { m = null; }
  if (!m) return false;
  state.moves.push(m.from + m.to + (m.promotion || ''));
  history.push(m);
  save();
  afterChange();
  return true;
}

function afterChange() {
  engine?.cancel();
  analysis = null;
  render();
  if (!state.started || game.isGameOver()) return;
  if (isBotTurn()) startSearch();
  else startPonder();
}

/** «Монстр»: пока соперник думает, движок анализирует позицию (go infinite). */
function startPonder() {
  const cfg = STRENGTHS[state.strength];
  if (!cfg?.ponder || !engine || engineFailed) return;
  if (!state.started || game.isGameOver() || isBotTurn()) return;
  engine.search(game.fen(), 0, () => {}, () => {}, { multiPv: 1 });
}

function startSearch() {
  const fen = game.fen();
  analysis = { fen, lines: [], depth: 0, best: null, final: false };
  render();
  if (!engine || engineFailed) return;
  const cfg = STRENGTHS[state.strength] || STRENGTHS.max;
  engine.search(
    fen,
    state.movetime,
    (lines, job) => {
      if (!analysis || analysis.fen !== fen || game.fen() !== fen) return;
      analysis.lines = lines;
      analysis.depth = job.depth;
      analysis.best = lines[0]?.pv[0] || analysis.best;
      updateEval(lines[0], job.depth, fen);
      renderAnalysis();
    },
    (best) => {
      // устаревший bestmove (позиция уже другая) — игнорируем
      if (!analysis || analysis.fen !== fen || game.fen() !== fen) return;
      analysis.best = chooseMove(analysis.lines, best || analysis.best);
      analysis.final = true;
      if (state.mode === 'auto' && analysis.best) {
        playMove(analysis.best);
      } else {
        render();
      }
    },
    { multiPv: cfg.multiPv || 4 },
  );
}

/** Шанс на победу (0–100) стороны, которая ходит, по оценке варианта. */
function winPct(line) {
  if (line.mate != null) return line.mate > 0 ? 100 : 0;
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * line.cp)) - 1);
}

/** Выбор хода с учётом силы: иногда — не лучший, но без грубых ошибок. */
function chooseMove(lines, best) {
  const cfg = STRENGTHS[state.strength] || STRENGTHS.max;
  const top = lines.find((l) => l.multipv === 1);
  if (cfg.pBest >= 1 || !top || lines.length < 2) return best;
  if (Math.random() < cfg.pBest) return best;
  const topWin = winPct(top);
  const alts = lines.filter((l) => {
    if (l.multipv === 1 || !l.pv?.length) return false;
    if (top.mate != null && top.mate > 0 && !(l.mate != null && l.mate > 0)) return false; // мат не упускаем
    return topWin - winPct(l) <= cfg.maxDrop;
  });
  if (!alts.length) return best;
  return alts[Math.floor(Math.random() * alts.length)].pv[0];
}

function updateEval(line, depth, fen) {
  if (!line) return;
  const stm = fen.split(' ')[1];
  const sign = stm === 'w' ? 1 : -1;
  lastEval = {
    cp: line.cp == null ? null : line.cp * sign,
    mate: line.mate == null ? null : line.mate * sign,
    depth,
  };
}

// ---------------------------------------------------------------------------
// Ввод хода с доски
// ---------------------------------------------------------------------------
function movableDests() {
  const dests = new Map();
  if (!state.started || game.isGameOver()) return dests;
  // В режиме автохода ходить можно только за соперника;
  // в режиме подсказки — за ту сторону, чья очередь.
  if (state.mode === 'auto' && isBotTurn()) return dests;
  for (const m of game.moves({ verbose: true })) {
    if (!dests.has(m.from)) dests.set(m.from, []);
    const list = dests.get(m.from);
    if (!list.includes(m.to)) list.push(m.to);
  }
  return dests;
}

async function onBoardMove(from, to) {
  const candidates = game.moves({ verbose: true }).filter((m) => m.from === from && m.to === to);
  if (!candidates.length) return;
  let promo = '';
  if (candidates.some((m) => m.promotion)) {
    promo = await askPromotion(game.turn());
    if (!promo) { render(); return; }
  }
  playMove(from + to + promo);
}

function askPromotion(color) {
  const dlg = $('dlg-promo');
  const box = $('promo-choices');
  box.replaceChildren();
  for (const p of ['q', 'r', 'b', 'n']) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'promo-btn';
    b.dataset.promo = p;
    b.setAttribute('aria-label', { q: 'Ферзь', r: 'Ладья', b: 'Слон', n: 'Конь' }[p]);
    b.innerHTML = `<img src="pieces/${color}${p.toUpperCase()}.svg" alt=""><span>${{ q: 'Ферзь', r: 'Ладья', b: 'Слон', n: 'Конь' }[p]}</span>`;
    box.appendChild(b);
  }
  return new Promise((resolve) => {
    promoResolve = resolve;
    dlg.showModal();
  });
}

$('dlg-promo').addEventListener('click', (e) => {
  const b = e.target.closest('[data-promo]');
  if (!b) return;
  const r = promoResolve;
  promoResolve = null;
  $('dlg-promo').close();
  r?.(b.dataset.promo);
});
$('dlg-promo').addEventListener('cancel', () => {
  const r = promoResolve;
  promoResolve = null;
  r?.('');
});

// ---------------------------------------------------------------------------
// Отрисовка
// ---------------------------------------------------------------------------
const board = new Board($('board'), { onMove: onBoardMove });

function piecesMap() {
  const map = {};
  for (const row of game.board()) for (const p of row) if (p) map[p.square] = { color: p.color, type: p.type };
  return map;
}

function kingSquare(color) {
  for (const row of game.board()) for (const p of row) if (p && p.type === 'k' && p.color === color) return p.square;
  return null;
}

function arrowsNow() {
  if (analysis?.best && isBotTurn()) {
    return [{ from: analysis.best.slice(0, 2), to: analysis.best.slice(2, 4), cls: 'arrow-main' }];
  }
  // после хода бота держим стрелку на его ходе, пока соперник не ответит
  const last = history[history.length - 1];
  if (last && last.color === state.botColor) return [{ from: last.from, to: last.to, cls: 'arrow-main' }];
  return [];
}

function renderBoard() {
  if (!piecesReady) return;
  const last = history[history.length - 1];
  board.set({
    pieces: piecesMap(),
    orientation: state.botColor,
    lastMove: last && last.san !== PASS ? [last.from, last.to] : null,
    check: game.inCheck() ? kingSquare(game.turn()) : null,
    dests: movableDests(),
    arrows: arrowsNow(),
  });
}

function evalText(ev) {
  if (!ev) return '—';
  if (ev.mate != null) {
    if (ev.mate === 0) return '#';
    return (ev.mate > 0 ? '#' : '#−') + Math.abs(ev.mate);
  }
  const v = ev.cp / 100;
  if (Math.abs(v) < 0.005) return '0.00';
  return (v > 0 ? '+' : '−') + Math.abs(v).toFixed(2);
}

function whitePercent(ev) {
  if (!ev) return 50;
  if (ev.mate != null) return ev.mate > 0 ? 100 : ev.mate < 0 ? 0 : (game.turn() === 'w' ? 0 : 100);
  const wc = 2 / (1 + Math.exp(-0.00368208 * ev.cp)) - 1;
  return Math.max(2, Math.min(98, 50 + 50 * wc));
}

function renderEvalBar() {
  const fill = $('evalbar-fill');
  let wp = whitePercent(lastEval);
  if (game.isCheckmate()) wp = game.turn() === 'w' ? 0 : 100;
  else if (game.isGameOver()) wp = 50;
  // Заливка снизу — цвет бота (он всегда снизу)
  const bottomPct = state.botColor === 'w' ? wp : 100 - wp;
  fill.style.height = bottomPct + '%';
  $('evalbar').classList.toggle('bot-black', state.botColor === 'b');
}

function pvToRu(fen, pv, maxPlies = 10) {
  const g = new Chess(fen);
  const out = [];
  let num = g.moveNumber();
  for (let i = 0; i < pv.length && i < maxPlies; i++) {
    let m;
    try { m = g.move(uciToMove(pv[i])); } catch (_) { break; }
    if (!m) break;
    if (m.color === 'w') out.push(num + '. ' + sanRu(m.san));
    else out.push((i === 0 ? num + '… ' : '') + sanRu(m.san));
    if (m.color === 'b') num++;
  }
  return out.join(' ');
}

function lineEvalText(line, fen) {
  const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
  return evalText({ cp: line.cp == null ? null : line.cp * sign, mate: line.mate == null ? null : line.mate * sign });
}

function moveFromUci(fen, uci) {
  try {
    return new Chess(fen).move(uciToMove(uci));
  } catch (_) {
    return null;
  }
}

function renderAnalysis() {
  const title = $('best-title');
  const big = $('best-move');
  const linesEl = $('lines');
  const btn = $('btn-play-best');
  const last = history[history.length - 1];

  if (game.isGameOver()) {
    $('eval-text').textContent = resultTag().replace('1/2-1/2', '½–½');
    $('depth-text').textContent = '';
  } else {
    $('eval-text').textContent = evalText(lastEval);
    $('depth-text').textContent = lastEval?.depth ? `глубина ${lastEval.depth}` : '';
  }

  linesEl.replaceChildren();
  btn.hidden = true;

  if (analysis && isBotTurn()) {
    const mv = analysis.best ? moveFromUci(analysis.fen, analysis.best) : null;
    title.textContent = !analysis.final ? 'Бот думает…' : STRENGTHS[state.strength]?.pBest >= 1 ? 'Лучший ход' : 'Ход бота';
    big.textContent = mv ? longRu(mv) : '…';
    big.classList.toggle('thinking', !analysis.final);
    for (const line of analysis.lines.slice(0, 3)) {
      const li = document.createElement('li');
      li.innerHTML = `<b></b><span></span>`;
      li.firstChild.textContent = lineEvalText(line, analysis.fen);
      li.lastChild.textContent = pvToRu(analysis.fen, line.pv);
      linesEl.appendChild(li);
    }
    if (state.mode === 'hint') {
      btn.hidden = false;
      btn.disabled = !analysis.best;
    }
  } else if (last && last.color === state.botColor) {
    title.textContent = 'Бот сыграл — повторите на доске';
    big.textContent = longRu(last);
    big.classList.remove('thinking');
  } else {
    title.textContent = 'Лучший ход';
    big.textContent = '—';
    big.classList.remove('thinking');
  }
  renderEvalBar();
  renderBoard();
  renderStatus();
}

function renderStatus() {
  const st = $('status');
  st.className = 'status';
  let text;
  if (engineFailed) {
    text = 'Движок недоступен — можно только вводить ходы.';
    st.classList.add('warn');
  } else if (!state.started) {
    text = 'Выберите, кто ходит первым.';
  } else {
    const over = gameOverText();
    if (over) {
      text = over;
      st.classList.add('over');
    } else if (isBotTurn()) {
      const check = game.inCheck() ? 'Шах боту! ' : '';
      if (!engineReady) text = check + 'Ждём загрузки движка…';
      else if (analysis?.final && state.mode === 'hint') text = check + 'Подсказка готова — сыграйте ход бота.';
      else text = check + 'Бот думает…';
      st.classList.add('bot');
    } else {
      const check = game.inCheck() ? 'Шах сопернику! ' : '';
      text = check + `Ход соперника (${colorName(game.turn())}) — введите его ход на доске.`;
    }
  }
  st.textContent = text;
}

function renderMoves() {
  const ol = $('moves');
  ol.replaceChildren();
  const startTurn = new Chess(state.startFen).turn();
  let num = new Chess(state.startFen).moveNumber();
  let li = null;
  history.forEach((m, i) => {
    if (m.color === 'w' || i === 0) {
      li = document.createElement('li');
      const n = document.createElement('span');
      n.className = 'num';
      n.textContent = num + '.';
      li.appendChild(n);
      if (m.color === 'b' && i === 0 && startTurn === 'b') {
        const dots = document.createElement('span');
        dots.className = 'mv';
        dots.textContent = '…';
        li.appendChild(dots);
      }
      ol.appendChild(li);
    }
    const s = document.createElement('span');
    s.className = 'mv' + (m.color === state.botColor ? ' bot' : '');
    s.textContent = sanRu(m.san);
    if (i === history.length - 1) s.classList.add('last');
    li.appendChild(s);
    if (m.color === 'b') num++;
  });
  if (!history.length) {
    const li2 = document.createElement('li');
    li2.className = 'empty';
    li2.textContent = 'Ходов пока нет';
    ol.appendChild(li2);
  }
  // прокручиваем только сам список, не страницу
  ol.scrollTop = ol.scrollHeight;
}

function renderControls() {
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
  document.querySelectorAll('[data-time]').forEach((b) => b.classList.toggle('on', +b.dataset.time === state.movetime));
  document.querySelectorAll('[data-strength]').forEach((b) => b.classList.toggle('on', b.dataset.strength === state.strength));
  $('btn-undo').disabled = !state.moves.length;
  $('btn-opp-takeback').disabled = oppTakebackIndex() < 0;
  $('label-top').textContent = `Соперник · ${colorName(state.botColor === 'w' ? 'b' : 'w')}`;
  $('label-bottom').textContent = `Бот (Stockfish 19) · ${colorName(state.botColor)}`;
}

function render() {
  renderControls();
  renderMoves();
  renderAnalysis();
}

// ---------------------------------------------------------------------------
// Кнопки и настройки
// ---------------------------------------------------------------------------
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
  if (state.mode === b.dataset.mode) return;
  state.mode = b.dataset.mode;
  save();
  if (state.mode === 'auto' && isBotTurn() && analysis?.final && analysis.best) {
    playMove(analysis.best);
  } else if (state.mode === 'auto' && isBotTurn() && !analysis && !game.isGameOver()) {
    startSearch();
  } else {
    render();
  }
}));

document.querySelectorAll('[data-time]').forEach((b) => b.addEventListener('click', () => {
  state.movetime = +b.dataset.time;
  save();
  renderControls();
}));

document.querySelectorAll('[data-strength]').forEach((b) => b.addEventListener('click', () => {
  if (state.strength === b.dataset.strength) return;
  state.strength = b.dataset.strength;
  save();
  renderControls();
  // включили/выключили «Монстра» на ходу соперника — запускаем или гасим обдумывание
  if (state.started && !isBotTurn() && !game.isGameOver()) {
    engine?.cancel();
    startPonder();
  }
}));

$('btn-play-best').addEventListener('click', () => {
  if (!analysis?.best || !isBotTurn()) return;
  const best = analysis.best;
  engine?.cancel();
  playMove(best);
});

$('btn-undo').addEventListener('click', () => {
  if (!state.moves.length) return;
  engine?.cancel();
  if (state.mode === 'auto') {
    // откатываем ответ бота и ход соперника — соперник снова вводит свой ход
    while (history.length && history[history.length - 1].color === state.botColor) {
      history.pop();
      state.moves.pop();
    }
    if (state.moves.length) state.moves.pop();
  } else {
    state.moves.pop();
  }
  rebuild();
  save();
  afterChange();
});

/** Индекс последнего настоящего хода соперника (после него — только ходы бота) или -1. */
function oppTakebackIndex() {
  if (!state.started) return -1;
  let i = history.length - 1;
  while (i >= 0 && history[i].color === state.botColor) i--;
  if (i < 0 || history[i].san === PASS) return -1;
  return i;
}

// Соперник сходил и сразу отменил ход: убираем его ход (и ответ бота, если был),
// соперник пропускает ход — следующим ходит бот.
$('btn-opp-takeback').addEventListener('click', () => {
  const i = oppTakebackIndex();
  if (i < 0) return;
  const probe = new Chess(state.startFen);
  for (const uci of state.moves.slice(0, i)) applyUci(probe, uci);
  if (probe.inCheck()) {
    toast('Соперник под шахом — пропустить ход нельзя. Используйте «Отменить ход».');
    return;
  }
  engine?.cancel();
  state.moves = state.moves.slice(0, i);
  state.moves.push(PASS);
  rebuild();
  save();
  board.clearSelection();
  toast('Ход соперника отменён — ходит бот');
  afterChange();
});

$('btn-pgn').addEventListener('click', async () => {
  const pgn = buildPgn();
  try {
    await navigator.clipboard.writeText(pgn);
    toast('PGN скопирован');
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = pgn;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, pgn.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    if (ok) toast('PGN скопирован');
    else window.prompt('Скопируйте PGN:', pgn);
  }
});

function buildPgn() {
  const g = new Chess(state.startFen);
  for (const uci of state.moves) applyUci(g, uci);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const bot = 'Stockfish 19 (бот)';
  const opp = 'Соперник';
  g.setHeader('Event', 'Шахматный подсказчик');
  g.setHeader('Date', `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`);
  g.setHeader('White', state.botColor === 'w' ? bot : opp);
  g.setHeader('Black', state.botColor === 'b' ? bot : opp);
  g.setHeader('Result', resultTag());
  if (state.startFen !== DEFAULT_POSITION) {
    g.setHeader('SetUp', '1');
    g.setHeader('FEN', state.startFen);
  }
  return g.pgn();
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
}

// --- новая партия ---
const dlgNew = $('dlg-new');

function openNewGame() {
  $('btn-new-cancel').hidden = !state.started;
  $('fen-error').hidden = true;
  fenBotColor = state.botColor;
  document.querySelectorAll('[data-fen-color]').forEach((b) => b.classList.toggle('on', b.dataset.fenColor === fenBotColor));
  dlgNew.showModal();
}

function startGame(botColor, fen = DEFAULT_POSITION) {
  engine?.cancel();
  state.startFen = fen;
  state.moves = [];
  state.botColor = botColor;
  state.started = true;
  lastEval = null;
  rebuild();
  save();
  dlgNew.close();
  board.clearSelection();
  requestWakeLock();
  afterChange();
}

$('btn-new').addEventListener('click', openNewGame);
$('btn-new-cancel').addEventListener('click', () => dlgNew.close());
dlgNew.addEventListener('cancel', (e) => { if (!state.started) e.preventDefault(); });
dlgNew.querySelectorAll('[data-first]').forEach((b) => b.addEventListener('click', () => {
  startGame(b.dataset.first === 'bot' ? 'w' : 'b');
}));
dlgNew.querySelectorAll('[data-fen-color]').forEach((b) => b.addEventListener('click', () => {
  fenBotColor = b.dataset.fenColor;
  dlgNew.querySelectorAll('[data-fen-color]').forEach((x) => x.classList.toggle('on', x === b));
}));
$('btn-fen').addEventListener('click', () => {
  const fen = $('fen-input').value.trim().replace(/\s+/g, ' ');
  const err = $('fen-error');
  const v = validateFen(fen);
  if (!fen || !v.ok) {
    err.textContent = 'Некорректный FEN' + (v.error ? ': ' + v.error : '.');
    err.hidden = false;
    return;
  }
  let g;
  try { g = new Chess(fen); } catch (e) {
    err.textContent = 'Некорректный FEN: ' + e.message;
    err.hidden = false;
    return;
  }
  if (!kingSquareIn(g, 'w') || !kingSquareIn(g, 'b')) {
    err.textContent = 'В позиции должно быть по одному королю.';
    err.hidden = false;
    return;
  }
  startGame(fenBotColor, g.fen());
});

function kingSquareIn(g, color) {
  return g.board().some((row) => row.some((p) => p && p.type === 'k' && p.color === color));
}

// --- не даём экрану гаснуть во время партии (iOS 16.4+, Android) ---
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (_) { /* не поддерживается — не страшно */ }
}
document.addEventListener('visibilitychange', () => { if (state.started) requestWakeLock(); });
document.addEventListener('pointerdown', () => { if (state.started) requestWakeLock(); }, { once: true });

// ---------------------------------------------------------------------------
// Движок
// ---------------------------------------------------------------------------
const engine = new Engine('engine/stockfish-19-lite-single.js', {
  multiPv: 4,
  hash: 64,
  onReady(name) {
    engineReady = true;
    $('engine-badge').textContent = name || 'Stockfish 19';
    $('engine-badge').classList.add('ok');
    renderStatus();
  },
  onError(msg) {
    engineFailed = true;
    const box = $('engine-error');
    box.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = 'Не удалось запустить движок. ';
    box.appendChild(b);
    box.appendChild(document.createTextNode(msg + ' Обновите страницу. Нужен современный браузер с WebAssembly (Safari 16+, Chrome, Firefox). '));
    box.appendChild(document.createTextNode('Если открываете файл локально — запустите через веб-сервер (не file://).'));
    box.hidden = false;
    $('engine-badge').textContent = 'Движок не запущен';
    $('engine-badge').classList.add('bad');
    render();
  },
});

// ---------------------------------------------------------------------------
// Старт
// ---------------------------------------------------------------------------
load();
rebuild();

loadPieceSymbols($('board').querySelector('defs'))
  .then(() => { piecesReady = true; renderBoard(); })
  .catch((e) => {
    const box = $('engine-error');
    box.textContent = 'Не удалось загрузить фигуры: ' + e.message;
    box.hidden = false;
  });

render();
if (!state.started) openNewGame();
else afterChange();

// для отладки и автотестов
window.chessAdvisor = {
  get state() { return state; },
  get game() { return game; },
  get analysis() { return analysis; },
  get engineReady() { return engineReady; },
  get engineFailed() { return engineFailed; },
  get engine() { return engine; },
  chooseMove,
};

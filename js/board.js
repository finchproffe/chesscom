// SVG-доска: отрисовка, клик-клик и перетаскивание (Pointer Events — мышь и тач).

const NS = 'http://www.w3.org/2000/svg';
const FILES = 'abcdefgh';
const DRAG_THRESHOLD = 0.12; // в долях клетки

/** Загружает фигуры Cburnett из pieces/*.svg и превращает их в <symbol>. */
export async function loadPieceSymbols(defs, base = 'pieces/') {
  const codes = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP'];
  const texts = await Promise.all(
    codes.map((c) => fetch(base + c + '.svg').then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + c);
      return r.text();
    })),
  );
  const parser = new DOMParser();
  codes.forEach((code, i) => {
    const doc = parser.parseFromString(texts[i], 'image/svg+xml');
    const src = doc.documentElement;
    const sym = document.createElementNS(NS, 'symbol');
    sym.setAttribute('id', 'piece-' + code);
    sym.setAttribute('viewBox', src.getAttribute('viewBox') || '0 0 45 45');
    for (const child of Array.from(src.childNodes)) sym.appendChild(document.importNode(child, true));
    defs.appendChild(sym);
  });
}

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

export class Board {
  /**
   * @param {SVGSVGElement} svg
   * @param {{onMove:(from:string,to:string)=>void}} opts
   */
  constructor(svg, { onMove }) {
    this.svg = svg;
    this.onMove = onMove;
    this.state = {
      pieces: {},          // square -> {color, type}
      orientation: 'w',
      lastMove: null,      // [from, to]
      check: null,         // square
      dests: new Map(),    // from -> [to,...] для фигур, которыми сейчас можно ходить
      arrows: [],          // [{from, to, cls}]
    };
    this.selected = null;
    this.drag = null;

    svg.setAttribute('viewBox', '0 0 8 8');
    this.defs = svg.querySelector('defs') || el('defs', {}, svg);
    this.gSquares = el('g', { class: 'squares' }, svg);
    this.gHigh = el('g', { class: 'highlights' }, svg);
    this.gCoords = el('g', { class: 'coords' }, svg);
    this.gPieces = el('g', { class: 'pieces' }, svg);
    this.gDests = el('g', { class: 'dests' }, svg);
    this.gArrows = el('g', { class: 'arrows' }, svg);
    this.gDrag = el('g', { class: 'drag' }, svg);

    svg.addEventListener('pointerdown', (e) => this._down(e));
    svg.addEventListener('pointermove', (e) => this._move(e));
    svg.addEventListener('pointerup', (e) => this._up(e));
    svg.addEventListener('pointercancel', () => this._cancelDrag());
    svg.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  set(partial) {
    Object.assign(this.state, partial);
    if (this.selected && !this.state.dests.has(this.selected)) this.selected = null;
    this.render();
  }

  // ---------- геометрия ----------
  xy(sq) {
    const f = FILES.indexOf(sq[0]);
    const r = +sq[1] - 1;
    return this.state.orientation === 'w' ? [f, 7 - r] : [7 - f, r];
  }

  sqAt(x, y) {
    if (x < 0 || y < 0 || x >= 8 || y >= 8) return null;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    const f = this.state.orientation === 'w' ? cx : 7 - cx;
    const r = this.state.orientation === 'w' ? 7 - cy : cy;
    return FILES[f] + (r + 1);
  }

  pointer(e) {
    const rect = this.svg.getBoundingClientRect();
    return [((e.clientX - rect.left) / rect.width) * 8, ((e.clientY - rect.top) / rect.height) * 8];
  }

  // ---------- отрисовка ----------
  render() {
    const s = this.state;
    const sel = this.selected;

    // клетки
    if (!this.gSquares.childNodes.length) {
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          el('rect', { x, y, width: 1, height: 1, class: (x + y) % 2 ? 'sq dark' : 'sq light' }, this.gSquares);
        }
      }
    }

    // подсветка
    this.gHigh.replaceChildren();
    const hl = (sq, cls) => {
      const [x, y] = this.xy(sq);
      el('rect', { x, y, width: 1, height: 1, class: cls }, this.gHigh);
    };
    if (s.lastMove) { hl(s.lastMove[0], 'hl-last'); hl(s.lastMove[1], 'hl-last'); }
    if (sel) hl(sel, 'hl-selected');
    if (s.check) {
      const [x, y] = this.xy(s.check);
      el('circle', { cx: x + 0.5, cy: y + 0.5, r: 0.5, class: 'hl-check' }, this.gHigh);
    }

    // координаты
    this.gCoords.replaceChildren();
    for (let i = 0; i < 8; i++) {
      const fileSq = this.sqAt(i + 0.5, 7.5);
      const rankSq = this.sqAt(0.5, i + 0.5);
      const t1 = el('text', { x: i + 0.96, y: 7.95, class: 'coord ' + ((i + 7) % 2 ? 'on-dark' : 'on-light'), 'text-anchor': 'end' }, this.gCoords);
      t1.textContent = fileSq[0];
      const t2 = el('text', { x: 0.04, y: i + 0.2, class: 'coord ' + (i % 2 ? 'on-dark' : 'on-light') }, this.gCoords);
      t2.textContent = rankSq[1];
    }

    // фигуры
    this.gPieces.replaceChildren();
    for (const sq in s.pieces) {
      if (this.drag && this.drag.active && this.drag.from === sq) continue;
      const p = s.pieces[sq];
      const [x, y] = this.xy(sq);
      el('use', { href: '#piece-' + p.color + p.type.toUpperCase(), x, y, width: 1, height: 1, class: 'piece' }, this.gPieces);
    }

    // возможные ходы
    this.gDests.replaceChildren();
    if (sel && s.dests.has(sel)) {
      for (const to of s.dests.get(sel)) {
        const [x, y] = this.xy(to);
        if (s.pieces[to]) el('circle', { cx: x + 0.5, cy: y + 0.5, r: 0.46, class: 'dest-capture' }, this.gDests);
        else el('circle', { cx: x + 0.5, cy: y + 0.5, r: 0.16, class: 'dest' }, this.gDests);
      }
    }

    // стрелки
    this.gArrows.replaceChildren();
    for (const a of s.arrows) this._arrow(a);
  }

  _arrow({ from, to, cls = 'arrow-main' }) {
    const [x1, y1] = this.xy(from).map((v) => v + 0.5);
    const [x2, y2] = this.xy(to).map((v) => v + 0.5);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (!len) return;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    const shaft = cls === 'arrow-main' ? 0.1 : 0.065;
    const headW = cls === 'arrow-main' ? 0.3 : 0.22;
    const headL = cls === 'arrow-main' ? 0.42 : 0.34;
    const sx = x1 + ux * 0.18;
    const sy = y1 + uy * 0.18;
    const ex = x2 - ux * 0.08;
    const ey = y2 - uy * 0.08;
    const bx = ex - ux * headL;
    const by = ey - uy * headL;
    const pts = [
      [sx + nx * shaft, sy + ny * shaft],
      [bx + nx * shaft, by + ny * shaft],
      [bx + nx * headW, by + ny * headW],
      [ex, ey],
      [bx - nx * headW, by - ny * headW],
      [bx - nx * shaft, by - ny * shaft],
      [sx - nx * shaft, sy - ny * shaft],
    ];
    el('polygon', { points: pts.map((p) => p.map((v) => v.toFixed(3)).join(',')).join(' '), class: 'arrow ' + cls }, this.gArrows);
  }

  // ---------- ввод ----------
  _canMoveFrom(sq) {
    return this.state.dests.has(sq) && this.state.dests.get(sq).length > 0;
  }

  _isDest(from, to) {
    return !!from && (this.state.dests.get(from) || []).includes(to);
  }

  _down(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const [x, y] = this.pointer(e);
    const sq = this.sqAt(x, y);
    if (!sq) return;
    e.preventDefault();

    if (this.selected && this._isDest(this.selected, sq)) {
      const from = this.selected;
      this.selected = null;
      this.render();
      this.onMove(from, sq);
      return;
    }
    if (this._canMoveFrom(sq)) {
      const wasSelected = this.selected === sq;
      this.selected = sq;
      this.drag = { from: sq, start: [x, y], active: false, wasSelected, pointerId: e.pointerId };
      try { this.svg.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      this.render();
      return;
    }
    if (this.selected) {
      this.selected = null;
      this.render();
    }
  }

  _move(e) {
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    e.preventDefault();
    const [x, y] = this.pointer(e);
    if (!d.active) {
      if (Math.hypot(x - d.start[0], y - d.start[1]) < DRAG_THRESHOLD) return;
      d.active = true;
      const p = this.state.pieces[d.from];
      this.gDrag.replaceChildren();
      d.hover = el('rect', { width: 1, height: 1, class: 'hl-hover', visibility: 'hidden' }, this.gDrag);
      d.node = el('use', { href: '#piece-' + p.color + p.type.toUpperCase(), width: 1.2, height: 1.2, class: 'piece dragging' }, this.gDrag);
      this.render();
    }
    d.node.setAttribute('x', (x - 0.6).toFixed(3));
    d.node.setAttribute('y', (y - 0.6).toFixed(3));
    const over = this.sqAt(x, y);
    if (over && this._isDest(d.from, over)) {
      const [hx, hy] = this.xy(over);
      d.hover.setAttribute('x', hx);
      d.hover.setAttribute('y', hy);
      d.hover.setAttribute('visibility', 'visible');
    } else {
      d.hover.setAttribute('visibility', 'hidden');
    }
  }

  _up(e) {
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    this.drag = null;
    this.gDrag.replaceChildren();
    if (d.active) {
      const [x, y] = this.pointer(e);
      const to = this.sqAt(x, y);
      if (to && this._isDest(d.from, to)) {
        this.selected = null;
        this.render();
        this.onMove(d.from, to);
        return;
      }
      // отпустили не там — фигура остаётся выбранной
      this.render();
      return;
    }
    // простой клик по уже выбранной фигуре — снимаем выделение
    if (d.wasSelected) this.selected = null;
    this.render();
  }

  _cancelDrag() {
    this.drag = null;
    this.gDrag.replaceChildren();
    this.render();
  }

  clearSelection() {
    this.selected = null;
    this.render();
  }
}

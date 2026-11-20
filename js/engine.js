// Обёртка над Stockfish (Web Worker, протокол UCI).
// Одновременно идёт не больше одного поиска. Новый поиск сначала останавливает
// текущий (stop) и стартует только после его bestmove, а bestmove/info
// остановленного поиска игнорируются.

const INIT_TIMEOUT_MS = 15000;

export class Engine {
  constructor(url, { multiPv = 3, hash = 0, onReady, onError } = {}) {
    this.multiPv = multiPv;
    this.curMultiPv = multiPv;
    this.hash = hash;
    this.onReady = onReady || (() => {});
    this.onError = onError || (() => {});
    this.ready = false;
    this.failed = false;
    this.job = null;      // текущий поиск
    this.pending = null;  // поиск, ждущий окончания текущего
    this.name = '';

    if (typeof WebAssembly !== 'object' || typeof Worker !== 'function') {
      setTimeout(() => this._fail('Этот браузер не поддерживает WebAssembly или Web Worker.'), 0);
      return;
    }
    try {
      this.worker = new Worker(url);
    } catch (e) {
      setTimeout(() => this._fail('Не удалось создать Web Worker: ' + e.message), 0);
      return;
    }
    this.worker.onmessage = (e) => {
      if (typeof e.data === 'string') e.data.split('\n').forEach((l) => l && this._line(l.trim()));
    };
    this.worker.onerror = (e) => {
      e.preventDefault?.();
      this._fail('Ошибка движка: ' + (e.message || 'не удалось загрузить файлы движка'));
    };
    this.timer = setTimeout(() => {
      if (!this.ready) this._fail('Движок Stockfish (WebAssembly) не запустился за 15 секунд.');
    }, INIT_TIMEOUT_MS);
    this._post('uci');
  }

  _post(cmd) {
    if (this.worker && !this.failed) this.worker.postMessage(cmd);
  }

  _fail(msg) {
    if (this.failed) return;
    this.failed = true;
    clearTimeout(this.timer);
    try { this.worker?.terminate(); } catch (_) { /* ignore */ }
    this.worker = null;
    this.onError(msg);
  }

  _line(line) {
    if (line.startsWith('id name ')) {
      this.name = line.slice(8);
    } else if (line === 'uciok') {
      this._post('setoption name MultiPV value ' + this.multiPv);
      if (this.hash) this._post('setoption name Hash value ' + this.hash);
      this._post('isready');
    } else if (line === 'readyok') {
      if (!this.ready) {
        this.ready = true;
        clearTimeout(this.timer);
        this.onReady(this.name);
        if (this.pending) this._next();
      }
    } else if (line.startsWith('info ') && line.includes(' pv ')) {
      this._info(line);
    } else if (line.startsWith('bestmove')) {
      const job = this.job;
      this.job = null;
      if (job && !job.stopped) {
        const best = line.split(' ')[1];
        job.onDone(best && best !== '(none)' ? best : null, job);
      }
      this._next();
    }
  }

  _info(line) {
    const job = this.job;
    if (!job || job.stopped) return;
    const t = line.split(' ');
    const at = (k) => t.indexOf(k);
    const depth = +t[at('depth') + 1] || 0;
    const mpIdx = at('multipv');
    const mp = mpIdx >= 0 ? +t[mpIdx + 1] : 1;
    const si = at('score');
    if (si < 0) return;
    const kind = t[si + 1];
    const val = +t[si + 2];
    if (t[si + 3] === 'lowerbound' || t[si + 3] === 'upperbound') return;
    const pv = t.slice(at('pv') + 1).filter(Boolean);
    if (!pv.length) return;
    // если глубина выросла — старые варианты меньшей глубины не выбрасываем,
    // а перезаписываем по номеру, чтобы список не «мигал»
    job.lines[mp - 1] = {
      multipv: mp,
      depth,
      mate: kind === 'mate' ? val : null,
      cp: kind === 'cp' ? val : null,
      pv,
    };
    job.depth = Math.max(job.depth, depth);
    job.onInfo(job.lines.filter(Boolean), job);
  }

  _next() {
    if (this.job || !this.ready || !this.pending) return;
    const job = this.pending;
    this.pending = null;
    this.job = job;
    // движок сейчас свободен (предыдущий bestmove получен) — опции менять можно
    if (job.multiPv !== this.curMultiPv) {
      this.curMultiPv = job.multiPv;
      this._post('setoption name MultiPV value ' + job.multiPv);
    }
    this._post('position fen ' + job.fen);
    // movetime = 0 — бесконечный поиск до stop (обдумывание на времени соперника)
    this._post(job.movetime ? 'go movetime ' + job.movetime : 'go infinite');
  }

  /**
   * Запускает поиск. onInfo(lines, job), onDone(bestUci, job).
   * movetime = 0 — бесконечный поиск, закончить его можно только cancel().
   */
  search(fen, movetime, onInfo, onDone, { multiPv = this.multiPv } = {}) {
    const job = { fen, movetime, onInfo, onDone, multiPv, lines: [], depth: 0, stopped: false };
    this.pending = job;
    if (this.job) this._stopCurrent();
    else this._next();
    return job;
  }

  _stopCurrent() {
    if (this.job && !this.job.stopped) {
      this.job.stopped = true;
      this._post('stop');
    }
  }

  /** Останавливает текущий поиск и отменяет ожидающий. */
  cancel() {
    this.pending = null;
    this._stopCurrent();
  }

  get searching() {
    return !!(this.job && !this.job.stopped) || !!this.pending;
  }
}

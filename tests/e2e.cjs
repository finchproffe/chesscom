// Сквозная проверка сайта в headless Chromium (Playwright).
// Запуск: python3 -m http.server 8765  и затем  node tests/e2e.cjs [URL]
// Скриншоты пишутся в $OUT (по умолчанию — системная временная папка).
const { chromium } = require('playwright');
const OUT = process.env.OUT || require('os').tmpdir();
const URL = process.argv[2] || 'http://localhost:8765/';

function sqCenter(box, sq, orient) {
  const f = 'abcdefgh'.indexOf(sq[0]);
  const r = +sq[1] - 1;
  const x = orient === 'w' ? f : 7 - f;
  const y = orient === 'w' ? 7 - r : r;
  const s = box.width / 8;
  return [box.x + (x + 0.5) * s, box.y + (y + 0.5) * s];
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: false });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new (require('url').URL)(URL).origin });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL);
  const t0 = Date.now();
  await page.waitForFunction(() => window.chessAdvisor?.engineReady, null, { timeout: 20000 });
  console.log('engine ready in', Date.now() - t0, 'ms; badge:', await page.textContent('#engine-badge'));
  console.log('dialog open:', await page.evaluate(() => document.getElementById('dlg-new').open));
  await page.screenshot({ path: OUT + '/01-dialog.png' });

  async function playGame(first, useDrag, maxPlies = 300) {
    if (!(await page.evaluate(() => document.getElementById('dlg-new').open))) await page.click('#btn-new');
    await page.click(`[data-first="${first}"]`);
    await page.click('[data-time="500"]');
    const botColor = await page.evaluate(() => window.chessAdvisor.state.botColor);
    let plies = 0;
    let promoCount = 0;
    while (plies < maxPlies) {
      // ждём либо конец партии, либо ход соперника
      await page.waitForFunction((bc) => {
        const g = window.chessAdvisor.game;
        return g.isGameOver() || g.turn() !== bc;
      }, botColor, { timeout: 15000 });
      const info = await page.evaluate(() => {
        const g = window.chessAdvisor.game;
        return { over: g.isGameOver(), moves: g.moves({ verbose: true }).map((m) => ({ from: m.from, to: m.to, promo: !!m.promotion, captured: !!m.captured })) };
      });
      if (info.over) break;
      // соперник: предпочитаем взятия, иначе случайный ход
      const caps = info.moves.filter((m) => m.captured);
      const pool = caps.length && Math.random() < 0.5 ? caps : info.moves;
      const mv = pool[Math.floor(Math.random() * pool.length)];
      const box = await page.locator('#board').boundingBox();
      const orient = botColor;
      const [fx, fy] = sqCenter(box, mv.from, orient);
      const [tx, ty] = sqCenter(box, mv.to, orient);
      const before = await page.evaluate(() => window.chessAdvisor.state.moves.length);
      if (useDrag) {
        await page.mouse.move(fx, fy);
        await page.mouse.down();
        await page.mouse.move((fx + tx) / 2, (fy + ty) / 2, { steps: 3 });
        await page.mouse.move(tx, ty, { steps: 3 });
        await page.mouse.up();
      } else {
        await page.mouse.click(fx, fy);
        await page.mouse.click(tx, ty);
      }
      if (mv.promo) {
        await page.waitForSelector('#dlg-promo[open]', { timeout: 3000 });
        await page.click('#promo-choices [data-promo="q"]');
        promoCount++;
      }
      const after = await page.evaluate(() => window.chessAdvisor.state.moves.length);
      if (after !== before + 1 && after < before + 1) throw new Error(`move ${mv.from}${mv.to} not registered (${before}->${after})`);
      plies++;
    }
    const res = await page.evaluate(() => ({
      status: document.getElementById('status').textContent,
      moves: window.chessAdvisor.state.moves.length,
      fen: window.chessAdvisor.game.fen(),
    }));
    console.log(`[${first}, ${useDrag ? 'drag' : 'click'}] plies total=${res.moves}, opp promos=${promoCount}; status: ${res.status}`);
    return res;
  }

  // 1) бот ходит первым, клик-клик
  await playGame('bot', false);
  await page.screenshot({ path: OUT + '/02-game1-end.png', fullPage: true });
  const pgn1 = await (async () => { await page.click('#btn-pgn'); return page.evaluate(() => navigator.clipboard.readText()); })();
  console.log('PGN head:\n' + pgn1.split('\n').slice(0, 9).join('\n') + '\n... tail: ' + pgn1.slice(-60));

  // 2) соперник первым, перетаскивание, перевёрнутая доска
  await page.click('#btn-new');
  await page.click('[data-first="opp"]');
  const orient = await page.evaluate(() => {
    const st = window.chessAdvisor.state;
    // какая фигура нарисована в левом нижнем углу (x=0,y=7)
    const uses = [...document.querySelectorAll('#board .pieces use')];
    const bl = uses.find((u) => +u.getAttribute('x') === 0 && +u.getAttribute('y') === 7);
    const tl = uses.find((u) => +u.getAttribute('x') === 0 && +u.getAttribute('y') === 0);
    const coordsBottom = [...document.querySelectorAll('#board .coords text')].slice(0, 16).map((t) => t.textContent).join('');
    return { botColor: st.botColor, bottomLeft: bl?.getAttribute('href'), topLeft: tl?.getAttribute('href'), turn: window.chessAdvisor.game.turn(), coords: coordsBottom };
  });
  console.log('flipped board:', JSON.stringify(orient));
  await page.screenshot({ path: OUT + '/03-flipped-start.png' });
  await page.click('#btn-new'); // playGame откроет выбор сам
  await page.click('#btn-new-cancel');
  await playGame('opp', true);
  await page.screenshot({ path: OUT + '/04-game2-end.png', fullPage: true });

  // 3) undo в автоходе
  await page.click('#btn-new');
  await page.click('[data-first="bot"]');
  await page.waitForFunction(() => window.chessAdvisor.state.moves.length === 1, null, { timeout: 15000 });
  let box = await page.locator('#board').boundingBox();
  let [a, b] = sqCenter(box, 'e7', 'w'); let [c, d] = sqCenter(box, 'e5', 'w');
  await page.mouse.click(a, b); await page.mouse.click(c, d);
  await page.waitForFunction(() => window.chessAdvisor.state.moves.length === 3, null, { timeout: 15000 });
  await page.screenshot({ path: OUT + '/05-after-bot-reply.png' });
  await page.click('#btn-undo');
  console.log('undo (auto) moves now:', await page.evaluate(() => window.chessAdvisor.state.moves.join(' ')), 'turn', await page.evaluate(() => window.chessAdvisor.game.turn()));

  // 4) режим подсказки
  await page.click('[data-mode="hint"]');
  [a, b] = sqCenter(box, 'd7', 'w'); [c, d] = sqCenter(box, 'd5', 'w');
  await page.mouse.click(a, b); await page.mouse.click(c, d);
  await page.waitForFunction(() => window.chessAdvisor.analysis?.final, null, { timeout: 15000 });
  const hint = await page.evaluate(() => ({ moves: window.chessAdvisor.state.moves.length, best: window.chessAdvisor.analysis.best, big: document.getElementById('best-move').textContent, lines: document.querySelectorAll('#lines li').length, arrow: document.querySelectorAll('#board .arrow').length, btnHidden: document.getElementById('btn-play-best').hidden }));
  console.log('hint mode:', JSON.stringify(hint));
  await page.screenshot({ path: OUT + '/06-hint.png', fullPage: true });
  await page.click('#btn-play-best');
  console.log('after play-best moves:', await page.evaluate(() => window.chessAdvisor.state.moves.join(' ')));
  await page.click('#btn-undo');
  console.log('undo (hint) moves:', await page.evaluate(() => window.chessAdvisor.state.moves.join(' ')));

  // 5) быстрая смена позиции во время поиска — устаревший bestmove не должен сыграться
  await page.click('[data-mode="auto"]');
  await page.click('[data-time="5000"]');
  // сейчас ход бота (после undo в hint) — пусть думает; отменим ход соперника и сделаем другой
  await page.waitForTimeout(300);
  await page.click('#btn-undo'); // откатывает d7d5 (ход соперника)
  [a, b] = sqCenter(box, 'c7', 'w'); [c, d] = sqCenter(box, 'c5', 'w');
  await page.mouse.click(a, b); await page.mouse.click(c, d);
  await page.waitForFunction(() => window.chessAdvisor.state.moves.length === 3 && window.chessAdvisor.game.turn() === "b", null, { timeout: 15000 });
  const seq = await page.evaluate(() => window.chessAdvisor.state.moves.join(' '));
  console.log('stale test sequence:', seq);
  await page.click('[data-time="500"]');

  // 6) превращение через FEN
  await page.click('#btn-new');
  await page.click('.fen-box summary');
  await page.fill('#fen-input', '8/1P6/8/8/8/8/6k1/4K3 w - - 0 1');
  await page.click('[data-fen-color="b"]');
  await page.click('#btn-fen');
  box = await page.locator('#board').boundingBox();
  [a, b] = sqCenter(box, 'b7', 'b'); [c, d] = sqCenter(box, 'b8', 'b');
  await page.mouse.click(a, b); await page.mouse.click(c, d);
  await page.waitForSelector('#dlg-promo[open]');
  await page.screenshot({ path: OUT + '/07-promo.png' });
  await page.click('#promo-choices [data-promo="n"]');
  await page.waitForTimeout(300);
  console.log('promo moves:', await page.evaluate(() => window.chessAdvisor.state.moves.join(' ')), '| list:', await page.textContent('#moves'), '| status:', await page.textContent('#status'));
  // бот превращает пешку
  await page.click('#btn-new');
  await page.fill('#fen-input', '8/8/8/8/8/6k1/1p6/4K3 w - - 0 1');
  await page.click('[data-fen-color="b"]');
  await page.click('#btn-fen');
  [a, b] = sqCenter(box, 'e1', 'b'); [c, d] = sqCenter(box, 'd2', 'b');
  await page.mouse.click(a, b); await page.mouse.click(c, d);
  await page.waitForFunction(() => window.chessAdvisor.state.moves.length === 2, null, { timeout: 15000 });
  console.log('bot promo:', await page.textContent('#moves'), '| big:', await page.textContent('#best-move'), '| eval:', await page.textContent('#eval-text'));
  await page.screenshot({ path: OUT + '/07b-bot-promo.png' });

  // bad FEN
  await page.click('#btn-new');
  await page.fill('#fen-input', 'garbage');
  await page.click('#btn-fen');
  console.log('bad fen error:', await page.textContent('#fen-error'));
  await page.click('#btn-new-cancel');

  // 7) сохранение после перезагрузки
  const beforeReload = await page.evaluate(() => JSON.stringify(window.chessAdvisor.state));
  await page.reload();
  await page.waitForFunction(() => window.chessAdvisor?.engineReady, null, { timeout: 20000 });
  const afterReload = await page.evaluate(() => JSON.stringify(window.chessAdvisor.state));
  console.log('persisted:', beforeReload === afterReload, afterReload);

  // 8) ширина 390
  const sw = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, board: document.getElementById('board').getBoundingClientRect().width }));
  console.log('layout 390:', JSON.stringify(sw));
  await page.screenshot({ path: OUT + '/08-390.png', fullPage: true });

  // тёмная тема
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: OUT + '/09-dark.png', fullPage: true });

  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });

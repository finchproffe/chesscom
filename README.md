# Шахматный подсказчик

Статический сайт для игры с живым соперником за настоящей доской с подсказками
движка **Stockfish 19**, который работает прямо в браузере (WebAssembly, без сервера).

- **Верхние фигуры — соперник.** Его ходы вы вводите на сайте (клик-клик или перетаскивание).
- **Нижние фигуры — бот.** После каждого хода соперника бот считает лучший ход,
  показывает его стрелкой и крупной надписью (например, `Кg1–f3`) и сразу делает его —
  вы повторяете этот ход на настоящей доске.

## Возможности

- Перед партией — выбор «Кто ходит первым?»:
  «Бот ходит первым» (бот белыми снизу) или «Я хожу первым (соперник)»
  (соперник белыми сверху, доска перевёрнута, бот — чёрными снизу).
- Режимы «Бот ходит сам» и «Только подсказка» (во втором бот лишь показывает стрелку,
  ход делается кнопкой «Сыграть лучший ход» или вручную).
- Время на ход: 0,5 / 1 / 2 / 5 с (по умолчанию 2 с).
- MultiPV 3: три лучших варианта с оценкой, шкала оценки, глубина.
- Список ходов в русской нотации (Кр, Ф, Л, С, К), ходы бота выделены.
- «Отменить ход» (в режиме автохода откатывает ответ бота и ход соперника),
  «Новая партия», «Копировать PGN», начало с позиции из FEN.
- Превращение пешки с выбором фигуры; мат, пат и ничьи (недостаточно материала,
  троекратное повторение, правило 50 ходов).
- Партия и настройки сохраняются в `localStorage`.
- Светлая и тёмная тема по системной настройке; вёрстка под iPhone (от 320 px).
- Если WebAssembly-движок не запустился за 15 секунд — на странице появляется понятная ошибка.

## Устройство

Чистые HTML/CSS/JS без сборки и без CDN, все пути относительные — сайт работает
по адресу вида `https://<username>.github.io/<repo>/`.

| Путь | Что это |
| --- | --- |
| `index.html`, `css/style.css` | разметка и стили |
| `js/app.js` | логика партии, интерфейс, сохранение |
| `js/engine.js` | обёртка над Stockfish: Web Worker, UCI (`uci` → `isready` → `position fen …` → `go movetime N`), `stop` и отбрасывание устаревшего `bestmove` |
| `js/board.js` | SVG-доска: подсветка, стрелки, клик-клик и перетаскивание (Pointer Events — мышь и тач) |
| `engine/stockfish-19-lite-single.js`, `.wasm` | Stockfish 19 (lite, однопоточный) из npm-пакета [`stockfish@19.0.1`](https://www.npmjs.com/package/stockfish) |
| `lib/chess.js` | правила — [chess.js 1.4.0](https://github.com/jhlywa/chess.js) (ESM-сборка из npm) |
| `pieces/*.svg` | фигуры Cburnett |
| `tests/e2e.cjs` | сквозная проверка в headless Chromium (Playwright) |
| `.github/workflows/pages.yml` | деплой на GitHub Pages |
| `.nojekyll` | отключает Jekyll на GitHub Pages |

Однопоточная lite-версия движка не требует заголовков cross-origin isolation,
поэтому работает на обычном GitHub Pages. Файл `.wasm` лежит рядом с `.js` и
загружается воркером автоматически.

## Публикация на GitHub Pages

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. Влейте изменения в ветку `main` — workflow `Deploy to GitHub Pages` запустится сам
   (или запустите его вручную на вкладке **Actions → Deploy to GitHub Pages → Run workflow**).
3. Адрес сайта появится в **Settings → Pages** и в выводе workflow.

## Локальный запуск

```bash
python3 -m http.server 8765
# откройте http://localhost:8765/
```

Открывать `index.html` напрямую через `file://` нельзя — браузер не запустит Web Worker и WebAssembly.

Проверка (нужен Node.js и Playwright с Chromium):

```bash
node tests/e2e.cjs http://localhost:8765/
```

## Лицензии

- **Stockfish 19** — © авторы Stockfish, [GNU GPL v3](engine/COPYING.txt).
  Исходный код движка: <https://github.com/official-stockfish/Stockfish>;
  исходный код WebAssembly-сборки stockfish.js (Nathan Rugg), из которой взяты файлы в `engine/`:
  <https://github.com/nmrugg/stockfish.js> (версия [v19.0.1](https://github.com/nmrugg/stockfish.js/releases/tag/v19.0.1)).
- **chess.js** — © Jeff Hlywa, лицензия BSD 2-Clause, см. [`lib/LICENSE-chess.js.txt`](lib/LICENSE-chess.js.txt).
  Исходники: <https://github.com/jhlywa/chess.js>.
- **Фигуры Cburnett** — © Colin M.L. Burnett,
  [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/), см. [`pieces/LICENSE.txt`](pieces/LICENSE.txt).

Поскольку сайт распространяет Stockfish (GPLv3), собственный код сайта
(`index.html`, `css/`, `js/`, `tests/`) также распространяется на условиях GNU GPL v3.

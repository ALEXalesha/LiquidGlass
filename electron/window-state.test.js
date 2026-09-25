'use strict';

// Размер и место окна между запусками (window-state.js, 1.1.0). Модуль тот же, что в
// калькуляторах, Paint Pro, SyncGlass и Translator AI. Что бы ни лежало в файле, окно открывается там,
// где его видно и можно взять за заголовок. Случайные прогоны - с зерном.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WS = require('./window-state');

const OPTS = { width: 1440, height: 900, minWidth: 480, minHeight: 360 };
const FULL_HD = { x: 0, y: 0, width: 1920, height: 1040 };
const RIGHT = { x: 1920, y: 0, width: 2560, height: 1400 };
const inside = (w, a) => w.x >= a.x && w.y >= a.y && w.x + w.width <= a.x + a.width && w.y + w.height <= a.y + a.height;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r, a, b) => a + Math.floor(r() * (b - a + 1));

test('без файла - размер по умолчанию, по центру', () => {
  assert.deepStrictEqual(WS.restore(null, [FULL_HD], OPTS), { width: 1440, height: 900, maximized: false });
});

test('окно на экране открывается ровно там и такого размера, как было', () => {
  const saved = { x: 100, y: 50, width: 900, height: 700, maximized: false };
  assert.deepStrictEqual(WS.restore(saved, [FULL_HD], OPTS), saved);
});

test('второй монитор отключили - по центру основного, размер тот же', () => {
  const saved = { x: 2500, y: 100, width: 900, height: 700, maximized: true };
  assert.deepStrictEqual(WS.restore(saved, [FULL_HD, RIGHT], OPTS), saved);
  assert.deepStrictEqual(WS.restore(saved, [FULL_HD], OPTS), { width: 900, height: 700, maximized: true });
});

test('меньше минимума поднимается, больше экрана ужимается', () => {
  assert.deepStrictEqual(WS.restore({ width: 10, height: 10 }, [FULL_HD], OPTS), { width: 480, height: 360, maximized: false });
  assert.deepStrictEqual(WS.restore({ x: 0, y: 0, width: 9000, height: 9000 }, [FULL_HD], OPTS),
    { x: 0, y: 0, width: 1920, height: 1040, maximized: false });
});

test('что бы ни лежало в файле, размер разумный, заголовок на экране, повтор ничего не меняет', () => {
  const junk = (r) => {
    const pick = [() => undefined, () => NaN, () => 'x', () => r() * 1e5 - 5e4, () => int(r, -20000, 20000), () => int(r, -100, 5000)];
    const v = () => pick[int(r, 0, pick.length - 1)]();
    return r() < 0.2 ? [null, 42, 'x', [], {}][int(r, 0, 4)] : { x: v(), y: v(), width: v(), height: v(), maximized: r() < 0.5 };
  };
  for (let seed = 1; seed <= 3000; seed++) {
    const r = rng(seed);
    const screens = [];
    let x = int(r, -5000, 5000);
    for (let i = int(r, 1, 3); i > 0; i--) {
      const a = { x, y: int(r, -3000, 3000), width: int(r, 640, 4000), height: int(r, 480, 2500) };
      screens.push(a);
      x += a.width;
    }
    const w = WS.restore(junk(r), screens, OPTS);
    const ctx = 'зерно ' + seed;
    assert.ok(Number.isInteger(w.width) && Number.isInteger(w.height) && w.width >= 480 && w.height >= 360, ctx);
    assert.strictEqual(w.x === undefined, w.y === undefined, ctx);
    if (w.x !== undefined) {
      assert.ok(screens.some((a) => inside(w, a) || w.width > a.width || w.height > a.height), ctx);
      assert.ok(screens.some((a) => w.x >= a.x && w.y >= a.y && w.x < a.x + a.width
        && w.y + WS.GRIP_HEIGHT <= a.y + a.height), ctx);
      assert.deepStrictEqual(WS.restore(w, screens, OPTS), w, ctx);
    }
  }
});

test('запись через временный файл; обрезанный файл - окно по умолчанию', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liquid-ws-'));
  try {
    const file = path.join(dir, 'sub', 'window-state.json');
    const st = { x: 5, y: 6, width: 900, height: 700, maximized: true };
    assert.strictEqual(WS.save(file, st), true);
    assert.deepStrictEqual(WS.load(file), st);
    assert.strictEqual(fs.existsSync(file + '.tmp'), false);
    for (const text of ['', '{"x": 1', 'null']) {
      fs.writeFileSync(file, text);
      assert.deepStrictEqual(WS.restore(WS.load(file), [FULL_HD], OPTS), { width: 1440, height: 900, maximized: false });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main.js берёт размер и место из правила и пишет их при закрытии', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert.match(main, /WindowState\.restore\(/);
  assert.match(main, /width: placed\.width/);
  assert.match(main, /'close'/);
});

test('модуль тот же, что в калькуляторах, кроме комментариев сверху', (t) => {
  const calc = path.join(__dirname, '..', '..', 'Calculators', 'calcpro-glass', 'window-state.js');
  if (!fs.existsSync(calc)) { t.skip('калькуляторов рядом нет (CI)'); return; }
  const body = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').split('const finite')[1];
  assert.strictEqual(body(path.join(__dirname, 'window-state.js')), body(calc));
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ORIGIN, PAGES, HARNESSES, CSP, pageFor, respond } = require('./serve');
const { cycle, tabForKey, statusFor, titleFor } = require('./tabs');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const SEED = Number(process.env.SEED) || 20260913;
const FILES = PAGES.map(p => p.file);
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

function rng(seed){
  return () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const pick = (next, list) => list[Math.floor(next() * list.length)];

const TOKENS = ['/', '/', '\\', '.', '..', '%2e', '%2E', '%2f', '%5c', '%00', '%20', ':', 'C:', '~',
  'index.html', 'webgl.html', 'package.json', 'electron', 'main.js', 'app.asar', '?', '#', '&', '=',
  'INDEX.HTML', 'resources', '//', '@', ' ', '\t', 'é', '%', '..;', 'glass'];

function randomPath(next){
  let s = '';
  for(let n = 1 + Math.floor(next() * 8); n > 0; n--) s += pick(next, TOKENS);
  return s;
}

/* ---------------- protocol ---------------- */

test('every page is served at its own path, and the root is the demo', () => {
  for(const f of FILES) assert.equal(pageFor(`${ORIGIN}/${f}`), f);
  assert.equal(pageFor(`${ORIGIN}/`), 'index.html');
  assert.equal(pageFor(ORIGIN), 'index.html');
});

test('the cache busting the harnesses append does not change the page', () => {
  for(const f of FILES){
    for(const tail of ['?t=1757700000000', '?inv=1757700000000', '?bench=1', '?seed=777', '#x', '?a=1&b=../../x'])
      assert.equal(pageFor(`${ORIGIN}/${f}${tail}`), f, f + tail);
  }
});

test('nothing outside the list is reachable, however it is spelled', () => {
  const escapes = ['/package.json', '/electron/main.js', '/electron/serve.js', '/electron/tabs.html',
    '/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/..%5cpackage.json', '/..\\package.json',
    '/index.html/', '/index.html%00', '/INDEX.HTML', '/Index.html', '//index.html', '/./%2e/index.htm',
    '/C:/Windows/win.ini', '/%43:/Windows/win.ini', '/resources/app.asar/package.json', '/index.html.map'];
  for(const p of escapes) assert.equal(pageFor(ORIGIN + p), null, p);
});

test('dot segments that stay inside still land on a listed page', () => {
  assert.equal(pageFor(`${ORIGIN}/x/../webgl.html`), 'webgl.html');
  assert.equal(pageFor(`${ORIGIN}/../../../webgl.html`), 'webgl.html');
  assert.equal(pageFor(`${ORIGIN}/%2e%2e/tests.html`), 'tests.html');
});

test('another origin gets nothing', () => {
  for(const href of ['app://evil/index.html', 'app://glass:81/index.html', 'http://glass/index.html',
    'https://glass/index.html', 'file:///C:/Drive/index.html', 'file://glass/index.html', 'apps://glass/index.html',
    'blob:app://glass/abc', 'data:text/html,index.html', 'about:blank'])
    assert.equal(pageFor(href), null, href);
});

test('garbage never throws and never resolves', () => {
  for(const junk of ['', ' ', 'app:', 'app://', '::', 'glass/index.html', '/index.html', `${ORIGIN}/%`,
    undefined, null, 42, {}, [], 'app://glass\u0000/index.html'])
    assert.equal(pageFor(junk), null, String(junk));
});

test(`fuzz: any path resolves to a listed page or to nothing (seed ${SEED})`, () => {
  const next = rng(SEED);
  let hits = 0;
  for(let i = 0; i < 30000; i++){
    const href = ORIGIN + '/' + randomPath(next);
    const got = pageFor(href);
    assert.ok(got === null || FILES.includes(got), href + ' -> ' + got);
    if(got) hits++;
  }
  assert.ok(hits > 0, 'the fuzz never reached a real page, so it proves little');
});

test('respond: 404 without touching the disk for anything unlisted', async () => {
  const next = rng(SEED + 1);
  const asked = [];
  const reader = async name => { asked.push(name); return 'x'; };
  for(let i = 0; i < 3000; i++){
    const href = ORIGIN + '/' + randomPath(next);
    const res = await respond(href, reader);
    assert.equal(res.status, pageFor(href) ? 200 : 404, href);
  }
  for(const name of asked) assert.ok(FILES.includes(name), 'reader asked for ' + name);
});

test('respond: a page comes back whole, uncached and under the policy', async () => {
  const res = await respond(`${ORIGIN}/webgl.html?t=1`, async name => `<!DOCTYPE html>${name}`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<!DOCTYPE html>webgl.html');
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('content-security-policy'), CSP);
});

test('the policy keeps everything on the machine', () => {
  const directives = CSP.split(';').map(d => d.trim().split(/\s+/));
  const names = directives.map(d => d[0]);
  assert.equal(new Set(names).size, names.length, 'a directive appears twice');
  assert.deepEqual(directives.find(d => d[0] === 'default-src').slice(1), ["'none'"]);
  for(const d of directives){
    for(const src of d.slice(1))
      assert.ok(!/^(https?:|wss?:|\*|'strict-dynamic')/.test(src), `${d[0]} allows ${src}`);
  }
  for(const need of ['worker-src', 'img-src', 'script-src', 'style-src', 'frame-src'])
    assert.ok(names.includes(need), need + ' missing, the pages need it');
});

/* ---------------- tabs ---------------- */

const press = (code, key, mods = {}) => ({ type: 'keyDown', code, key, ...mods });

test('Ctrl or Cmd with a digit opens that tab from any tab', () => {
  for(const active of FILES){
    FILES.forEach((f, i) => {
      const n = String(i + 1);
      assert.equal(tabForKey(press(`Digit${n}`, n, { control: true }), active), f);
      assert.equal(tabForKey(press(`Digit${n}`, n, { meta: true }), active), f);
      assert.equal(tabForKey(press('', n, { control: true }), active), f, 'an event without a code');
    });
  }
});

test('the digit row works on layouts that type something else there', () => {
  assert.equal(tabForKey(press('Digit1', '&', { control: true }), 'webgl.html'), 'index.html');
  assert.equal(tabForKey(press('Digit2', 'é', { control: true }), 'index.html'), 'webgl.html');
});

test('digits past the last tab, Shift, Alt and key up do nothing', () => {
  for(const d of ['0', '6', '7', '8', '9'])
    assert.equal(tabForKey(press(`Digit${d}`, d, { control: true }), 'index.html'), null, d);
  assert.equal(tabForKey(press('Digit2', '@', { control: true, shift: true }), 'index.html'), null);
  assert.equal(tabForKey(press('Digit2', '2', { control: true, alt: true }), 'index.html'), null);
  assert.equal(tabForKey({ type: 'keyUp', code: 'Digit2', key: '2', control: true }, 'index.html'), null);
});

test('Ctrl+Tab walks forward, Ctrl+Shift+Tab back, PageDown and PageUp the same', () => {
  for(const active of FILES){
    assert.equal(tabForKey(press('Tab', 'Tab', { control: true }), active), cycle(active, 1));
    assert.equal(tabForKey(press('Tab', 'Tab', { control: true, shift: true }), active), cycle(active, -1));
    assert.equal(tabForKey(press('PageDown', 'PageDown', { control: true }), active), cycle(active, 1));
    assert.equal(tabForKey(press('PageUp', 'PageUp', { control: true }), active), cycle(active, -1));
    assert.equal(tabForKey(press('Tab', 'Tab', { meta: true }), active), null, 'Cmd+Tab belongs to the OS');
  }
});

test('cycle visits every tab once and comes home, and back undoes forward', () => {
  for(const start of FILES){
    const seen = [];
    let at = start;
    for(let i = 0; i < FILES.length; i++){ seen.push(at); at = cycle(at, 1); }
    assert.equal(at, start);
    assert.deepEqual([...seen].sort(), [...FILES].sort());
    assert.equal(cycle(cycle(start, 1), -1), start);
    assert.equal(cycle(cycle(start, -1), 1), start);
  }
});

test(`fuzz: cycle by any step lands where modular arithmetic says (seed ${SEED})`, () => {
  const next = rng(SEED + 2);
  for(let i = 0; i < 20000; i++){
    const start = pick(next, FILES);
    const step = Math.floor(next() * 2001) - 1000;
    const n = FILES.length;
    assert.equal(cycle(start, step), FILES[((FILES.indexOf(start) + step) % n + n) % n], `${start} ${step}`);
  }
});

test(`fuzz: typing without Ctrl or Cmd never switches, and any event gives a tab or nothing (seed ${SEED})`, () => {
  const next = rng(SEED + 3);
  const codes = ['Digit1', 'Digit5', 'Digit9', 'Digit0', 'KeyA', 'Tab', 'PageUp', 'PageDown', 'Numpad3', 'Enter', '', undefined];
  const keys = ['1', '5', '9', '0', 'a', 'Tab', 'PageUp', 'PageDown', 'End', '&', 'Enter', '', undefined];
  for(let i = 0; i < 20000; i++){
    const input = {
      type: pick(next, ['keyDown', 'keyDown', 'keyUp', 'char', 'rawKeyDown']),
      code: pick(next, codes), key: pick(next, keys),
      control: next() < 0.5, meta: next() < 0.2, shift: next() < 0.3, alt: next() < 0.15,
    };
    const got = tabForKey(input, pick(next, FILES));
    assert.ok(got === null || FILES.includes(got), JSON.stringify(input));
    if(got) assert.ok(input.type === 'keyDown' && (input.control || input.meta) && !input.alt, JSON.stringify(input));
  }
});

test('the verdict a harness writes into its title is read back', () => {
  for(const h of HARNESSES){
    const src = fs.readFileSync(path.join(ROOT, h), 'utf8');
    const [, bad, good] = /document\.title = \(results\.fail \? '(\w+) ' : '(\w+) '\)/.exec(src) || [];
    assert.ok(bad && good, `${h} no longer writes its verdict the way statusFor reads it`);
    assert.equal(statusFor(`${good} 49/49`), 'ok', h);
    assert.equal(statusFor(`${bad} 3/49`), 'fail', h);
  }
  for(const f of FILES){
    const title = /<title>(.*?)<\/title>/.exec(fs.readFileSync(path.join(ROOT, f), 'utf8'))[1];
    assert.equal(statusFor(title), '', `${f} starts with a verdict before it has run`);
  }
  for(const t of ['', 'okay', 'ok', 'FAILED 2', 'bench — 121 fps', 'needs http, not file://'])
    assert.equal(statusFor(t), '', t);
});

test('the window title is the page title, or the app name while there is none', () => {
  assert.equal(titleFor('Liquid Glass — WebGL2'), 'Liquid Glass — WebGL2');
  for(const t of ['', undefined, 'app://glass/tests.html', 'file:///C:/x/tabs.html']) assert.equal(titleFor(t), 'Liquid Glass');
});

/* ---------------- files that must agree with each other ---------------- */

test('every page on disk is listed, and every listed page ships', () => {
  const onDisk = fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).sort();
  assert.deepEqual([...FILES].sort(), onDisk);
  for(const f of FILES) assert.ok(pkg.build.files.includes(f), f + ' is not packaged');
});

test('everything the shell loads at run time ships with it', () => {
  assert.ok(pkg.build.files.includes(pkg.main), 'main is not packaged');
  const shipped = fs.readdirSync(__dirname).filter(f => !f.endsWith('.test.js'));
  for(const f of shipped){
    assert.ok(pkg.build.files.includes(`electron/${f}`), `electron/${f} is not packaged`);
    if(!f.endsWith('.js')) continue;
    const code = read(f);
    for(const [, dep] of code.matchAll(/require\('\.\/([\w-]+)'\)/g))
      assert.ok(shipped.includes(`${dep}.js`), `${f} requires ${dep}, which does not exist`);
    for(const [, file] of code.matchAll(/path\.join\(__dirname, '(\w[\w-]*\.\w+)'\)/g))
      assert.ok(shipped.includes(file), `${f} loads ${file}, which is not packaged`);
  }
});

test('every page the pages point at exists in the app', () => {
  for(const f of FILES){
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for(const [, ref] of html.matchAll(/["'`]([\w-]+\.html)/g))
      assert.ok(FILES.includes(ref), `${f} points at ${ref}`);
  }
});

test('the tab bar, its preload and the main process speak the same channels', () => {
  const preload = read('tabs-preload.js'), main = read('main.js'), bar = read('tabs.html');
  const sent = [...preload.matchAll(/ipcRenderer\.send\('([\w:]+)'/g)].map(m => m[1]);
  const heard = [...preload.matchAll(/ipcRenderer\.on\('([\w:]+)'/g)].map(m => m[1]);
  assert.ok(sent.length && heard.length);
  for(const ch of sent) assert.match(main, new RegExp(`ipcMain\\.on\\('${ch}'`), `nobody in main listens on ${ch}`);
  for(const ch of heard) assert.match(main, new RegExp(`\\.send\\('${ch}'`), `main never sends ${ch}`);
  const exposed = [...preload.matchAll(/^\s+(\w+): /gm)].map(m => m[1]);
  for(const [, fn] of bar.matchAll(/\bshell\.(\w+)\(/g)) assert.ok(exposed.includes(fn), `the bar calls shell.${fn}, which preload does not expose`);
});

test('the selftest drives pages that exist, and menu labels are distinct', () => {
  for(const h of HARNESSES) assert.ok(FILES.includes(h), h);
  const labels = PAGES.map(p => p.label);
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(PAGES.length <= 9, 'shortcuts run Ctrl+1..9');
});

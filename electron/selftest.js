const { app, BaseWindow, Menu, net, session } = require('electron');
const { ORIGIN, PAGES, HARNESSES } = require('./serve');
const { cycle, titleFor } = require('./tabs');

const FILES = PAGES.map(p => p.file);
const SEED = Number(process.env.SEED) || 20260913;
const STEPS = 150;
const BAR = 40;
const ESCAPES = [
  '/package.json',
  '/electron/main.js',
  '/electron/tabs.html',
  '/../package.json',
  '/%2e%2e/package.json',
  '/..%2fpackage.json',
  '/..%5cpackage.json',
  '/index.html/../../package.json',
  '/INDEX.HTML',
  '/index.html%00',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = (wc, src) => wc.executeJavaScript(src);
const problems = [];

function report(ok, name, why = ''){
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${why ? `  (${why})` : ''}`);
  if(!ok) problems.push(name);
}

async function until(check, ms = 5000, every = 50){
  const end = Date.now() + ms;
  for(;;){
    const got = await Promise.resolve().then(check).catch(() => null);
    if(got || Date.now() > end) return got;
    await sleep(every);
  }
}

function rng(seed){
  return () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function pathOf(wc){
  try{ return new URL(wc.getURL()).pathname; }catch{ return wc.getURL(); }
}

const ready = wc => until(() => !wc.isLoading() && wc.getURL(), 15000);

function key(wc, keyCode, modifiers){
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

async function inconsistencies(shell){
  const errs = [];
  const { width, height } = shell.win.getContentBounds();
  const visible = [...shell.views].filter(([, v]) => v.getVisible()).map(([f]) => f);
  if(visible.join() !== shell.active) errs.push(`visible: ${visible.join(', ') || 'none'} while ${shell.active} is active`);
  for(const [f, v] of shell.views){
    if(pathOf(v.webContents) !== '/' + f) errs.push(`the ${f} tab shows ${pathOf(v.webContents)}`);
    const b = v.getBounds();
    if(b.x !== 0 || b.y !== BAR || b.width !== width || b.height !== height - BAR)
      errs.push(`${f} sits at ${JSON.stringify(b)} in a ${width}x${height} window`);
  }
  const bb = shell.bar.getBounds();
  if(bb.x !== 0 || bb.y !== 0 || bb.width !== width || bb.height !== BAR) errs.push(`bar sits at ${JSON.stringify(bb)}`);
  const tabs = await js(shell.bar.webContents,
    `[...document.querySelectorAll('[role=tab]')].map(b => [b.dataset.page, b.getAttribute('aria-selected')])`);
  if(tabs.map(t => t[0]).join() !== FILES.join()) errs.push(`bar lists ${tabs.map(t => t[0]).join(', ')}`);
  const on = tabs.filter(t => t[1] === 'true').map(t => t[0]);
  if(on.join() !== shell.active) errs.push(`bar marks ${on.join(', ') || 'nothing'} while ${shell.active} is active`);
  const want = titleFor(shell.views.get(shell.active)?.webContents.getTitle());
  if(shell.win.getTitle() !== want) errs.push(`window says '${shell.win.getTitle()}', the page says '${want}'`);
  return errs;
}

async function steady(shell, ms = 3000){
  await until(async () => (await inconsistencies(shell)).length === 0, ms);
  return inconsistencies(shell).catch(err => [String(err)]);
}

async function protocolChecks(){
  for(const p of [...FILES, '']){
    const res = await net.fetch(`${ORIGIN}/${p}`);
    const body = await res.text();
    report(res.status === 200 && /^<!doctype html>/i.test(body)
      && res.headers.get('content-security-policy')?.includes("default-src 'none'"),
      `serves /${p} with its policy`, `status ${res.status}`);
  }
  for(const p of ESCAPES){
    const res = await net.fetch(ORIGIN + p);
    report(res.status === 404, `refuses ${p}`, `status ${res.status}`);
  }
}

async function startChecks(shell){
  const errs = await steady(shell);
  report(!errs.length, 'the window opens on the demo with a consistent tab bar', errs[0]);
  report(shell.views.size === 1, 'a tab is created only when it is first opened', `${shell.views.size} at start`);
}

async function pageChecks(shell){
  const wc = shell.views.get('index.html').webContents;
  const env = await js(wc,
    `({ secure: isSecureContext, proto: location.protocol, squircle: CSS.supports('corner-shape', 'squircle'),
        gl2: !!document.createElement('canvas').getContext('webgl2') })`);
  report(env.secure && env.proto === 'app:', 'page is a secure context on app:', env.proto);
  report(env.gl2, 'webgl2 is available');
  console.log(`     corner-shape: squircle ${env.squircle ? 'supported' : 'not supported'}`);

  const windows = BaseWindow.getAllWindows().length, tabs = shell.views.size;
  const popup = await js(wc, `window.open('${ORIGIN}/webgl.html') === null`);
  await sleep(300);
  report(popup && BaseWindow.getAllWindows().length === windows && shell.views.size === tabs, 'window.open is refused');

  await js(wc, `location.href = 'https://example.com/'; 0`);
  await sleep(1000);
  report(pathOf(wc) === '/index.html' && shell.active === 'index.html', 'navigation off the app is blocked', wc.getURL());

  await js(wc, 'window.__mark = 7; 0');
  await js(wc, `document.querySelector('a[href="webgl.html"]').click(); 0`);
  const went = await until(() => shell.active === 'webgl.html');
  const gl = shell.views.get('webgl.html')?.webContents;
  if(gl) await ready(gl);
  report(went && pathOf(wc) === '/index.html' && gl && pathOf(gl) === '/webgl.html',
    'a link to another page opens that tab and leaves this one where it was', `active ${shell.active}`);

  /* Chromium hides a window another window covers, so the open tab can only
     be as visible as the window. The tab bar shares the window and tells us. */
  const vis = { window: await js(shell.bar.webContents, 'document.visibilityState') };
  for(const [f, v] of shell.views) vis[f] = await js(v.webContents, 'document.visibilityState');
  report(vis['index.html'] === 'hidden' && vis['webgl.html'] === vis.window,
    'a tab in the background is hidden to its page, the open one is as visible as the window', JSON.stringify(vis));
  if(vis.window !== 'visible') console.log('     the window is covered, so frame rates below will be skipped');

  await js(gl, `document.querySelector('a[href="index.html"]').click(); 0`);
  const back = await until(() => shell.active === 'index.html');
  report(back && await js(wc, 'window.__mark') === 7, 'switching tabs keeps each page alive, nothing reloads');

  await js(gl, 'window.__mark = 1; 0');
  await js(shell.bar.webContents, `document.getElementById('reload').click(); 0`);
  const reloaded = await until(() => js(wc, 'window.__mark === undefined && document.readyState === "complete"'), 10000, 200);
  report(reloaded && await js(gl, 'window.__mark') === 1, 'the reload button reloads the open tab and only that one');
  await ready(wc);
}

async function layoutChecks(shell){
  const [w, h] = shell.win.getSize();
  for(const [sw, sh] of [[900, 640], [520, 400], [w, h]]){
    shell.win.setSize(sw, sh);
    const errs = await steady(shell);
    report(!errs.length, `the bar and the page follow a resize to ${sw}x${sh}`, errs[0]);
  }
}

async function harness(shell, show, page){
  show(page);
  const wc = shell.views.get(page).webContents;
  const res = await until(() => js(wc,
    'window.__results && ({ pass: __results.pass, fail: __results.fail, skip: __results.skip, cases: __results.cases })'),
    5 * 60_000, 500);
  if(!res) return report(false, `${page} finished`, 'timed out after 5 min');
  const broke = await js(wc,
    `[...document.querySelectorAll('.row.fail')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
  broke.forEach(line => console.log(`     ${line}`));
  report(res.fail === 0, `${page}: ${res.pass} pass, ${res.fail} fail, ${res.skip} skip`
    + (res.cases ? `, ${res.cases} cases` : ''));
  const verdict = res.fail ? 'fail' : 'ok';
  const dot = await until(() => js(shell.bar.webContents,
    `document.querySelector('[data-page="${page}"] .dot').className`).then(c => c.includes(verdict) && c), 3000);
  report(!!dot, `the ${page} tab shows its verdict`, dot || 'no dot');
}

async function benchReaches(shell, show){
  show('bench.html');
  const wc = shell.views.get('bench.html').webContents;
  const round = await until(() => js(wc, `document.getElementById('sum').textContent.startsWith('round')`), 30_000, 250);
  report(round, 'bench.html reaches into its frame');
}

function menuChecks(){
  const menu = Menu.getApplicationMenu();
  PAGES.forEach((p, i) => {
    const item = menu.getMenuItemById(p.file);
    report(item?.accelerator === `CmdOrCtrl+${i + 1}` && item.label === p.label,
      `the Pages menu has ${p.label} on Ctrl+${i + 1}`, item?.accelerator);
  });
}

/* A random walk through every way of switching, checked against a model of
   which tab should be open and against everything that must hold afterwards. */
async function walk(shell){
  const next = rng(SEED);
  const menu = Menu.getApplicationMenu();
  const broke = [];
  let expected = shell.active;
  for(let i = 0; i < STEPS && broke.length < 3; i++){
    const target = FILES[Math.floor(next() * FILES.length)];
    const page = shell.views.get(shell.active).webContents;
    const r = Math.floor(next() * 6);
    let what;
    if(r === 0){
      what = `click ${target}`;
      await js(shell.bar.webContents, `document.querySelector('[data-page="${target}"]').click(); 0`);
      expected = target;
    }else if(r === 1){
      const n = FILES.indexOf(target) + 1;
      what = `Ctrl+${n} in the page`;
      key(page, String(n), ['control']);
      expected = target;
    }else if(r === 2){
      const back = next() < 0.5;
      what = back ? 'Ctrl+Shift+Tab' : 'Ctrl+Tab';
      key(page, 'Tab', back ? ['control', 'shift'] : ['control']);
      expected = cycle(expected, back ? -1 : 1);
    }else if(r === 3){
      what = `menu ${target}`;
      menu.getMenuItemById(target).click();
      expected = target;
    }else if(r === 4){
      const back = next() < 0.5;
      what = back ? 'Ctrl+PageUp in the bar' : 'Ctrl+PageDown in the bar';
      key(shell.bar.webContents, back ? 'PageUp' : 'PageDown', ['control']);
      expected = cycle(expected, back ? -1 : 1);
    }else if(shell.active === 'index.html' || shell.active === 'webgl.html'){
      const to = shell.active === 'index.html' ? 'webgl.html' : 'index.html';
      what = `link to ${to}`;
      await js(page, `document.querySelector('a[href="${to}"]').click(); 0`);
      expected = to;
    }else{
      what = 'nothing';
    }
    const landed = await until(() => shell.active === expected, 3000);
    const errs = landed ? await steady(shell) : [`open ${shell.active}, expected ${expected}`];
    if(errs.length) broke.push(`step ${i}, ${what}: ${errs[0]}`);
  }
  broke.forEach(b => console.log(`     ${b}`));
  report(!broke.length, `${STEPS} random switches keep the tabs consistent (seed ${SEED})`);
}

async function run({ openShell, show }){
  console.log(`electron ${process.versions.electron}, chromium ${process.versions.chrome}, `
    + `${app.isPackaged ? 'packaged' : 'from source'}`);

  const external = [];
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (d, cb) => { external.push(d.url); cb({ cancel: true }); });
  const refused = [];
  app.on('web-contents-created', (_e, wc) => wc.on('console-message', e => {
    if(/Content Security Policy/.test(e.message)) refused.push(e.message);
  }));

  const shell = openShell('index.html');
  await ready(shell.bar.webContents);
  await ready(shell.views.get('index.html').webContents);

  await protocolChecks();
  await startChecks(shell);
  await pageChecks(shell);
  await layoutChecks(shell);

  /* prove the policy listener can see a refusal before trusting its silence */
  const wc = shell.views.get('index.html').webContents;
  await js(wc, `new Image().src = 'https://example.com/x.png'; 0`);
  report(await until(() => refused.length > 0, 2000), 'a remote image is refused by the policy');
  refused.length = 0;
  external.length = 0;

  for(const page of HARNESSES) await harness(shell, show, page);
  await benchReaches(shell, show);
  menuChecks();
  await walk(shell);

  report(refused.length === 0, 'the policy refused nothing the pages need', refused[0]);
  report(external.length === 0, 'no request left the machine', external[0]);

  console.log(problems.length ? `selftest: ${problems.length} problem(s)` : 'selftest: clean');
  app.exit(problems.length ? 1 : 0);
}

module.exports = { run };

const { app, BaseWindow, Menu, WebContentsView, ipcMain, protocol, screen, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { SCHEME, ORIGIN, PAGES, pageFor, respond } = require('./serve');
const { cycle, tabForKey, statusFor, titleFor } = require('./tabs');

const SELFTEST = process.argv.includes('--selftest');
const ROOT = path.join(__dirname, '..');

/* its own profile, so a check run beside an open window neither fights it
   for the cache nor leaves anything in the real one */
if(SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), 'liquid-glass-selftest'));
const BAR = 40;
const BG = '#0d0d13';
const PREFS = { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false };

/* file:// gives every page its own opaque origin, and the harnesses must
   reach into the frames they drive. A standard scheme gives them one origin. */
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true } },
]);

let shell = null;

const activeContents = () => shell?.views.get(shell.active)?.webContents;

function layout(){
  const { width, height } = shell.win.getContentBounds();
  shell.bar.setBounds({ x: 0, y: 0, width, height: BAR });
  for(const v of shell.views.values()) v.setBounds({ x: 0, y: BAR, width, height: Math.max(0, height - BAR) });
}

function pushState(){
  if(!shell) return;
  const status = {};
  for(const [f, v] of shell.views) status[f] = statusFor(v.webContents.getTitle());
  shell.bar.webContents.send('tabs:state', { pages: PAGES, active: shell.active, status });
}

function retitle(){
  shell.win.setTitle(titleFor(activeContents()?.getTitle()));
}

function onKeys(e, input){
  const page = shell && tabForKey(input, shell.active);
  if(!page) return;
  e.preventDefault();
  show(page);
}

function viewFor(file){
  let v = shell.views.get(file);
  if(v) return v;
  v = new WebContentsView({ webPreferences: PREFS });
  v.setBackgroundColor(BG);
  const wc = v.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  /* a link to another page opens that tab instead of replacing this one */
  wc.on('will-frame-navigate', e => {
    if(e.url === 'about:blank') return;
    const page = pageFor(e.url);
    if(!page) return e.preventDefault();
    if(e.isMainFrame && page !== file){
      e.preventDefault();
      show(page);
    }
  });
  wc.on('before-input-event', onKeys);
  wc.on('page-title-updated', () => {
    if(shell?.active === file) retitle();
    pushState();
  });
  shell.views.set(file, v);
  shell.win.contentView.addChildView(v);
  layout();
  wc.loadURL(`${ORIGIN}/${file}`);
  return v;
}

function show(file){
  if(!shell) return openShell(file);
  const v = viewFor(file);
  shell.active = file;
  for(const [f, o] of shell.views) o.setVisible(f === file);
  retitle();
  pushState();
  v.webContents.focus();
}

function openShell(first){
  const area = screen.getPrimaryDisplay().workAreaSize;
  const win = new BaseWindow({
    width: Math.min(1440, area.width),
    height: Math.min(900, area.height),
    minWidth: 480,
    minHeight: 360,
    backgroundColor: BG,
    autoHideMenuBar: true,
    title: 'Liquid Glass',
    show: false,
  });
  const bar = new WebContentsView({ webPreferences: { ...PREFS, preload: path.join(__dirname, 'tabs-preload.js') } });
  bar.setBackgroundColor(BG);
  shell = { win, bar, views: new Map(), active: first };
  win.contentView.addChildView(bar);
  const wc = bar.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', e => e.preventDefault());
  wc.on('before-input-event', onKeys);
  wc.on('did-finish-load', pushState);
  wc.loadFile(path.join(__dirname, 'tabs.html'));
  win.on('resize', layout);
  /* views are not torn down with the window on their own */
  win.on('closed', () => {
    for(const v of [bar, ...shell.views.values()]) v.webContents.close();
    shell = null;
  });
  show(first);
  win.show();
  return shell;
}

ipcMain.on('tabs:show', (e, file) => {
  if(shell && e.sender === shell.bar.webContents && PAGES.some(p => p.file === file)) show(file);
});
ipcMain.on('tabs:reload', e => {
  if(shell && e.sender === shell.bar.webContents) activeContents()?.reload();
});

function zoom(step){
  const wc = activeContents();
  if(wc) wc.setZoomLevel(wc.getZoomLevel() + step);
}

function buildMenu(){
  const mac = process.platform === 'darwin';
  const tab = (label, accelerator, pick, id) =>
    ({ label, id, accelerator, registerAccelerator: false, click: () => show(pick()) });
  const pages = PAGES.flatMap((p, i) => [
    ...(i === 2 ? [{ type: 'separator' }] : []),
    tab(p.label, `CmdOrCtrl+${i + 1}`, () => p.file, p.file),
  ]);
  pages.push({ type: 'separator' },
    tab('Next tab', 'Ctrl+Tab', () => cycle(shell?.active, 1), 'next'),
    tab('Previous tab', 'Ctrl+Shift+Tab', () => cycle(shell?.active, -1), 'previous'));
  return Menu.buildFromTemplate([
    mac ? { role: 'appMenu' } : { label: 'File', submenu: [{ role: 'quit' }] },
    { label: 'Pages', submenu: pages },
    { label: 'View', submenu: [
      { label: 'Reload tab', id: 'reload', accelerator: 'CmdOrCtrl+R', click: () => activeContents()?.reload() },
      { label: 'Force reload tab', accelerator: 'CmdOrCtrl+Shift+R', click: () => activeContents()?.reloadIgnoringCache() },
      { label: 'Developer tools', accelerator: mac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: () => activeContents()?.toggleDevTools() },
      { type: 'separator' },
      { label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: () => activeContents()?.setZoomLevel(0) },
      { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: () => zoom(0.5) },
      { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.5) },
      { type: 'separator' },
      { label: 'Full screen', accelerator: mac ? 'Ctrl+Cmd+F' : 'F11', click: () => shell?.win.setFullScreen(!shell.win.isFullScreen()) },
    ] },
    ...(mac ? [{ role: 'windowMenu' }] : []),
  ]);
}

function start(){
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, grant) => grant(false));
  protocol.handle(SCHEME, req => respond(req.url, page => fs.readFile(path.join(ROOT, page))));
  Menu.setApplicationMenu(buildMenu());
  if(SELFTEST) return require('./selftest').run({ openShell, show, buildMenu });
  openShell('index.html');
}

/* A second selftest must run, not quietly hand over to the open window and
   exit 0 as if it had passed. */
if(!SELFTEST && !app.requestSingleInstanceLock()){
  app.quit();
}else{
  app.on('second-instance', () => {
    if(!shell) return openShell('index.html');
    if(shell.win.isMinimized()) shell.win.restore();
    shell.win.focus();
  });
  app.on('activate', () => {
    if(!shell) openShell('index.html');
  });
  app.on('window-all-closed', () => {
    if(process.platform !== 'darwin') app.quit();
  });
  app.whenReady().then(start);
}

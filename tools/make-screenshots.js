/* Снимки страниц для README: собираются программой, а не руками.

     npx electron tools/make-screenshots.js

   Страницы открываются в том же виде, что и в приложении: та же схема app://,
   тот же серв из electron/serve.js, те же заголовки. Снимок берётся с самой
   страницы через capturePage(), а не с экрана: окно может оказаться позади
   других, и в кадр попадёт чужое содержимое.

   Кадры делаются не сразу. Стеклу нужно построить свои текстуры, а WebGL -
   первый кадр; поэтому скрипт ждёт, пока страница сама скажет, что готова
   (у каждой есть свой признак), и только потом снимает. */

const { app, BaseWindow, WebContentsView, protocol } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { SCHEME, ORIGIN, respond } = require('../electron/serve');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const SIZE = { width: 1280, height: 800 };

/* Что снимаем и чего ждём на каждой странице. Ожидание - не сон на всякий
   случай: пока текстуры кромки не построены, в кадре будет полупустая панель. */
const SHOTS = [
  {
    file: 'index.html',
    name: 'css-svg.png',
    ready: `!!document.querySelector('.glass, [data-glass], svg filter') && document.readyState === 'complete'`,
  },
  {
    file: 'webgl.html',
    name: 'webgl.png',
    ready: `(() => { const c = document.querySelector('canvas');
                     return !!c && c.width > 0 && document.readyState === 'complete'; })()`,
  },
];

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true } },
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(wc, expr, ms = 15000){
  const end = Date.now() + ms;
  for(;;){
    const got = await wc.executeJavaScript(expr).catch(() => false);
    if(got) return true;
    if(Date.now() > end) return false;
    await sleep(100);
  }
}

async function main(){
  await fs.mkdir(OUT, { recursive: true });
  protocol.handle(SCHEME, req => respond(req.url, page => fs.readFile(path.join(ROOT, page))));

  const win = new BaseWindow({ ...SIZE, show: true, backgroundColor: '#0d0d13' });
  let bad = 0;

  for(const shot of SHOTS){
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, ...SIZE });
    await view.webContents.loadURL(`${ORIGIN}/${shot.file}`);

    const ready = await until(view.webContents, shot.ready);
    if(!ready) console.log(`  ${shot.name}: страница не сообщила о готовности, снимаю как есть`);
    /* Два кадра сверх готовности: первый рисуется ещё без стекла, а
       анимация фона должна успеть сдвинуться - иначе кадры одинаковы. */
    await sleep(1200);

    const image = await view.webContents.capturePage();
    const png = image.toPNG();
    if(png.length < 10_000){ console.log(`  ${shot.name}: кадр пустой`); bad++; }
    await fs.writeFile(path.join(OUT, shot.name), png);
    console.log(`  ${shot.name} (${Math.round(png.length / 1024)} КБ)`);

    win.contentView.removeChildView(view);
    view.webContents.close();
  }

  win.destroy();
  console.log(`Готово: ${OUT}`);
  app.exit(bad ? 1 : 0);
}

app.whenReady().then(main);

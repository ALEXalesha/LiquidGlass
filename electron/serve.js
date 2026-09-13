const SCHEME = 'app';
const HOST = 'glass';
const ORIGIN = `${SCHEME}://${HOST}`;

const PAGES = [
  { file: 'index.html', label: 'CSS + SVG' },
  { file: 'webgl.html', label: 'WebGL2' },
  { file: 'tests.html', label: 'Checks' },
  { file: 'invariants.html', label: 'Invariants' },
  { file: 'bench.html', label: 'Bench' },
];

const HARNESSES = ['tests.html', 'invariants.html'];

/* Nothing leaves the machine. The pages build their worker from a blob and
   their maps as data urls, and the harnesses eval inside the frames they drive. */
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  'worker-src blob:',
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  `frame-src ${ORIGIN}`,
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': CSP,
};

/* Only the listed files can ever be read, so no path, however it is spelled,
   reaches anything else inside the package. */
function pageFor(href){
  let url;
  try{ url = new URL(href); }catch{ return null; }
  if(url.protocol !== `${SCHEME}:` || url.host !== HOST) return null;
  const name = url.pathname.replace(/^\//, '') || 'index.html';
  return PAGES.some(p => p.file === name) ? name : null;
}

async function respond(href, readPage){
  const page = pageFor(href);
  if(!page) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return new Response(await readPage(page), { headers: HEADERS });
}

module.exports = { SCHEME, HOST, ORIGIN, PAGES, HARNESSES, CSP, pageFor, respond };

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const N = 512;
const px = Buffer.alloc(N * N * 4);

const clamp = x => Math.min(1, Math.max(0, x));
const mix = (a, b, t) => a + (b - a) * t;

function squircle(x, y, half){
  const u = Math.abs(x - N / 2) / half, v = Math.abs(y - N / 2) / half;
  return (Math.pow(u ** 4 + v ** 4, 0.25) - 1) * half;
}

function wall(x, y){
  const t = y / N;
  let r = mix(40, 150, t), g = mix(120, 60, t), b = mix(230, 190, t);
  const blob = Math.exp(-((x - 150) ** 2 + (y - 170) ** 2) / 9000);
  r = mix(r, 255, blob * 0.7); g = mix(g, 170, blob * 0.7); b = mix(b, 90, blob * 0.7);
  const stripe = (Math.floor((x + y) / 34) % 2) * 0.08;
  return [r * (1 - stripe), g * (1 - stripe), b * (1 - stripe)];
}

const BODY = 236, LENS = 150, BEVEL = 34;

for(let y = 0; y < N; y++){
  for(let x = 0; x < N; x++){
    const body = clamp(0.5 - squircle(x, y, BODY));
    let [r, g, b] = wall(x, y);
    const d = squircle(x, y, LENS);
    const inside = clamp(0.5 - d);
    if(inside > 0){
      const t = clamp(-d / BEVEL);
      const h = Math.sqrt(1 - (1 - t) ** 2);
      const pull = (1 - h) * 0.55;
      const [wr, wg, wb] = wall(mix(x, N / 2, pull), mix(y, N / 2, pull));
      const lit = clamp((N / 2 - y) / LENS * 0.5 + 0.5);
      const rim = (1 - t) ** 3;
      const glassR = mix(wr, 255, 0.10) + rim * 150 * lit;
      const glassG = mix(wg, 255, 0.10) + rim * 150 * lit;
      const glassB = mix(wb, 255, 0.10) + rim * 160 * lit;
      r = mix(r, glassR, inside); g = mix(g, glassG, inside); b = mix(b, glassB, inside);
    }
    const shadow = inside < 1 ? Math.exp(-Math.max(0, d) / 10) * 0.35 * (1 - inside) : 0;
    const i = (y * N + x) * 4;
    px[i] = clamp(r * (1 - shadow) / 255) * 255;
    px[i + 1] = clamp(g * (1 - shadow) / 255) * 255;
    px[i + 2] = clamp(b * (1 - shadow) / 255) * 255;
    px[i + 3] = body * 255;
  }
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for(let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf){
  let c = 0xFFFFFFFF;
  for(const byte of buf) c = CRC[(c ^ byte) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, body){
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const tagged = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tagged));
  return Buffer.concat([len, tagged, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; ihdr[9] = 6;

const rows = Buffer.alloc(N * (N * 4 + 1));
for(let y = 0; y < N; y++) px.copy(rows, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);

fs.writeFileSync(path.join(__dirname, 'icon.png'), Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]));

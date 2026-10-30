// Builds the app icons in public/icons/ from public/icon.svg, for installing devdeck as an app (PWA):
// icon-192/512.png (rounded, as the SVG), maskable-512.png (full-bleed, the mark inside Android's safe zone) and
// apple-touch-icon.png (full-bleed; iOS rounds it). Needs Playwright with Chrome: node scripts/pwa-icons.mjs <playwright-core dir>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const [pw = 'playwright-core'] = process.argv.slice(2);
const { chromium } = await import(pw.includes('/') ? join(pw, 'index.mjs') : pw);
const root = join(import.meta.dirname, '..');
const svg = readFileSync(join(root, 'public', 'icon.svg'), 'utf8');
const mark = svg.match(/<g [\s\S]*<\/g>/)[0].replace(/<g transform="[^"]*">/, '').replace(/<\/g>$/, '');
const bg = /fill="(#[0-9a-f]{6})"/i.exec(svg)[1];
// full-bleed square; the 24-unit mark scaled to `size` px and centred (its drawing spans x 3–21, y 2.5–20.5)
const flat = (size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${bg}"/><g transform="translate(${256 - 12 * (size / 18)} ${256 - 11.5 * (size / 18)}) scale(${size / 18})">${mark}</g></svg>`;
const out = [
  ['icon-192.png', 192, svg],
  ['icon-512.png', 512, svg],
  ['maskable-512.png', 512, flat(270)], // inside the 80% safe circle
  ['apple-touch-icon.png', 180, flat(330)],
];
const b = await chromium.launch({ channel: 'chrome', headless: true });
for (const [name, px, src] of out) {
  const p = await b.newPage({ viewport: { width: px, height: px } });
  await p.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${px}px;height:${px}px}</style>${src}`);
  await p.screenshot({ path: join(root, 'public', 'icons', name), omitBackground: true });
  console.log(`public/icons/${name} ${px}x${px}`);
}
await b.close();

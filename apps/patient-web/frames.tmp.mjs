import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
const [,, out, ...vids] = process.argv;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
let i = 0;
for (const [v, t] of vids.map((x) => x.split('@'))) {
  await p.setContent(`<video id=v src="${pathToFileURL(v).href}" muted style="max-height:840px"></video>`);
  await p.evaluate(async (t) => { const v = document.getElementById('v'); await new Promise(r => v.readyState >= 1 ? r() : v.onloadedmetadata = r); v.currentTime = Number(t); await new Promise(r => v.onseeked = r); }, t);
  await p.screenshot({ path: `${out}/frame${i++}.png` });
}
await b.close();

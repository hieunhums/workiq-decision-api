import { chromium } from 'playwright';

const b = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await b.newContext({ permissions: ['microphone'] });
const p = await ctx.newPage();
const errs = [];
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));

await p.goto('http://localhost:3000', { waitUntil: 'networkidle' });
console.log('page title:', await p.title());

await p.getByRole('button', { name: /talk|start|connect/i }).first().click();
await p.waitForSelector('text=/Listening|Speaking/', { timeout: 30000 });
console.log('connected: WebRTC up');

const t0 = Date.now();
await p.getByPlaceholder('Or type it').fill('Who is my manager?');
await p.getByRole('button', { name: 'Ask', exact: true }).click();

// wait for the lookup's receipt to appear on the question's card
await p.waitForSelector('article button[title="How this was answered"]', { timeout: 60000 });
console.log(`lookup started after ${((Date.now()-t0)/1000).toFixed(1)}s`);

await p.waitForTimeout(12000);
const cards = await p.$$eval('article', ns => ns.map(n => n.innerText.slice(0, 600)));
console.log('--- exchanges, newest first');
cards.forEach(c => console.log(c + '\n'));
await p.locator('article button[title="How this was answered"]').first().click();
const details = await p.$eval('[role=dialog]', n => n.innerText.slice(0, 600)).catch(() => '(none)');
console.log('--- details\n' + details);
console.log('--- console errors:', errs.length ? errs.slice(0,5) : 'none');
await p.screenshot({ path: '/tmp/vq/shot.png', fullPage: true });
await b.close();

/**
 * GitHub 真实站点验证（未登录也能覆盖 README / 简介 / 语言徽标区域）
 * 用法：XT_PW=<pw> node test/github-live.mjs [url]
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.XT_PW || 'playwright-core');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9389;
const PROFILE = path.join(os.tmpdir(), 'xt-ghl-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USER_STORE =
  path.join(
    process.env.LOCALAPPDATA || '',
    'Google/Chrome/User Data/Default/Local Extension Settings/bfkgpoocjcajokhldlhobeieeflcehpo'
  );
const TARGET = process.argv[2] || 'https://github.com/ziglang/zig';

async function waitPort(t = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error('端口未就绪');
}

await fs.mkdir(PROFILE, { recursive: true });
const dst = path.join(PROFILE, 'Default', 'Local Extension Settings', 'bfkgpoocjcajokhldlhobeieeflcehpo');
await fs.mkdir(dst, { recursive: true });
for (const f of await fs.readdir(USER_STORE)) {
  if (/\.(ldb|log)$/.test(f)) await fs.copyFile(path.join(USER_STORE, f), path.join(dst, f)).catch(() => {});
}

const proc = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,1000',
    'about:blank'
  ],
  { stdio: 'ignore' }
);
const HARD = setTimeout(() => {
  console.log('[超时]');
  process.exit(1);
}, 300000);
HARD.unref?.();

let browser;
try {
  await waitPort();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const cdp = await browser.newBrowserCDPSession();
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT });
  await sleep(1400);
  const ctx = browser.contexts()[0];
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: 'domcontentloaded' });
  await sleep(400);
  await opt.evaluate(() => chrome.runtime.sendMessage({ type: 'XT_CLEAR_CACHE' }));
  await opt.close();

  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (/\[XT\]/.test(t)) console.log('   [content]', t.slice(0, 170));
  });
  console.log('打开', TARGET);
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(9000);

  let stat = null;
  for (let i = 0; i < 40; i++) {
    stat = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.xt-translation')];
      const hist = {};
      for (const b of boxes) {
        const k = b.dataset.xtEngine || '(无)';
        hist[k] = (hist[k] || 0) + 1;
      }
      return {
        boxes: boxes.length,
        hist,
        ui: document.querySelectorAll('[data-xt-ui="1"]').length,
        samples: boxes.slice(0, 6).map((b) => b.textContent.trim().slice(0, 80)),
        pre: document.querySelector('pre, code')?.textContent?.slice(0, 60) || '',
        descTr: [...document.querySelectorAll('[class*="description__"] > .xt-translation')].map((e) =>
          e.textContent.trim().slice(0, 80)
        )
      };
    });
    if (stat.boxes >= 8) break;
    await sleep(2000);
  }

  console.log('\n=== 结果 ===');
  console.log('译文块：', stat.boxes, '| 界面词条：', stat.ui, '| 引擎：', JSON.stringify(stat.hist));
  console.log('简介译文：', stat.descTr.join(' | ') || '(无)');
  console.log('样例：');
  for (const s of stat.samples) console.log('  ·', s);

  await page.screenshot({ path: path.join(__dirname, 'shot-github-live.png'), fullPage: false }).catch(() => {});
} finally {
  clearTimeout(HARD);
  try {
    if (browser) await browser.close();
  } catch {}
  try {
    proc.kill();
  } catch {}
}

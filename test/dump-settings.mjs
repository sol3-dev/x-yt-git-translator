/**
 * GitHub 仓库设置页：未翻译文案清单
 * -------------------------------------------------------------------------
 * 用法：
 *   node test/dump-settings.mjs                       # General
 *   node test/dump-settings.mjs access                # /settings/access
 *   node test/dump-settings.mjs "" 1                  # 加载扩展后再扫（看翻没翻）
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
const PORT = 9417;
const PROFILE = process.env.XT_PROFILE || path.join(os.tmpdir(), 'xt-manual-1793554342488');
const SUB = process.argv[2] ?? '';
const WITH_EXT = process.argv[3] === '1';
const REPO = 'sol3-dev/x-yt-translator';
const URL_ = `https://github.com/${REPO}/settings${SUB ? '/' + SUB : ''}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const proc = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    ...(WITH_EXT ? ['--enable-unsafe-extension-debugging'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,1000',
    'about:blank'
  ],
  { stdio: 'ignore' }
);
const HARD = setTimeout(() => process.exit(1), 180000);
HARD.unref?.();

let browser;
try {
  await waitPort();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  let extId = null;
  if (WITH_EXT) {
    const cdp = await browser.newBrowserCDPSession();
    ({ id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT }));
    await sleep(1200);
  }
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(WITH_EXT ? 6000 : 3000);
  // 逐屏滚下去：设置页下半截是懒渲染，不滚根本不在 DOM 里，之前统计会严重少算
  for (const y of [700, 1400, 2100, 2800, 3500, 4200]) {
    await page.evaluate((v) => window.scrollTo(0, v), y);
    await sleep(WITH_EXT ? 1200 : 700);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(WITH_EXT ? 6000 : 2000);

  const out = await page.evaluate(() => {
    const isLatin = (s) => {
      const latin = (s.match(/[A-Za-z]/g) || []).length;
      const han = (s.match(/[\u4e00-\u9fff]/g) || []).length;
      return latin >= 2 && han === 0;
    };
    // 只取「叶子块」：没有元素子节点、或子节点全是 inline
    const rows = [];
    const walk = (root, zone) => {
      for (const el of root.querySelectorAll('h1,h2,h3,h4,h5,p,li,label,summary,button,a,span,div,legend,dt,dd')) {
        if (el.children.length > 0) {
          const onlyInline = [...el.children].every((c) =>
            /^(A|B|STRONG|EM|CODE|SPAN|SVG|RELATIVE-TIME|TIME|KBD|IMG|INPUT|LABEL)$/i.test(c.tagName)
          );
          if (!onlyInline) continue;
        }
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length < 3 || t.length > 200) continue;
        if (!isLatin(t)) continue;
        if (el.closest('.xt-translation')) continue;
        rows.push({
          zone,
          tag: el.tagName.toLowerCase(),
          cls: String(el.className || '').slice(0, 46),
          text: t,
          translated: !!el.closest('.xt-translation'),
          origTouched: el.hasAttribute('data-xt-ui'),
          html: el.outerHTML.replace(/\s+/g, ' ').slice(0, 260)
        });
      }
    };
    walk(document.querySelector('main') || document.body, 'main');
    const nav = document.querySelector('nav[aria-label], .Box');
    if (nav) walk(nav, 'aside');

    // 去重
    const seen = new Set();
    return rows
      .filter((r) => (seen.has(r.text) ? false : seen.add(r.text)))
      .slice(0, 400);
  });

  console.log('URL:', page.url());
  console.log('未翻条目:', out.length, WITH_EXT ? '（已加载扩展，这里应接近 0）' : '');
  const byZone = {};
  for (const r of out) (byZone[r.zone] ||= []).push(r);
  for (const [z, list] of Object.entries(byZone)) {
    console.log(`\n===== ${z} (${list.length}) =====`);
    for (const r of list) console.log(`[${r.tag}.${r.cls}] ${r.text}${r.origTouched ? '  (已处理)' : ''}
    ${r.html || ''}`);
  }

  const shot = path.join(os.tmpdir(), 'xt-settings.png');
  await page.screenshot({ path: shot, fullPage: true });
  console.log('\n截图:', shot);
} catch (e) {
  console.error('[错误]', e.message);
} finally {
  await browser?.close().catch(() => {});
  proc.kill();
  setTimeout(() => process.exit(0), 400);
}

/**
 * 仓库首页端到端验证（本地 mock 引擎，不花真 Key）
 * -------------------------------------------------------------------------
 * 做法：起一个 OpenAI 兼容的假服务，把译文固定为「〔中〕+原文」，
 * 这样能确定「没翻」是扩展没去翻，而不是引擎/网络的问题。
 *
 * 用法：node test/repo-e2e.mjs [url]
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.XT_PW || 'playwright-core');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9407;
const PROFILE = path.join(os.tmpdir(), 'xt-e2e-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TARGET = process.argv[2] || 'https://github.com/AetherKiri/Aether';

// ---------- mock 引擎 ----------
let calls = 0;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls++;
    let items = [];
    try {
      const j = JSON.parse(body);
      items = JSON.parse(j.messages[1].content);
    } catch {}
    const ZH = '跨平台、多运行时视觉小说模拟器，以 Godot 4 作为渲染层，支持多引擎与存档回放';
    const r = (items || []).map((it) => ({
      i: it.i,
      t: String(it.t).length > 40 ? ZH : '中文短译',
      l: 'en'
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ r }) }, finish_reason: 'stop' }] }));
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = mock.address().port;

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
const proc = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1600,1100',
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
  await sleep(1500);
  const ctx = browser.contexts()[0];

  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: 'domcontentloaded' });
  await sleep(400);
  await opt.evaluate(async (base) => {
    const cur = (await chrome.storage.local.get('settings')).settings || {};
    const next = {
      ...cur,
      enabled: true,
      engine: 'openai',
      targetLang: 'zh-CN',
      displayMode: 'bilingual',
      openai: { baseUrl: base, apiKey: 'test-key', model: 'mock' },
      github: { enabled: true, menu: true, readme: true, issues: true }
    };
    await chrome.storage.local.set({ settings: next });
    await chrome.runtime.sendMessage({ type: 'XT_CLEAR_CACHE' });
  }, `http://127.0.0.1:${MOCK_PORT}/v1`);
  await opt.close();

  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1600, height: 1000 });
  page.on('console', (m) => {
    const t = m.text();
    if (/\[XT\]/.test(t)) console.log('  console:', t.slice(0, 200));
  });
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.react-directory-commit-message, [class*="description__"]', { timeout: 40000 }).catch(() => {});
  await sleep(12000);

  const out = await page.evaluate(() => {
    const txt = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
    const desc = [...document.querySelectorAll('[class*="description__"]')].map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const bx = el.querySelector('.xt-translation');
      const br = bx?.getBoundingClientRect();
      return {
        visible: r.width > 0,
        hasBox: !!bx,
        box: bx?.textContent.slice(0, 60) || null,
        boxCount: el.querySelectorAll('.xt-translation').length,
        html: el.outerHTML.replace(/\s+/g, ' ').slice(0, 700),
        text: txt(el).slice(0, 50),
        style: {
          h: Math.round(cs.height),
          overflow: cs.overflow,
          clamp: cs.webkitLineClamp,
          display: cs.display,
          maxH: cs.maxHeight
        },
        rect: { w: Math.round(r.width), h: Math.round(r.height) },
        boxRect: br ? { w: Math.round(br.width), h: Math.round(br.height), t: Math.round(br.top) } : null,
        boxVisible: !!br && br.width > 0 && br.height > 0
      };
    });
    const commits = [...document.querySelectorAll('.react-directory-commit-message, [class*="ListItemTitle"] > h4')].slice(0, 6).map((el) => ({
      text: txt(el).slice(0, 70),
      title: el.querySelector('a')?.getAttribute('title')?.slice(0, 70) || null,
      hasBox: !!el.querySelector('.xt-translation'),
      nextIsBox: el.nextElementSibling?.classList?.contains('xt-gh-commit') || false,
      nextTxt: el.nextElementSibling?.textContent?.slice(0, 50) || null
    }));
    const boxes = [...document.querySelectorAll('.xt-translation')].map((b) => ({
      cls: b.className.replace('xt-translation ', ''),
      text: txt(b).slice(0, 50),
      host: b.parentElement?.tagName.toLowerCase() + '.' + (typeof b.parentElement?.className === 'string' ? b.parentElement.className.slice(0, 40) : '')
    }));
    return {
      desc,
      commits,
      commitMsgCount: document.querySelectorAll('.react-directory-commit-message, [class*="ListItemTitle"] > h4').length,
      commitBoxCount: document.querySelectorAll('.xt-gh-commit').length,
      boxCount: boxes.length,
      boxes: boxes.slice(0, 30)
    };
  });

  const shot = path.join(os.tmpdir(), 'xt-repo-e2e.png');
  await page.screenshot({ path: shot, fullPage: false });
  console.log('截图:', shot);
  console.log('mock 请求次数:', calls);
  console.log('译文盒子   :', out.boxCount);
  console.log('\n=== About 描述 ===');
  console.log(JSON.stringify(out.desc, null, 1));
  console.log('\n=== 文件列表提交信息 ===');
  console.log(JSON.stringify(out.commits, null, 1));
  console.log('\n=== 译文盒子明细 ===');
  for (const b of out.boxes) console.log(` [${b.cls}] ${b.host} :: ${b.text}`);
} catch (e) {
  console.error('[错误]', e.message);
} finally {
  await browser?.close().catch(() => {});
  proc.kill();
  mock.close();
  setTimeout(() => process.exit(0), 500);
}

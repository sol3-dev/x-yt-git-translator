/**
 * GitHub 零散文案回归（登录后才能看到的菜单/通知页文案）
 * -------------------------------------------------------------------------
 * 这些页面（通知、+ 新建菜单、Copilot 菜单）未登录看不到，无法在线验证，
 * 所以把文案放进一个最小页面，注入适配层，直接断言翻没翻。
 * 用法：XT_PW=<pw> node test/github-labels.mjs
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
const PORT = 9397;
const WEB_PORT = 8795;
const PROFILE = path.join(os.tmpdir(), 'xt-ghlab-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USER_STORE =
  path.join(
    process.env.LOCALAPPDATA || '',
    'Google/Chrome/User Data/Default/Local Extension Settings/bfkgpoocjcajokhldlhobeieeflcehpo'
  );

// 期望：原文 → 期望译文
const CASES = [
  ['New repository', '新建仓库'],
  ['New codespace', '新建 Codespace'],
  ['New gist', '新建 Gist'],
  ['New organization', '新建组织'],
  ['New project', '新建项目'],
  ['Ask Copilot…', '向 Copilot 提问…'],
  ['In immersive chat', '在沉浸式对话中'],
  ['In a space', '在空间中'],
  ['Dismiss', '忽略'],
  ['Get started', '立即开始'],
  ['Group by: Date', '分组：日期'],
  ['Newest to oldest', '最新到最旧'],
  ['Team mentioned', '团队被提及'],
  ['Review requested', '请求审查'],
  ['Add new filter', '添加筛选器'],
  ['Manage notifications', '管理通知'],
  ['1-1 of 1', '第 1-1 条，共 1 条'],
  ['When viewing a notification, press', '查看通知时，按'],
  ['to mark it as Done.', '即可标记为已完成。'],
  ["aetherkiri doesn't have any public repositories yet.", 'aetherkiri 暂无公开仓库。'],
  ['Clear out the clutter.', '清理收件箱里的杂讯。'],
  ['Status: Unconfirmed', '状态：未确认'],
  ['Type: Bug', '类型：缺陷'],
  ['Oct 26, 2026', '2026年10月26日'],
  ['opened on Oct 31, 2026', '创建于 2026年10月31日'],
  // 设置页 / 生成 Token 页
  ['Personal access tokens', '个人访问令牌'],
  ['Tokens (classic)', '令牌（经典）'],
  ['Generate new token', '生成新令牌'],
  ['Generate new token (classic)', '生成新令牌（经典）'],
  ['Fine-grained tokens', '细粒度令牌'],
  ['Developer settings', '开发者设置'],
  ['Note', '备注'],
  ['Expiration', '有效期'],
  ['Select scopes', '选择权限范围'],
  ['Revoke all', '全部撤销'],
  ['Danger zone', '危险操作区'],
  ['Save changes', '保存更改']
];

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
    '--window-size=1000,800',
    'about:blank'
  ],
  { stdio: 'ignore' }
);
const HARD = setTimeout(() => process.exit(1), 200000);
HARD.unref?.();

let browser;
try {
  await waitPort();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const cdp = await browser.newBrowserCDPSession();
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT });
  await sleep(1200);
  const ctx = browser.contexts()[0];

  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: 'domcontentloaded' });
  await sleep(400);

  // 必须走 http://127.0.0.1（setContent 的页面没有 host 权限，注入会被拒）
  const html = `<html><body><nav aria-label="x"></nav><main>${
    CASES.map(
      ([src], i) => `<div id="c${i}"><span>${src.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span></div>`
    ).join('')
  }<input id="ph1" placeholder="Search notifications" /></main></body></html>`;
  await fs.writeFile(path.join(__dirname, 'labels.html'), html, 'utf8');

  const server = http.createServer(async (req, res) => {
    try {
      const buf = await fs.readFile(path.join(__dirname, decodeURIComponent(req.url.split('?')[0])));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(buf);
    } catch {
      res.writeHead(404);
      res.end('nf');
    }
  });
  await new Promise((r) => server.listen(WEB_PORT, '127.0.0.1', r));

  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${WEB_PORT}/labels.html`, { waitUntil: 'domcontentloaded' });
  await sleep(500);

  await opt.evaluate(async (extIdStr) => {
    const tabs = await chrome.tabs.query({ url: 'about:blank' });
    void extIdStr;
    void tabs;
  }, extId);

  // 注入适配层（隔离世界）
  const target = await opt.evaluate(async (port) => {
    const tabs = await chrome.tabs.query({ url: `http://127.0.0.1:${port}/*` });
    return tabs[0]?.id ?? null;
  }, WEB_PORT);
  const injected = await opt.evaluate(async (tabId) => {
    if (!tabId) return { ok: false, error: '找不到 tab' };
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content/content.css'] });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/shared.js', 'src/content/github.js']
    });
    return { ok: true };
  }, target);
  if (!injected.ok) throw new Error(injected.error);

  await sleep(2500);

  const got = await page.evaluate((n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(document.getElementById('c' + i)?.textContent?.trim() || '');
    return { texts: out, ph: document.getElementById('ph1')?.getAttribute('placeholder') || '' };
  }, CASES.length);

  let pass = 0;
  CASES.forEach(([src, want], i) => {
    const ok = got.texts[i] === want;
    if (ok) pass++;
    else console.log(`  ✗ ${src}\n     得到：${got.texts[i]}\n     期望：${want}`);
  });
  console.log(`\n文案：${pass}/${CASES.length}`);
  console.log(`占位符 Search notifications → ${got.ph} ${got.ph === '搜索通知' ? '✓' : '✗'}`);
  server.close();
} finally {
  clearTimeout(HARD);
  try {
    if (browser) await browser.close();
  } catch {}
  try {
    proc.kill();
  } catch {}
}

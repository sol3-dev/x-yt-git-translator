/**
 * GitHub 适配层端到端验证
 * -------------------------------------------------------------------------
 * 直接开 github.com 需要登录才能看到左侧抽屉和账号菜单，所以这里用一份
 * 按截图 1:1 复刻结构的 mock 页面（test/mock-github.html），
 * 再用 chrome.scripting.executeScript 把共享层 + GitHub 适配层注入进去 ——
 * 隔离世界、和真实注入完全等价，省掉登录和网络的不确定性。
 *
 * 验证点：
 *   [1] 左侧导航全部译成中文，且没有机翻味
 *   [2] 账号菜单全部译成中文
 *   [3] 产品名保留（Codespaces / Copilot）
 *   [4] README 段落有中文译文，且 C++ / Zig / Rust / LLVM / Kubernetes 等术语原样保留
 *   [5] <pre><code> 里的命令一字未改
 *   [6] 译文没有重复插入（重扫幂等）
 *
 * 用法：XT_PW=<pw> node test/github-verify.mjs
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
const PORT = 9387;
const WEB_PORT = 8793;
const PROFILE = path.join(os.tmpdir(), 'xt-ghv-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USER_STORE =
  path.join(
    process.env.LOCALAPPDATA || '',
    'Google/Chrome/User Data/Default/Local Extension Settings/bfkgpoocjcajokhldlhobeieeflcehpo'
  );

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  — ' + extra : ''}`);
}

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

const server = http.createServer(async (req, res) => {
  const p = path.join(__dirname, decodeURIComponent(req.url.split('?')[0]));
  try {
    const buf = await fs.readFile(p);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end('nf');
  }
});
await new Promise((r) => server.listen(WEB_PORT, '127.0.0.1', r));

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
    '--window-size=1300,1000',
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
  console.log('扩展', extId);
  await sleep(1400);

  const ctx = browser.contexts()[0];

  // 关掉缓存里可能的旧结果，保证真的翻一次
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: 'domcontentloaded' });
  await sleep(500);
  await opt.evaluate(() => chrome.runtime.sendMessage({ type: 'XT_CLEAR_CACHE' }));

  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (/\[XT\]/.test(t)) console.log('   [content]', t.slice(0, 160));
  });
  await page.goto(`http://127.0.0.1:${WEB_PORT}/mock-github.html`, { waitUntil: 'domcontentloaded' });
  await sleep(800);

  // 用 scripting 注入（隔离世界，等价于 manifest 自动注入）
  const injected = await opt.evaluate(async (port) => {
    const tabs = await chrome.tabs.query({ url: `http://127.0.0.1:${port}/*` });
    const tab = tabs[0];
    if (!tab) return { ok: false, error: '找不到标签页' };
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['src/content/content.css'] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/content/shared.js', 'src/content/github.js']
    });
    return { ok: true, tabId: tab.id };
  }, WEB_PORT);
  console.log('注入结果：', JSON.stringify(injected));
  if (!injected?.ok) throw new Error('注入失败：' + injected?.error);

  // 等译文出现
  let stat = null;
  for (let i = 0; i < 40; i++) {
    stat = await page.evaluate(() => {
      const txt = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
      const menuTexts = [...document.querySelectorAll('[role="menu"] a')].map((a) => a.textContent.trim());
      const navTexts = [...document.querySelectorAll('nav a, nav p, nav h1, nav h2, nav h3, nav span')]
        .map((a) => a.textContent.trim())
        .filter(Boolean);
      const boxes = [...document.querySelectorAll('.xt-translation')];
      return {
        navTexts,
        menuTexts,
        uiCount: document.querySelectorAll('[data-xt-ui="1"]').length,
        boxes: boxes.length,
        boxTexts: boxes.map((b) => b.textContent.trim()),
        preText: txt('pre code'),
        h1Tr: document.querySelector('h1 > .xt-translation')?.textContent?.trim() || ''
      };
    });
    if (stat.boxes >= 3 && stat.uiCount > 10) break;
    await sleep(1500);
  }

  /* -------------------- ① 左侧导航 -------------------- */
  console.log('\n[1] 左侧导航');
  console.log('  ' + stat.navTexts.join(' | '));
  const navMap = {
    首页: stat.navTexts.includes('首页'),
    动态: stat.navTexts.includes('动态'),
    所有议题: stat.navTexts.includes('所有议题'),
    所有拉取请求: stat.navTexts.includes('所有拉取请求'),
    所有仓库: stat.navTexts.includes('所有仓库'),
    项目: stat.navTexts.includes('项目'),
    讨论: stat.navTexts.includes('讨论'),
    探索: stat.navTexts.includes('探索'),
    市场: stat.navTexts.includes('市场'),
    'MCP 注册表': stat.navTexts.includes('MCP 注册表'),
    热门仓库: stat.navTexts.includes('热门仓库')
  };
  const navBad = Object.entries(navMap).filter(([, v]) => !v).map(([k]) => k);
  check('导航项全部译成中文', navBad.length === 0, navBad.length ? '缺：' + navBad.join('、') : '11 项');
  check('产品名保留英文（Codespaces / Copilot）',
    stat.navTexts.includes('Codespaces') && stat.navTexts.includes('Copilot'),
    stat.navTexts.filter((t) => /Codespaces|Copilot/.test(t)).join(' / '));

  /* -------------------- ② 账号菜单 -------------------- */
  console.log('\n[2] 账号菜单');
  console.log('  ' + stat.menuTexts.join(' | '));
  const menuNeed = ['设置状态', '个人资料', '仓库', '星标', 'Gists', '组织', '企业', '赞助', '设置', 'Copilot 设置', '功能预览', '外观', '无障碍', '试用企业版', '退出登录'];
  const menuBad = menuNeed.filter((t) => !stat.menuTexts.includes(t));
  check('账号菜单全部译成中文', menuBad.length === 0, menuBad.length ? '缺：' + menuBad.join('、') : '15 项');
  check('Gists / Copilot 保留英文', stat.menuTexts.includes('Gists') && stat.menuTexts.includes('Copilot 设置'));

  /* -------------------- ③ README -------------------- */
  console.log('\n[3] README 正文');
  console.log('  ' + stat.boxTexts.map((t) => t.slice(0, 70)).join('\n  '));
  check('生成了中文译文', stat.boxes >= 3, `${stat.boxes} 块`);
  check('标题也有译文', !!stat.h1Tr, stat.h1Tr.slice(0, 50));
  check('代码块一字未改', stat.preText.includes('zig build -Doptimize=ReleaseFast'), stat.preText);

  const all = stat.boxTexts.join(' ');
  const keepTerms = ['Zig', 'C++', 'Rust', 'LLVM', 'Kubernetes', 'Python', 'Go', 'Deno', 'API', 'HTTP'];
  const missing = keepTerms.filter((t) => !all.includes(t));
  check('技术术语保持原样', missing.length === 0, missing.length ? '丢失：' + missing.join('、') : keepTerms.join(' / '));

  const machineSmell = ['锈语言', '库伯内特斯', '提交承诺', '拉请求', '蟒蛇'];
  const smell = machineSmell.filter((w) => all.includes(w));
  check('没有明显机翻痕迹', smell.length === 0, smell.join('、') || '无');

  const dupe = await page.evaluate(() => {
    // 同一个宿主里出现两个译文块 = 重扫不幂等
    let dup = 0;
    for (const el of document.querySelectorAll('.xt-translation')) {
      const host = el.parentElement;
      if (host && host.querySelectorAll(':scope > .xt-translation').length > 1) dup++;
    }
    return dup;
  });
  check('译文没有重复插入', dupe === 0, `${dupe} 处`);

  await page.screenshot({ path: path.join(__dirname, 'shot-github.png'), fullPage: true }).catch(() => {});

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n结果：${pass}/${results.length} 通过`);
  if (pass !== results.length) {
    console.log('未通过：' + results.filter((r) => !r.ok).map((r) => r.name).join(' / '));
  }
} finally {
  clearTimeout(HARD);
  try {
    if (browser) await browser.close();
  } catch {}
  try {
    proc.kill();
  } catch {}
  server.close();
}

/**
 * GitHub 界面「还有哪些英文没被翻译」的覆盖度扫描
 * -------------------------------------------------------------------------
 * 思路：在 nav / header / main / aside 里找「叶子文本」——纯英文、长度 2~60、
 * 不含中文、不在代码块里。这些就是实际看到的漏翻项。
 * 逐个页面跑一遍，按频次输出，用来补词典/规则。
 *
 * 用法：XT_PW=<pw> node test/github-coverage.mjs [url1 url2 ...]
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
const PORT = 9395;
// XT_USE_REAL_PROFILE=1：直接用真实 Chrome 配置（已登录、已装扩展）。
// 这是唯一能拿到 /settings 真实 DOM 的方式 —— 复制 cookie 会被 App-Bound
// Encryption 拒绝，实测两次都返回登录页。
const USE_REAL = process.env.XT_USE_REAL_PROFILE === '1';
const REAL_PROFILE = path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data');
const PROFILE = USE_REAL ? REAL_PROFILE : path.join(os.tmpdir(), 'xt-ghc-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USER_STORE =
  path.join(
    process.env.LOCALAPPDATA || '',
    'Google/Chrome/User Data/Default/Local Extension Settings/bfkgpoocjcajokhldlhobeieeflcehpo'
  );

const URLS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'https://github.com/AetherKiri',
      'https://github.com/AetherKiri/Aether',
      'https://github.com/AetherKiri/Aether/discussions'
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

if (!USE_REAL) await fs.mkdir(PROFILE, { recursive: true });
const dst = path.join(PROFILE, 'Default', 'Local Extension Settings', 'bfkgpoocjcajokhldlhobeieeflcehpo');
if (!USE_REAL) {
await fs.mkdir(dst, { recursive: true });
// leveldb 缺 CURRENT/MANIFEST 会当空库重建，必须整目录拷（只拷 .ldb/.log 会读成空）
for (const f of await fs.readdir(USER_STORE)) {
  if (f === 'LOCK' || f === 'LOG' || f === 'LOG.old') continue;
  await fs.copyFile(path.join(USER_STORE, f), path.join(dst, f)).catch(() => {});
}

/* ------------------------------------------------------------------------ *
 * 登录态复用（XT_LOGIN=1）
 *
 * /settings 系列页面必须登录才看得到真实 DOM。Chrome 127+ 的 App-Bound
 * Encryption 会拒解跨 profile 的 cookie，但**Chrome 关闭时**复制是可行的：
 * 那时 SQLite 没有 WAL 未落盘数据，key 也在 Local State 里原样躺着。
 * 所以这里要求 Chrome 必须先退出，否则扫出来全是登录页。
 * ------------------------------------------------------------------------ */
if (process.env.XT_LOGIN === '1') {
  const USER_DATA = path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data');

  // Chrome 还开着就直接退出：让它自己锁着 cookie 库，扫也是白扫
  const { execSync } = await import('node:child_process');
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf8' });
    if (/chrome\.exe/i.test(out)) {
      console.error('\n✗ Chrome 仍在运行。请先完全退出 Chrome（所有窗口），再重跑本脚本。');
      console.error('  Windows 上托盘图标也要退出：右下角 Chrome 图标 → 退出。\n');
      process.exit(2);
    }
  } catch {}

  await fs.mkdir(path.join(PROFILE, 'Default', 'Network'), { recursive: true });
  await fs.copyFile(path.join(USER_DATA, 'Local State'), path.join(PROFILE, 'Local State')).catch((e) => {
    console.error('复制 Local State 失败：', e.message);
  });
  // ★ Preferences / Secure Preferences 必须一起拷。
  // 只拷 Local State + Cookies 时，Chrome 判定这是个全新 profile，
  // 会重新生成 os_crypt 密钥并把外来 cookie 当垃圾丢掉 —— 前面两次失败就是这个。
  for (const f of ['Preferences', 'Secure Preferences']) {
    await fs
      .copyFile(path.join(USER_DATA, 'Default', f), path.join(PROFILE, 'Default', f))
      .catch((e) => console.error(`复制 ${f} 失败：`, e.message));
  }
  const netSrc = path.join(USER_DATA, 'Default/Network');
  let nCookie = 0;
  for (const f of await fs.readdir(netSrc).catch(() => [])) {
    if (!/^Cookies/.test(f)) continue;
    await fs.copyFile(path.join(netSrc, f), path.join(PROFILE, 'Default/Network', f)).catch(() => {});
    nCookie++;
  }
  console.log(`已复制登录态文件：Local State + ${nCookie} 个 Cookies 相关文件`);
}
}

const proc = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,1050',
    'about:blank'
  ],
  { stdio: 'ignore' }
);
const HARD = setTimeout(() => process.exit(1), 1500000);
HARD.unref?.();

let browser;
try {
  await waitPort();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const cdp = await browser.newBrowserCDPSession();
  if (USE_REAL) {
    // 真实 profile 里已经装过这份扩展，再 loadUnpacked 会出现两个实例同时注入，
    // 译文互相打架，所以这里沿用已装的那份。
    console.log('使用真实 profile：沿用已安装的扩展，不重复加载');
  } else {
    const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT });
    await sleep(1400);
  }
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();

  const all = new Map(); // text -> count

  for (const url of URLS) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(7000);

    // 第一次落地就核对登录态：跳 /login 说明 cookie 没带进来，后面的结果都不可信
    if (process.env.XT_LOGIN === '1' && url === URLS[0]) {
      const who = await page.evaluate(() => ({
        url: location.href,
        user: document.querySelector('meta[name="user-login"]')?.content || ''
      }));
      console.log(`登录态检查：user=${who.user || '(未取到)'} | ${who.url}`);
      if (/\/login/.test(who.url)) {
        console.error('✗ 仍是登录页，cookie 未生效，本次扫描结果不可用。');
        process.exit(3);
      }
    }

    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 700);
      await sleep(600);
    }
    await sleep(2500);

    const found = await page.evaluate(() => {
      // 不含 header：未登录时的顶栏是营销巨菜单（Products/Developers/...），
      // 那些折叠面板在真实登录页里根本不存在，算进漏翻只会误导。
      // 不含 footer：未登录时页脚是「全站链接」营销巨菜单（Changelog/Training/…），
      // 登录后是精简版，且这些内容不在阅读路径上，算了只会淹没真问题。
      const scopes = document.querySelectorAll('main, nav, aside, [role="dialog"], [role="menu"]');
      const skip = 'pre, code, script, style, textarea, svg, kbd, samp, .xt-translation, [data-xt-ui="1"]';
      const out = [];
      const hits = new Map();
      for (const sc of scopes) {
        // 顶栏里的 nav / menu 是未登录的营销巨菜单，跳过
        if (sc.closest('header')) continue;
        for (const el of sc.querySelectorAll('*')) {
          if (el.children.length) continue;
          if (el.closest(skip)) continue;
          // 只统计「真能看见」的：折叠菜单里的内容不算漏翻
          if (!el.getClientRects().length) continue;
          if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue;
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!t || t.length < 2 || t.length > 60) continue;
          if (/[\u4e00-\u9fff]/.test(t)) continue;          // 已是中文
          if (!/[A-Za-z]/.test(t)) continue;                // 纯数字/符号
          if (/^[\w.-]+\/[\w.-]+$/.test(t)) continue;       // owner/repo
          if (/^[a-z0-9-]+$/.test(t)) continue;             // 单个 slug（分支名/语言名）
          if (/^[\w.-]+\.\w{1,4}$/.test(t)) continue;       // 文件名
          hits.set(t, (hits.get(t) || 0) + 1);
        }
      }
      for (const [k, v] of hits) out.push({ text: k, count: v });
      return out;
    });

    console.log(`\n===== ${url}`);
    if (!found.length) console.log('  （干净）');
    for (const f of found) {
      console.log(`  ${f.count}x  ${f.text}`);
      all.set(f.text, (all.get(f.text) || 0) + f.count);
    }
  }

  console.log('\n===== 汇总（按出现次数）');
  const list = [...all.entries()].sort((a, b) => b[1] - a[1]);
  for (const [t, c] of list) console.log(`  ${String(c).padStart(2)}  ${t}`);
  console.log(`\n合计 ${list.length} 种未翻译文本`);
} finally {
  clearTimeout(HARD);
  try {
    if (USE_REAL) await cdp.send('Browser.close').catch(() => {});
    if (browser) await browser.close();
  } catch {}
  try {
    if (!USE_REAL) proc.kill();
  } catch {}
}

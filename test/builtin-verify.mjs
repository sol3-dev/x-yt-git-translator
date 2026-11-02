/**
 * 内置翻译端到端验证（从零开始下载模型 → 只用 builtin 翻译 mock 时间线）
 * -------------------------------------------------------------------------
 * 这是「出口 IP 被 Google 风控」场景下的兜底方案验证：
 * 本地模型不联网、不限量，所以 IP 再脏也能翻。
 *
 * 用法：XT_PW=<playwright-core 路径> node test/builtin-verify.mjs
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
const PORT = 9343;
const PROFILE = path.join(os.tmpdir(), 'xt-builtin-' + Date.now());

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++;
  else fail++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

const HARD = setTimeout(() => {
  log('\n[超时] 10 分钟未结束，强制退出');
  process.exit(1);
}, 900000);
HARD.unref?.();

async function waitPort(timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error('端口未就绪');
}

async function main() {
  await fs.mkdir(PROFILE, { recursive: true });
  spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  const ver = await waitPort();
  log('Chrome', ver.Browser);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const cdp = await browser.newBrowserCDPSession();
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT });
  log('扩展 ID:', extId);
  await sleep(1500);

  const context = browser.contexts()[0];

  /* ---------------- 1. 下载模型（真实点击） ---------------- */
  const opt = await context.newPage();
  await opt.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: 'domcontentloaded' });
  await sleep(600);

  log('\n[1] 点击「下载全部本地模型」…');
  // 按钮现在单次最多下 8 个（同一页面连续 create 到第 9 个会静默挂起），
  // 所以要循环点击，直到出现「完成：」表示全部候选都处理过一遍。
  const t0 = Date.now();
  let last = '';
  let finished = false;
  let round = 0;
  const MAX_ROUNDS = 8;

  while (round < MAX_ROUNDS && Date.now() - t0 < 600000) {
    round++;
    await opt.click('#downloadModel');
    log(`    —— 第 ${round} 轮点击 ——`);
    const r0 = Date.now();
    while (Date.now() - r0 < 180000) {
      const st = await opt.$eval('#modelStatus', (el) => el.textContent || '').catch(() => '');
      if (st !== last) {
        const tail = st.trim().split('\n').slice(-2).join(' | ');
        log(`    [${String(Math.round((Date.now() - r0) / 1000)).padStart(3)}s] ${tail.slice(0, 110)}`);
        last = st;
      }
      // 「完成：」= 全部候选处理完；「本次已下载 N 个」= 本轮到量，继续下一轮
      if (/完成：/.test(st)) {
        finished = true;
        break;
      }
      if (/本次已下载|连续 2 个超时/.test(st)) break;
      await sleep(1200);
    }
    if (finished) break;
    await sleep(800); // 给按钮解除 disabled 的时间
  }

  check('模型下载流程跑完', finished, finished ? `${Math.round((Date.now() - t0) / 1000)}s / ${round} 轮` : `超时（${round} 轮）`);
  log('    最终状态：\n' + last.split('\n').slice(0, 8).map((l) => '      ' + l).join('\n'));

  const ready = await opt.evaluate(async () => {
    try {
      return await self.Translator.availability({ sourceLanguage: 'en', targetLanguage: 'zh' });
    } catch (e) {
      return '抛错:' + e.message;
    }
  });
  check('en→zh 模型已就绪', ready === 'available', `state=${ready}`);

  /* ---------------- 2. 切到 builtin 引擎 ---------------- */
  await opt.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'XT_SET_SETTINGS', patch: { engine: 'builtin' } });
    await chrome.runtime.sendMessage({ type: 'XT_HEALTH_RESET' });
  });
  log('\n[2] 引擎已切到 builtin，冷却已清空');

  /* ---------------- 3. mock 时间线 ---------------- */
  const mockHtml = await fs.readFile(path.join(__dirname, 'mock-x.html'), 'utf8');
  await context.route('https://x.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: mockHtml
    });
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (/\[XT\]/.test(m.text())) log('    [console]', m.text().slice(0, 140));
  });

  log('\n[3] 打开 mock X 时间线…');
  await page.goto('https://x.com/mock', { waitUntil: 'domcontentloaded' });
  await sleep(1500);

  const t1 = Date.now();
  let boxes = 0;
  while (Date.now() - t1 < 60000) {
    boxes = await page.evaluate(() => document.querySelectorAll(".xt-translation").length);
    if (boxes >= 8) break;
    await sleep(1000);
  }
  const elapsed = Math.round((Date.now() - t1) / 1000);
  check('出现译文', boxes > 0, `${boxes} 条 / ${elapsed}s`);

  const sample = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.xt-translation')].slice(0, 3);
    return els.map((e) => {
      const t = e.textContent || '';
      return /[\u4e00-\u9fff]/.test(t) ? t.slice(0, 46) : '(非中文) ' + t.slice(0, 40);
    });
  });
  log('    抽样：');
  sample.forEach((s) => log('      ' + s));
  check('译文是中文', sample.length > 0 && sample.every((s) => /[\u4e00-\u9fff]/.test(s)));

  const zhOnly = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.xt-translation')];
    const zh = all.filter((e) => /[\u4e00-\u9fff]/.test(e.textContent || '')).length;
    return { total: all.length, zh };
  });
  log(`    合计：${zhOnly.total} 条译文，其中中文 ${zhOnly.zh} 条`);
  check('至少 8 条中文译文', zhOnly.zh >= 8, `${zhOnly.zh} 条`);

  check('页面无 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  /* ---------------- 4. 滚动增量 ---------------- */
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(4000);
  const after = await page.evaluate(() => document.querySelectorAll('.xt-translation').length);
  check('滚动后继续增量翻译', after > zhOnly.total, `${zhOnly.total} → ${after}`);

  log(`\n结果：${pass} 通过 / ${fail} 失败`);
  log('临时 profile:', PROFILE);
  await browser.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('脚本失败：', e);
  process.exit(1);
});

// 通用站点（自定义域名）验证脚本
// 验证「添加此网页」+ generic.js 的四重过滤 + 语言标签的复制安全性
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
const CHROME = process.env.XT_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.XT_PORT || 9334);
const PROFILE = path.join(os.tmpdir(), 'xt-gen-' + Date.now());
const SHOTS = path.join(__dirname, 'shots');
const SITE = 'https://demo-blog.test/post/1';

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

async function waitPort(timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

function killTree(pid) {
  try {
    spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  } catch {}
}

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  await fs.mkdir(PROFILE, { recursive: true });

  const proc = spawn(
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

  let browser;
  try {
    const ver = await waitPort();
    log(`Chrome ${ver.Browser}`);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const cdp = await browser.newBrowserCDPSession();
    const loaded = await cdp.send('Extensions.loadUnpacked', { path: EXT });
    const extId = loaded.id;
    check('扩展加载成功', !!extId, `id=${extId}`);
    await sleep(1500);

    const context = browser.contexts()[0];
    context.setDefaultTimeout(30000);

    const html = await fs.readFile(path.join(__dirname, 'mock-generic.html'), 'utf8');
    await context.route('https://demo-blog.test/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    });

    // 用扩展页作为后台消息通道
    const bgPage = await context.newPage();
    await bgPage.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: 'domcontentloaded' });

    // 确保初始状态干净：没有自定义站点
    await bgPage.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'XT_SET_SETTINGS', patch: { customSites: [], enabled: true } })
    );
    await sleep(400);

    /* ---------------- 1. 未添加域名：不应翻译 ---------------- */
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(SITE, { waitUntil: 'domcontentloaded' });
    await sleep(3500);

    const before = await page.evaluate(() => document.querySelectorAll('.xt-translation').length);
    check('未添加域名时不翻译（不乱翻）', before === 0, `译文节点 ${before} 个`);

    /* ---------------- 2. 添加域名后自动开始翻译 ---------------- */
    await bgPage.evaluate(() =>
      chrome.runtime.sendMessage({
        type: 'XT_SET_SETTINGS',
        patch: { customSites: ['demo-blog.test'] }
      })
    );

    // 不刷新页面，靠 storage.onChanged → onSettings → ensureStarted
    await page
      .waitForFunction(() => document.querySelectorAll('.xt-translation').length >= 2, null, { timeout: 40000 })
      .catch(() => {});
    await sleep(2500);

    const stats = await page.evaluate(() => {
      const box = [...document.querySelectorAll('.xt-translation')];
      const cn = /[\u4e00-\u9fff]/;
      return {
        total: box.length,
        chinese: box.filter((b) => cn.test(b.textContent)).length,
        inArticle: document.querySelectorAll('article .xt-translation').length,
        inNav: document.querySelectorAll('nav .xt-translation').length,
        inHeader: document.querySelectorAll('header .xt-translation').length,
        inFooter: document.querySelectorAll('footer .xt-translation').length,
        inAside: document.querySelectorAll('aside .xt-translation').length,
        shortP: (() => {
          const p = document.querySelector('p.short');
          return p ? p.querySelectorAll('.xt-translation').length : -1;
        })(),
        buttonP: (() => {
          const b = document.querySelector('#subscribe');
          return b ? b.querySelectorAll('.xt-translation').length : -1;
        })()
      };
    });

    check('添加域名后正文被翻译（无需刷新）', stats.inArticle >= 2, `${stats.inArticle} 段`);
    check('译文内容为中文', stats.chinese >= 2, `${stats.chinese}/${stats.total} 个含中文`);
    check('导航栏未被翻译', stats.inNav === 0, `nav 内 ${stats.inNav} 个`);
    check('页头未被翻译', stats.inHeader === 0, `header 内 ${stats.inHeader} 个`);
    check('页脚未被翻译', stats.inFooter === 0, `footer 内 ${stats.inFooter} 个`);
    check('侧边栏未被翻译', stats.inAside === 0, `aside 内 ${stats.inAside} 个`);
    check('过短段落被跳过', stats.shortP === 0, `p.short 内 ${stats.shortP} 个`);
    check('按钮文本未被翻译', stats.buttonP === 0, `button 内 ${stats.buttonP} 个`);

    /* ---------------- 3. 语言标签 ---------------- */
    const langInfo = await page.evaluate(() => {
      const el = document.querySelector('article .xt-translation');
      if (!el) return null;
      return {
        attr: el.getAttribute('data-xt-lang'),
        textHasLabel: /译自/.test(el.textContent),
        afterContent: getComputedStyle(el, '::after').content,
        afterOpacity: getComputedStyle(el, '::after').opacity,
        afterUserSelect: getComputedStyle(el, '::after').userSelect
      };
    });
    check('译文带源语言标签', !!langInfo?.attr, langInfo?.attr || '无');
    check('标签不在正文文本里（复制安全）', langInfo?.textHasLabel === false, `textContent 含"译自"=${langInfo?.textHasLabel}`);
    check('标签默认不显示（悬停才出）', langInfo?.afterOpacity === '0', `opacity=${langInfo?.afterOpacity}`);

    // 悬停后应变可见
    await page.hover('article .xt-translation').catch(() => {});
    await sleep(400);
    const hoverOpacity = await page.evaluate(() => {
      const el = document.querySelector('article .xt-translation');
      return el ? getComputedStyle(el, '::after').opacity : null;
    });
    check('悬停后标签淡入', hoverOpacity === '1', `opacity=${hoverOpacity}`);

    /* ---------------- 4. 复制出来的文本是干净的 ---------------- */
    const copied = await page.evaluate(() => {
      const el = document.querySelector('article .xt-translation');
      if (!el) return '';
      const r = document.createRange();
      r.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      const t = String(sel);
      sel.removeAllRanges();
      return t;
    });
    check('选中复制不带语言标签', copied.length > 0 && !/译自/.test(copied), (copied || '').slice(0, 36));

    /* ---------------- 5. 移除域名后停止 ---------------- */
    await bgPage.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'XT_SET_SETTINGS', patch: { customSites: [] } })
    );
    await sleep(600);

    await page.screenshot({ path: path.join(SHOTS, '20-generic.png'), fullPage: false });
    check('页面运行无报错', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

    await page.close();
    await bgPage.close();
  } catch (e) {
    check('测试流程完成', false, String(e?.message || e));
  } finally {
    try {
      await browser?.close();
    } catch {}
    killTree(proc.pid);
  }

  const pass = results.filter((r) => r.ok).length;
  log('\n========== 汇总 ==========');
  log(`${pass}/${results.length} 通过`);
  for (const r of results) if (!r.ok) log(`  ✗ ${r.name} :: ${r.detail}`);
  process.exit(pass === results.length ? 0 : 1);
}

main();

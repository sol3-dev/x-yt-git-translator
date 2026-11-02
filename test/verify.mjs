// 自动化验证脚本（Chrome 155 适配版）
// Chrome 137+ 已禁用 --load-extension，必须用 CDP 的 Extensions.loadUnpacked。
// 流程：独立 Chrome 实例（调试端口） -> CDP 加载扩展 -> route 拦截 x.com 返回本地 mock 时间线 -> 断言
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
const PORT = Number(process.env.XT_PORT || 9333);
const PROFILE = path.join(os.tmpdir(), 'xt-run-' + Date.now());
const SHOTS = path.join(__dirname, 'shots');

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
  let extId = null;
  let ver = {};
  try {
    ver = await waitPort();
    log(`Chrome ${ver.Browser}`);

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const cdp = await browser.newBrowserCDPSession();
    const loaded = await cdp.send('Extensions.loadUnpacked', { path: EXT });
    extId = loaded.id;
    check('扩展成功加载到 Chrome', !!extId, `id=${extId}`);
    await sleep(1800);

    const context = browser.contexts()[0];
    context.setDefaultTimeout(30000);

    /* ------------------ 1. 扩展页面与后台可用性 ------------------ */
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: 'domcontentloaded' });
    const popupUi = await popupPage.evaluate(() => !!document.querySelector('#engine') && !!document.querySelector('#enabled'));
    check('popup 页面正常渲染', popupUi);

    const engineTest = await popupPage.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'XT_TEST_ENGINE', engine: 'auto', text: 'Hello world, this is a translation test.' })
    );
    check(
      '翻译引擎自检通过',
      !!engineTest?.ok,
      engineTest?.ok ? `"${engineTest.output}" ${engineTest.ms}ms` : String(engineTest?.error)
    );
    await popupPage.screenshot({ path: path.join(SHOTS, '03-popup.png') });

    const optPage = await context.newPage();
    await optPage.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: 'domcontentloaded' });
    const optUi = await optPage.evaluate(() => !!document.querySelector('#engine') && !!document.querySelector('#testEngine'));
    check('options 页面正常渲染', optUi);
    await optPage.screenshot({ path: path.join(SHOTS, '04-options.png'), fullPage: true });
    await optPage.close();
    // popupPage 保留：后面要借它的扩展上下文给后台发消息（页面主世界没有 chrome.runtime）

    /* ------------------ 2. X mock 时间线 ------------------ */
    const mockHtml = await fs.readFile(path.join(__dirname, 'mock-x.html'), 'utf8');
    await context.route('https://x.com/**', async (route) => {
      if (route.request().url().includes('/mock')) {
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: mockHtml });
      } else {
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<html><body>fallback</body></html>' });
      }
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(m.text());
    });

    await page.goto('https://x.com/mock', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#feed article', { timeout: 15000 });

    await page
      .waitForFunction(() => document.querySelectorAll('#feed .xt-translation').length >= 3, null, { timeout: 40000 })
      .catch(() => {});

    let st = await page.evaluate(() => window.__mock.stats());
    check('首屏推文被自动翻译（≥3 条）', st.translations >= 3, `${st.translations}/${st.tweets} 条`);

    const sample = await page.$$eval('#feed article', (arts) =>
      arts.slice(0, 3).map((a) => ({
        src: (a.querySelector('[data-testid="tweetText"]')?.textContent || '').trim().slice(0, 45),
        tr: (a.querySelector('.xt-translation')?.textContent || '').trim().slice(0, 40)
      }))
    );
    for (const s of sample) log(`   原文: ${s.src}\n   译文: ${s.tr}`);
    const zhCount = sample.filter((s) => /[\u4e00-\u9fff]/.test(s.tr)).length;
    check('译文为中文且非空', zhCount >= 2, `${zhCount}/3 条含中文`);

    await page.screenshot({ path: path.join(SHOTS, '01-initial.png') });

    /* ------------------ 3. 无限滚动增量翻译 ------------------ */
    const before = st.translations;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1200);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page
      .waitForFunction((n) => document.querySelectorAll('#feed .xt-translation').length > n + 2, before, { timeout: 40000 })
      .catch(() => {});

    st = await page.evaluate(() => window.__mock.stats());
    check('滚动新加载的推文被自动翻译', st.translations > before + 2, `${before} → ${st.translations}（共 ${st.tweets} 条）`);

    /* ------------------ 4. 节点复用（虚拟滚动） ------------------ */
    await page.evaluate(() => window.__mock.reuse());
    await sleep(5000);

    const afterReuse = await page.$$eval('#feed article', (arts) =>
      arts.map((a) => ({
        src: (a.querySelector('[data-testid="tweetText"]')?.textContent || '').trim(),
        tr: (a.querySelector('.xt-translation')?.textContent || '').trim()
      }))
    );
    const reused = afterReuse.find((a) => a.src.includes('[reuse #'));
    check('复用节点检测到新内容', !!reused, reused ? `src="${reused.src.slice(0, 50)}"` : '未找到');
    check(
      '复用节点的译文已更新为新内容',
      !!reused && /[\u4e00-\u9fff]/.test(reused.tr) && reused.tr.length > 2,
      reused ? `tr="${reused.tr.slice(0, 40)}"` : ''
    );

    const dup = await page.$$eval('#feed [data-testid="tweetText"]', (els) =>
      els.filter((el) => el.querySelectorAll(':scope > .xt-translation').length > 1).length
    );
    check('同一正文未堆叠重复译文', dup === 0, `重复=${dup}`);

    /* ------------------ 5. 中文内容跳过 ------------------ */
    await page.evaluate(() => {
      const art = document.createElement('article');
      art.setAttribute('data-testid', 'tweet');
      art.innerHTML =
        '<div data-testid="tweetText" lang="zh" dir="auto"><span>这是一条中文推文，不应该被再次翻译，因为目标语言就是中文。</span></div>';
      art.id = 'zh-test';
      document.getElementById('feed').appendChild(art);
    });
    await sleep(1800);
    const zhBoxed = await page.evaluate(() => !!document.querySelector('#zh-test .xt-translation'));
    check('中文推文被跳过（不重复翻译）', !zhBoxed, zhBoxed ? '错误地插入了译文' : '已跳过');

    await page.screenshot({ path: path.join(SHOTS, '02-after-scroll.png') });

    /* ------------------ 6. 显示模式热切换 ------------------ */
    await popupPage.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: 'XT_SET_SETTINGS', patch: { displayMode: 'inline' } });
    });
    await sleep(2500);
    const modeApplied = await page.evaluate(() => {
      const el = document.querySelector('#feed .xt-translation');
      return el?.parentElement?.getAttribute('data-xt-mode') || 'none';
    });
    check('切换显示模式后热生效', modeApplied === 'inline', `data-xt-mode=${modeApplied}`);
    await popupPage.evaluate(() => chrome.runtime.sendMessage({ type: 'XT_SET_SETTINGS', patch: { displayMode: 'bilingual' } }));

    /* ------------------ 7. 无异常 ------------------ */
    const realErrors = pageErrors.filter((e) => !/favicon|net::ERR|Failed to load resource/i.test(e));
    check('页面运行无报错', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

    /* ------------------ 汇总 ------------------ */
    log('\n========== 汇总 ==========');
    const passed = results.filter((r) => r.ok).length;
    log(`${passed}/${results.length} 通过`);
    for (const r of results.filter((r) => !r.ok)) log(`  ✗ ${r.name} :: ${r.detail}`);

    await fs.writeFile(
      path.join(__dirname, 'report.json'),
      JSON.stringify({ when: new Date().toISOString(), chrome: ver.Browser, extId, results, pageErrors: realErrors }, null, 2)
    );

    if (process.env.XT_KEEP_OPEN === '1') {
      log('\n浏览器保持打开（XT_KEEP_OPEN=1），Ctrl+C 结束');
      await new Promise(() => {});
    }
  } catch (e) {
    console.error('测试异常:', e.message);
    process.exitCode = 1;
  } finally {
    try {
      if (browser) await browser.close();
    } catch {}
    killTree(proc.pid);
    await sleep(600);
    try {
      await fs.rm(PROFILE, { recursive: true, force: true, maxRetries: 1 });
    } catch {}
  }
}

main();

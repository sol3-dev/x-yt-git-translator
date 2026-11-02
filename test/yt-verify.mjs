// YouTube 侧验证：真实站点（需要网络可达 YouTube）
// 覆盖：视频标题 / 简介 / 评论 / 字幕浮层
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
const PORT = 9335;
const PROFILE = path.join(os.tmpdir(), 'xt-yt-' + Date.now());
const SHOTS = path.join(__dirname, 'shots');
const VIDEO = process.env.XT_VIDEO || 'https://www.youtube.com/watch?v=arj7oStGLkU&cc_load_policy=1';

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
  throw new Error('端口未就绪');
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
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1280,900',
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  let browser;
  try {
    const ver = await waitPort();
    log('Chrome', ver.Browser);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const cdp = await browser.newBrowserCDPSession();
    const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT });
    log('扩展 ID:', extId);
    await sleep(1500);

    const context = browser.contexts()[0];
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    log('打开 YouTube…');
    let reachable = true;
    try {
      await page.goto(VIDEO, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
      reachable = false;
      log('无法打开 YouTube：' + e.message.split('\n')[0]);
    }

    if (!reachable || !page.url().includes('youtube.com')) {
      check('YouTube 可访问', false, '当前网络无法访问 YouTube（需开启代理）');
      await finish(errors);
      return;
    }
    check('YouTube 可访问', true, page.url().slice(0, 80));

    // 等播放器与元数据渲染
    await page.waitForSelector('ytd-watch-metadata', { timeout: 40000 }).catch(() => {});
    await sleep(1000);

    /* ---------- 标题 ---------- */
    // YouTube 是渐进渲染，metadata 出现后还要再等翻译请求返回
    await page
      .waitForFunction(
        () => {
          const el = document.querySelector('.xt-yt-title');
          return el && /[\u4e00-\u9fff]/.test(el.textContent || '');
        },
        null,
        { timeout: 40000 }
      )
      .catch(() => {});

    const titleInfo = await page.evaluate(() => {
      const h1 = document.querySelector('ytd-watch-metadata #title h1, ytd-watch-metadata h1');
      const el = document.querySelector('.xt-yt-title');
      return {
        original: (h1?.textContent || '').trim().slice(0, 70),
        translated: (el?.textContent || '').trim().slice(0, 70),
        where: el ? el.parentElement?.id || el.parentElement?.tagName : null
      };
    });
    log(`   标题原文: ${titleInfo.original}\n   标题译文: ${titleInfo.translated}（宿主 ${titleInfo.where}）`);
    check('视频标题被翻译', /[\u4e00-\u9fff]/.test(titleInfo.translated), titleInfo.translated);

    /* ---------- 简介 ---------- */
    await page.evaluate(() => {
      const btn = document.querySelector('#expand, tp-yt-paper-button#expand');
      if (btn) btn.click();
    });
    await page
      .waitForFunction(
        () => {
          const el = document.querySelector('#description-inline-expander #attributed-snippet-text');
          const box = el?.querySelector('.xt-translation');
          return box && /[\u4e00-\u9fff]/.test(box.textContent || '');
        },
        null,
        { timeout: 40000 }
      )
      .catch(() => {});

    const descInfo = await page.evaluate(() => {
      const src = document.querySelector(
        '#description-inline-expander #attributed-snippet-text, #description-inline-expander yt-attributed-string'
      );
      // 译文可能挂在 snippet 内部，也可能在它附近，统一在 #description 范围内找
      const box = document.querySelector('#description .xt-translation');
      return {
        original: (src?.textContent || '').trim().slice(0, 60),
        translated: (box?.textContent || '').trim().slice(0, 60)
      };
    });
    log(`   简介原文: ${descInfo.original}\n   简介译文: ${descInfo.translated}`);
    check('视频简介被翻译', /[\u4e00-\u9fff]/.test(descInfo.translated), descInfo.translated);

    /* ---------- 评论（滚动到评论区） ---------- */
    await page.evaluate(() => window.scrollBy(0, 1400));
    await sleep(3000);
    await page.evaluate(() => window.scrollBy(0, 900));
    // 只翻译进入视口的评论，这是刻意的省额度设计，所以这里只要求出现译文即可
    await page
      .waitForFunction(
        () => {
          const items = [
            ...document.querySelectorAll('ytd-comment-view-model #content-text, ytd-comment-renderer #content-text')
          ];
          return items.some((i) => i.querySelector('.xt-translation'));
        },
        null,
        { timeout: 30000 }
      )
      .catch(() => {});
    await sleep(2500);
    const commentInfo = await page.evaluate(() => {
      const items = [...document.querySelectorAll('ytd-comment-view-model #content-text, ytd-comment-renderer #content-text')];
      const withTr = items.filter((i) => i.querySelector('.xt-translation'));
      return {
        total: items.length,
        translated: withTr.length,
        sample: (withTr[0]?.querySelector('.xt-translation')?.textContent || '').trim().slice(0, 60)
      };
    });
    log(`   评论: ${commentInfo.translated}/${commentInfo.total} 有译文 → ${commentInfo.sample}`);
    if (commentInfo.total > 0) {
      check('评论被翻译', commentInfo.translated > 0, `${commentInfo.translated}/${commentInfo.total}`);
    } else {
      log('   （评论区未加载，跳过）');
    }

    /* ---------- 卡片标题 ---------- */
    await sleep(3000);
    const cardInfo = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll('yt-lockup-view-model h3 a, a#video-title-link, a#video-title')];
      const boxes = [...document.querySelectorAll('.xt-yt-card')];
      const zhBoxes = boxes.filter((b) => /[\u4e00-\u9fff]/.test(b.textContent || ''));
      return {
        total: anchors.length,
        translated: zhBoxes.length,
        sample: (zhBoxes[0]?.textContent || '').trim().slice(0, 50)
      };
    });
    log(`   卡片: ${cardInfo.translated}/${cardInfo.total} 有译文 → ${cardInfo.sample}`);
    if (cardInfo.total > 0) {
      check('视频卡片标题被翻译', cardInfo.translated > 0, `${cardInfo.translated}/${cardInfo.total}`);
    }

    /* ---------- 字幕 ---------- */
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(800);
    // 尝试开启字幕
    const ccClicked = await page.evaluate(() => {
      const btn = document.querySelector('.ytp-subtitles-button');
      if (!btn) return 'no-cc-button';
      const pressed = btn.getAttribute('aria-pressed');
      if (pressed !== 'true') btn.click();
      return 'clicked';
    });
    log('   CC 按钮:', ccClicked);

    // 播放视频让字幕滚动起来
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) {
        v.muted = true;
        v.play().catch(() => {});
      }
    });

    await sleep(3000);
    // 等中文译文浮层出现（字幕逐词吐出 → 稳定 320ms → 翻译 → 显示）
    await page
      .waitForFunction(
        () => {
          const el = document.querySelector('.xt-caption-overlay.xt-visible');
          return el && /[\u4e00-\u9fff]/.test(el.textContent || '');
        },
        null,
        { timeout: 35000 }
      )
      .catch(() => {});

    const capInfo = await page.evaluate(() => ({
      segments: document.querySelectorAll('.ytp-caption-segment').length,
      overlayVisible: !!document.querySelector('.xt-caption-overlay.xt-visible'),
      overlayText: (document.querySelector('.xt-caption-overlay')?.textContent || '').trim().slice(0, 60),
      overlayBottom: document.querySelector('.xt-caption-overlay')?.style.bottom || null,
      rawCaption: (document.querySelector('.ytp-caption-segment')?.textContent || '').trim().slice(0, 60)
    }));
    log(`   字幕段: ${capInfo.segments}, 浮层显示: ${capInfo.overlayVisible}, 译文: ${capInfo.overlayText}`);

    if (capInfo.segments > 0) {
      check('字幕浮层出现中文译文', capInfo.overlayVisible && /[\u4e00-\u9fff]/.test(capInfo.overlayText), capInfo.overlayText);
    } else {
      log('   （该视频未提供字幕轨道，字幕项跳过）');
    }

    await page.screenshot({ path: path.join(SHOTS, '10-youtube.png') });
    await finish(errors);
  } catch (e) {
    console.error('YouTube 测试异常:', e.message);
    process.exitCode = 1;
  } finally {
    try {
      if (browser) await browser.close();
    } catch {}
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
    } catch {}
    await sleep(500);
    try {
      await fs.rm(PROFILE, { recursive: true, force: true, maxRetries: 1 });
    } catch {}
  }
}

async function finish(errors) {
  log('\n========== 汇总 ==========');
  const passed = results.filter((r) => r.ok).length;
  log(`${passed}/${results.length} 通过`);
  for (const r of results.filter((r) => !r.ok)) log(`  ✗ ${r.name} :: ${r.detail}`);
  if (errors.length) log('页面报错:', errors.slice(0, 3).join(' | '));
}

main();

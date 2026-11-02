/**
 * YouTube Shorts 端到端验证（真实站点 + 真实 Key）
 * -------------------------------------------------------------------------
 * 覆盖：
 *   [1] 搜索结果页（含 Shorts 货架 + 普通卡片）是否都被翻译
 *   [2] Shorts 卡片译文节点是否真的插进去了、可见、限行生效
 *   [3] Shorts 播放页标题是否被翻译
 *   [4] 语言标签是否移到了行首（left:0），且仍只在悬停时出现
 *
 * 用法：XT_PW=<pw 路径> node test/yt-shorts-verify.mjs
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
const PORT = 9367;
const PROFILE = path.join(os.tmpdir(), 'xt-yts-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 真实存储：有 DeepSeek Key，才能真翻
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

async function main() {
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
      '--window-size=1500,1000',
      '--lang=zh-CN',
      'about:blank'
    ],
    { stdio: 'ignore' }
  );
  const HARD = setTimeout(() => {
    console.log('[超时] 强制退出');
    process.exit(1);
  }, 540000);
  HARD.unref?.();

  let browser;
  try {
    await waitPort();
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const cdp = await browser.newBrowserCDPSession();
    const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT });
    console.log('扩展 ID:', extId);
    await sleep(1500);

    const ctx = browser.contexts()[0];

    // 先切到「自动」——实际遇到的场景：自动模式下译文忽好忽坏
    const opt = await ctx.newPage();
    await opt.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: 'domcontentloaded' });
    await sleep(500);
    const eng = await opt.evaluate(async () => {
      const r = await chrome.runtime.sendMessage({ type: 'XT_SET_SETTINGS', patch: { engine: 'auto' } });
      return r?.settings?.engine;
    });
    console.log('已切到引擎：', eng);
    await opt.close();

    const page = await ctx.newPage();
    page.on('console', (m) => {
      const t = m.text();
      if (/\[XT\]/.test(t)) console.log('    [page]', t.slice(0, 150));
    });

    /* ==================== [1][2] 搜索结果页 ==================== */
    console.log('\n[1] 打开搜索结果页（自带 Shorts 货架）…');
    await page.goto('https://www.youtube.com/results?search_query=tokyo%20walk&hl=zh-CN', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await sleep(6000);
    // 关键：Shorts 货架在首屏之外，译文是「进入视口才翻」（IntersectionObserver），
    // 必须真的把它滚进来，否则统计永远是 0 —— 上一轮就是栽在这里。
    await page.evaluate(() => {
      document.querySelector('ytm-shorts-lockup-view-model')?.scrollIntoView({ block: 'center' });
    });
    await sleep(2500);
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 400);
      await sleep(600);
    }

    const before = await page.evaluate(() => ({
      shortsCards: document.querySelectorAll('ytm-shorts-lockup-view-model').length,
      normalCards: document.querySelectorAll('yt-lockup-view-model h3 a').length
    }));
    console.log(`    页面要素：Shorts 卡片 ${before.shortsCards} 个，普通卡片 ${before.normalCards} 个`);

    // 等译文出现（最多 90 秒）
    let stat = null;
    for (let i = 0; i < 45; i++) {
      stat = await page.evaluate(() => {
        const shorts = document.querySelectorAll('.xt-yt-shorts');
        const normal = document.querySelectorAll('.xt-yt-card:not(.xt-yt-shorts)');
        return {
          shorts: shorts.length,
          normal: normal.length,
          total: document.querySelectorAll('.xt-translation').length,
          sample: shorts[0]?.textContent?.slice(0, 60) || '',
          // 可见性 + 是否被父级裁掉
          shortsVisible: [...shorts].filter((el) => {
            const r = el.getBoundingClientRect();
            return r.height > 4 && r.width > 4;
          }).length,
          // 每条译文出自哪个引擎（最想知道的信息）
          engineHist: (() => {
            const h = {};
            for (const el of document.querySelectorAll('.xt-translation[data-xt-engine]')) {
              h[el.dataset.xtEngine] = (h[el.dataset.xtEngine] || 0) + 1;
            }
            return h;
          })(),
          sampleLabel: document.querySelector('.xt-translation[data-xt-lang]')?.dataset.xtLang || '',
          // 有没有「译文 == 原文」的假译文（灰字和标题一模一样那种）
          sameAsSrc: [...document.querySelectorAll('.xt-translation[data-xt-src]')].filter((el) => {
            const norm = (x) => String(x || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
            const src = norm(el.dataset.xtSrc);
            const txt = norm(el.textContent);
            if (!src) return false;
            return el.dataset.xtSrc.length < 40 ? txt === src : txt.startsWith(src.slice(0, 30));
          }).length,
          labelLeft: (() => {
            const el = document.querySelector('.xt-yt-card[data-xt-lang]');
            if (!el) return null;
            const cs = getComputedStyle(el, '::after');
            return { left: cs.left, right: cs.right, opacity: cs.opacity, content: cs.content, title: el.title };
          })(),
          // 有分割线的容器（这里用不到，仅占位）标签应仍然存在
          dividerChip: (() => {
            const el = document.querySelector('.xt-translation[data-xt-lang]:not(.xt-yt-card):not(.xt-yt-title)');
            if (!el) return null;
            return getComputedStyle(el, '::after').content;
          })()
        };
      });
      if (stat.shorts > 0 && stat.normal > 0) break;
      await sleep(2000);
    }

    console.log('\n[2] 渲染结果');
    check('普通视频卡片有译文', stat.normal > 0, `${stat.normal} 条`);
    check('Shorts 卡片有译文', stat.shorts > 0, `${stat.shorts} 条`);
    check('Shorts 译文实际可见（没被父级裁掉）', stat.shortsVisible > 0, `${stat.shortsVisible} 条可见`);
    if (stat.sample) console.log(`    样例译文：${stat.sample}`);
    console.log('    引擎分布：', JSON.stringify(stat.engineHist), '| 标签样例：', stat.sampleLabel);
    const engKeys = Object.keys(stat.engineHist);
    check('每条译文都标注了来源引擎', engKeys.length > 0, engKeys.join(', '));
    check('自动模式下统一走 Key 引擎（不再混入本地模型/Google）',
      engKeys.length === 1 && /deepseek|openai|gpt/i.test(engKeys[0]), engKeys.join(', ') || '(空)');
    check('悬停标签带引擎名', /·/.test(stat.sampleLabel), stat.sampleLabel);
    check('没有「译文与原文相同」的假译文', stat.sameAsSrc === 0, `${stat.sameAsSrc} 条`);

    if (stat.labelLeft) {
      check('卡片不再画浮动标签（改为原生提示）', stat.labelLeft.content === 'none', `content=${stat.labelLeft.content}`);
      check('卡片 title 里带上「译自 X」和全文', /译自/.test(stat.labelLeft.title || ''), (stat.labelLeft.title || '').split('\n')[0]);
    }

    await page.screenshot({ path: path.join(__dirname, 'shot-yt-search.png') }).catch(() => {});

    // 悬停验证标签可见
    const tagVisible = await page.evaluate(async () => {
      const el = document.querySelector('.xt-yt-shorts[data-xt-lang], .xt-yt-card[data-xt-lang]');
      if (!el) return null;
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      el.classList.add('force-hover'); // 用合成 hover 不可靠，直接查 :hover 规则下的 opacity
      const cs = getComputedStyle(el, '::after');
      return { content: cs.content, opacity: cs.opacity, left: cs.left };
    });
    console.log('    标签伪元素：', JSON.stringify(tagVisible));

    /* ==================== [3] Shorts 播放页 ==================== */
    console.log('\n[3] 打开 Shorts 播放页…');
    const shortsUrl = await page.evaluate(() => {
      const a = document.querySelector('ytm-shorts-lockup-view-model h3 a');
      return a ? a.href : null;
    });
    if (!shortsUrl) {
      check('找到 Shorts 链接', false, '货架里没有可取链接');
    } else {
      await page.goto(shortsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(8000);
      let sp = null;
      for (let i = 0; i < 20; i++) {
        sp = await page.evaluate(() => {
          const host = document.querySelector('yt-shorts-video-title-view-model');
          const tr = document.querySelector('.xt-yt-shorts-title');
          return {
            hasHost: !!host,
            hasTr: !!tr,
            text: tr?.textContent?.slice(0, 80) || '',
            attachedAfter: host && tr ? host.nextElementSibling === tr : false
          };
        });
        if (sp.hasTr) break;
        await sleep(2000);
      }
      check('播放页找到标题宿主', sp.hasHost);
      check('播放页标题已翻译', sp.hasTr, sp.text);
      check('译文插在标题宿主之后（不塞进可点击区）', sp.attachedAfter);
      await page.screenshot({ path: path.join(__dirname, 'shot-yt-shorts-player.png') }).catch(() => {});
    }

    /* ==================== 汇总 ==================== */
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n结果：${pass}/${results.length} 通过`);
    if (pass !== results.length) {
      console.log('未通过项：' + results.filter((r) => !r.ok).map((r) => r.name).join(' / '));
    }
  } finally {
    clearTimeout(HARD);
    try {
      if (browser) await browser.close();
    } catch {}
    try {
      proc.kill();
    } catch {}
  }
}

main().catch((e) => {
  console.error('失败：', e);
  process.exit(1);
});

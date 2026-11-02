/**
 * 按「文本内容」反查 GitHub 页面结构
 * -------------------------------------------------------------------------
 * 用法：XT_PW=<pw> node test/probe-github-find.mjs <url> "要查的文本" ["再一条"...]
 * 输出每个命中节点的 tag / class / 三层祖先链，用来写选择器。
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
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9393;
const PROFILE = path.join(os.tmpdir(), 'xt-ghf-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const TARGET = args[0] || 'https://github.com/AetherKiri';
const NEEDLES = args.slice(1);

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
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,1000',
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
  const page = await (await browser.contexts()[0]).newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(9000);

  const info = await page.evaluate((needles) => {
    const desc = (el) => {
      const parts = [];
      let cur = el;
      for (let i = 0; i < 4 && cur; i++) {
        parts.push(`${cur.tagName.toLowerCase()}${cur.className ? '.' + String(cur.className).split(' ').slice(0, 2).join('.') : ''}`);
        cur = cur.parentElement;
      }
      return parts.join(' < ');
    };
    const out = [];
    for (const needle of needles) {
      const low = needle.toLowerCase();
      const hits = [];
      for (const el of document.querySelectorAll('body *')) {
        if (el.children.length > 0) continue; // 只看叶子节点
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 120) continue;
        if (!t.toLowerCase().includes(low)) continue;
        hits.push({ text: t.slice(0, 70), chain: desc(el) });
        if (hits.length >= 2) break;
      }
      out.push({ needle, hits });
    }

    // 顺手把 input 的 placeholder 也列出来 —— 有些「文案」其实是属性，不是文本节点
    const ph = [...document.querySelectorAll('input[placeholder], textarea[placeholder]')]
      .map((i) => i.getAttribute('placeholder'))
      .filter(Boolean)
      .slice(0, 10);
    return { out, placeholders: [...new Set(ph)] };
  }, NEEDLES);

  for (const r of info.out) {
    console.log(`\n── "${r.needle}"`);
    if (!r.hits.length) console.log('   (未命中)');
    for (const h of r.hits) console.log(`   "${h.text}"\n     ${h.chain}`);
  }
  console.log('\n=== input placeholder ===');
  console.log(info.placeholders.join('\n') || '(无)');
} finally {
  clearTimeout(HARD);
  try {
    if (browser) await browser.close();
  } catch {}
  try {
    proc.kill();
  } catch {}
}

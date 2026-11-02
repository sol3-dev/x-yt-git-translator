import { getSettings, setSettings, DEFAULTS } from './settings.js';
import { loadCache, cacheGet, cacheSet, cacheKey, flush, clearCache, cacheStats } from './cache.js';
import {
  translate,
  ENGINE_LABELS,
  engineHealth,
  resetHealth,
  clearEngineHealth,
  isSameText,
  guessLanguage
} from './engines.js';
import { getProbeState, runProbe, watchProbe } from './probe.js';

watchProbe();

/* --------------------------- 并发闸门 --------------------------- */
// 限制同时进行的翻译请求数，避免滚动过快时把上游打爆。
// 3→2：这个数字才是真正的「请求速率乘数」——
// 每个批次内部又并发 2 路，3 个批次就是 6 路同时打 Google，
// 免费接口一看就知道不是人在用。降到 2 之后峰值减半。
const MAX_CONCURRENT = 2;
let running = 0;
const waiters = [];

async function acquire() {
  if (running < MAX_CONCURRENT) {
    running++;
    return;
  }
  await new Promise((resolve) => waiters.push(resolve));
  running++;
}

function release() {
  running--;
  const next = waiters.shift();
  if (next) next();
}

/* --------------------------- 主流程 --------------------------- */

function truncate(text, max) {
  if (text.length <= max) return text;
  // 尽量在空白处截断
  const cut = text.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return sp > max * 0.6 ? cut.slice(0, sp) + '…' : cut + '…';
}

/** 缓存值兼容层：老版本存的是纯字符串，新版本存 { t, l } */
function cacheRec(v) {
  if (!v) return null;
  if (typeof v === 'string') return { t: v, l: '' };
  if (typeof v === 'object' && typeof v.t === 'string' && v.t) return v;
  return null;
}

/**
 * 引擎 → 页面上显示的名字。
 * openai 直接显示模型名（deepseek-flash / gpt-4o-mini…），这样页面标签上写的
 * 和设置页里填的一模一样，不用猜「OpenAI 兼容」背后到底是哪家。
 */
function engLabel(engine, settings) {
  switch (engine) {
    case 'openai': {
      const m = (settings?.openai?.model || '').trim();
      return m || 'OpenAI';
    }
    case 'builtin':
      return '本地模型';
    case 'google':
      return 'Google';
    case 'mymemory':
      return 'MyMemory';
    default:
      return String(engine || '');
  }
}

async function handleTranslate({ texts, targetLang, engine, context }) {
  const settings = await getSettings();
  if (!settings.enabled) return { ok: false, error: 'disabled' };

  const list = (Array.isArray(texts) ? texts : [])
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .map((t) => (t ? truncate(t, settings.maxCharsPerItem) : ''));

  if (!list.length) return { ok: true, results: [], langs: [] };

  const target = targetLang || settings.targetLang;
  const eng = engine || settings.engine;

  // ★ 缓存命名空间：配了 Key 时，「自动」和「OpenAI 兼容」实际跑的是同一个引擎，
  // 必须共用同一份缓存。否则切换引擎 = 整页重翻，而大模型每次措辞都会微调，
  // 就会看到「选自动和选 OpenAI 译文不一样」，误以为自动偷偷用了别的引擎。
  const nsEngine = eng === 'auto' && settings.openai?.apiKey ? 'openai' : eng;

  const results = new Array(list.length).fill('');
  const langs = new Array(list.length).fill('');
  const sources = new Array(list.length).fill('');
  const misses = [];

  for (let i = 0; i < list.length; i++) {
    if (!list[i]) continue;
    const k = cacheKey(nsEngine, target, list[i]);
    const rec = cacheRec(cacheGet(k));
    // 旧缓存里可能存着「原文 = 译文」的坏记录（会显示成一行和原文一样的灰字）。
    // 读到这种就当没有，重新翻一次并覆盖掉 —— 不用手动清缓存。
    if (rec?.t && !isSameText(rec.t, list[i])) {
      results[i] = rec.t;
      // 旧缓存没有语言信息，就地补一个本地猜测，省一次请求
      langs[i] = rec.l || guessLanguage(list[i]);
      sources[i] = engLabel(rec.e || (nsEngine === 'openai' ? 'openai' : nsEngine), settings);
    } else {
      misses.push(i);
    }
  }

  if (misses.length) {
    // 同一批里如有重复文本，只请求一次
    const uniq = [...new Set(misses.map((i) => list[i]))];
    await acquire();
    let outs;
    try {
      outs = await translate(uniq, target, eng, settings, { context });
    } catch (e) {
      // 留痕：报错现场比「所有引擎都不可用」这句话有用一万倍。
      // 记录时间 / 引擎 / 真实错误 / 三条输入样本，排查时直接读出来。
      chrome.storage.local
        .set({
          xt_last_err_v1: {
            at: Date.now(),
            engine: eng,
            msg: String(e?.message || e).slice(0, 600),
            sample: uniq.slice(0, 3).map((t) => t.slice(0, 80))
          }
        })
        .catch(() => {});
      throw e;
    } finally {
      release();
    }
    const map = new Map();
    uniq.forEach((t, idx) => {
      const v = outs?.[idx];
      if (v?.t && !isSameText(v.t, t)) map.set(t, { t: v.t, l: v.l || guessLanguage(t), e: v.e || '' });
    });
    for (const i of misses) {
      const rec = map.get(list[i]);
      if (rec) {
        results[i] = rec.t;
        langs[i] = rec.l;
        sources[i] = engLabel(rec.e || nsEngine, settings);
        // 原样返回的不进缓存，免得下次又被当成「已翻译」
        if (!isSameText(rec.t, list[i])) cacheSet(cacheKey(nsEngine, target, list[i]), rec);
      }
    }
  }

  return { ok: true, results, langs, engines: sources, engine: eng, target };
}

/* --------------------------- 消息路由 --------------------------- */

const handlers = {
  async XT_PING() {
    return { ok: true, version: chrome.runtime.getManifest().version };
  },

  async XT_GET_SETTINGS() {
    return { ok: true, settings: await getSettings(), engines: ENGINE_LABELS };
  },

  async XT_SET_SETTINGS(msg) {
    const before = await getSettings();
    const next = await setSettings(msg.patch || {});

    // ★ 改了 Key / Base URL / 模型，必须把 openai 的旧冷却作废。
    // 否则「没填 Key 时被记了冷却」→ 后来填了 Key 切到自动 → 一小时之内还是跳过它，
    // 一路掉到内置模型 / Google，看到的就是「明明配了 Key，翻得还是不对」。
    const a = before.openai || {};
    const b = next.openai || {};
    const keyChanged = a.apiKey !== b.apiKey || a.baseUrl !== b.baseUrl || a.model !== b.model;
    if (keyChanged) {
      await clearEngineHealth('openai').catch(() => {});
    } else {
      // 没改 Key 也在改设置（比如把引擎切到「自动」）：顺手把 auth / nokey 这两种
      // 「配置类」旧账清掉。它们本来就不该长期挡住一个已经配好的引擎。
      const h = (await engineHealth().catch(() => ({})))?.openai;
      if (h && (h.kind === 'auth' || h.kind === 'nokey')) {
        await clearEngineHealth('openai').catch(() => {});
      }
    }
    return { ok: true, settings: next };
  },

  async XT_TRANSLATE(msg) {
    return handleTranslate(msg);
  },

  async XT_TEST_ENGINE(msg) {
    const settings = await getSettings();
    const engine = msg.engine || settings.engine;
    const sample = msg.text || 'Hello world, this is a translation test.';
    const t0 = Date.now();
    try {
      // 测试就是要「现在到底行不行」，不能被冷却挡住
      const outs = await translate(
        [sample],
        settings.targetLang,
        engine,
        {
          ...settings,
          openai: msg.openai ? { ...settings.openai, ...msg.openai } : settings.openai
        },
        { ignoreCooldown: true }
      );
      const out = outs?.[0]?.t || '';
      if (!out) throw new Error('返回为空');
      return { ok: true, output: out, lang: outs?.[0]?.l || guessLanguage(sample), ms: Date.now() - t0, engine };
    } catch (e) {
      return { ok: false, error: String(e.message || e), ms: Date.now() - t0, engine };
    }
  },

  async XT_CLEAR_CACHE() {
    await clearCache();
    return { ok: true };
  },

  async XT_CACHE_STATS() {
    await loadCache();
    return { ok: true, ...cacheStats() };
  },

  async XT_HEALTH() {
    return { ok: true, health: await engineHealth() };
  },

  /** 清空所有引擎冷却（换节点 / 换 Key 之后用） */
  async XT_HEALTH_RESET() {
    const health = await resetHealth();
    // 顺手重探一次网络，弹窗里的「网络」行也能立刻刷新
    runProbe().catch(() => {});
    return { ok: true, health };
  },

  /** 网络可达性：读缓存；force=true 时强制重探 */
  async XT_PROBE(msg) {
    const probe = msg?.force ? await runProbe() : await getProbeState({ mayProbe: true });
    return { ok: true, probe };
  },

  async XT_OPEN_OPTIONS() {
    chrome.runtime.openOptionsPage();
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (!msg.type.startsWith('XT_')) return;

  // 只接受本扩展自身发起的消息
  if (sender.id && sender.id !== chrome.runtime.id) return;

  // offscreen 的消息由 offscreen 自己处理
  if (msg.type === 'XT_OFFSCREEN_TRANSLATE') return;

  const fn = handlers[msg.type];
  if (!fn) return;

  Promise.resolve(fn(msg, sender))
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));

  return true; // 异步返回
});

// 快捷键：切换当前标签页翻译开关
chrome.commands?.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-translate') return;
  const settings = await getSettings();
  const next = !settings.enabled;
  await setSettings({ enabled: next });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs
      .sendMessage(tab.id, { type: 'XT_TOGGLE_APPLIED', enabled: next })
      .catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await loadCache();
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
  if (details.reason === 'install' || details.reason === 'update') {
    // 版本升级时清空引擎冷却。
    // 冷却记录是持久化的，如果不清，升级到「已修复该问题」的版本后
    // 还要白白等上 30 分钟才看到效果 —— 会以为改了没用。
    try {
      await resetHealth();
      console.log(`[XT] ${details.reason} → 已清空引擎冷却（新版本应立即生效）`);
    } catch (e) {
      console.warn('[XT] 清空冷却失败：', e?.message || e);
    }
  }
});

chrome.runtime.onStartup?.addListener(() => {
  loadCache();
});

// 惰性初始化缓存
loadCache();
// 探测结果过期时后台补一次（TTL 内直接命中，不会每次唤醒都打请求）
getProbeState({ mayProbe: true }).catch(() => {});

// Chrome 内置 Translator / LanguageDetector API 需要在 DOM 上下文中运行，
// service worker 里没有 window，所以放到 offscreen document。

const translators = new Map(); // `${src}->${tgt}` -> Promise<Translator>
let detectorPromise = null;
let probed = null;

/**
 * 模型状态缓存。
 * 只有 'available' 可以永久缓存 —— downloadable/downloading 会随着点击变化，
 * 缓存了会导致「明明下好了还说没下」。
 */
const availCache = new Map();

/**
 * 模型没下载时，Translator.create() 会抛
 *   "Requires a user gesture when availability is 'downloading' or 'downloadable'"
 * 扩展的 offscreen / service worker 都没有交互能力，注定失败。
 * 所以提前拦下来，报一个明确指向设置页按钮的错误，而不是每批都静默失败。
 */
class NeedGestureError extends Error {
  constructor(pair, state) {
    super(`本地模型未下载（${pair}，状态 ${state}），需在设置页点一次「下载本地模型」`);
    this.name = 'NeedGestureError';
    this.kind = 'gesture';
  }
}

/**
 * 语言对本身不在 Chrome 模型覆盖范围内（如 fa→zh 波斯语）。
 * 这**不是引擎故障**：引擎好好的，只是这门语言没模型。
 * 必须和「引擎挂了」区分开，否则一批里全是波斯语时，会把最健康的
 * 本地引擎误判为不健康并冷却 5 分钟，之后每 5 分钟白撞一次。
 */
class UnsupportedPairError extends Error {
  constructor(src, tgt) {
    super(`本地模型不支持 ${src} → ${tgt}`);
    this.name = 'UnsupportedPairError';
    this.kind = 'unsupported';
  }
}

/**
 * 这一门语言的模型还没下载（如 hi→zh 印地语），但**别的语言对已经能用了**。
 * 和 NeedGestureError 的区别非常关键：
 *   NeedGestureError     = 从没下载过，整台设备都没模型 → 该冷却 30 分钟并提示去设置页
 *   PairNeedsDownload    = 只是这一门语言缺 → 别冷却引擎，这一条交给在线引擎补就行
 * 以前不区分，刷到一条印地语推文就把本地引擎关 30 分钟，等于「一条推文毁掉整个页面」。
 */
class PairNeedsDownloadError extends Error {
  constructor(src, tgt, state) {
    super(`本地模型未下载 ${src} → ${tgt}（状态 ${state}），可在设置页一次补齐`);
    this.name = 'PairNeedsDownloadError';
    this.kind = 'pair-download';
  }
}

function hasBuiltinAI() {
  return typeof self.Translator !== 'undefined';
}

async function probe() {
  if (probed) return probed;
  probed = {
    translator: typeof self.Translator,
    detector: typeof self.LanguageDetector,
    availability: null,
    error: null
  };
  if (typeof self.Translator === 'undefined') {
    probed.error = '当前上下文没有 Translator API';
    return probed;
  }
  try {
    probed.availability = await self.Translator.availability({
      sourceLanguage: 'en',
      targetLanguage: 'zh'
    });
  } catch (e) {
    probed.error = 'availability() 抛错: ' + (e?.message || e);
  }
  return probed;
}

async function getDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      if (typeof self.LanguageDetector === 'undefined') return null;
      try {
        const avail = await self.LanguageDetector.availability();
        if (avail === 'unavailable') return null;
        return await self.LanguageDetector.create();
      } catch (e) {
        console.warn('[XT] LanguageDetector 不可用', e);
        return null;
      }
    })();
  }
  return detectorPromise;
}

async function detectLang(text) {
  const d = await getDetector();
  if (!d) return null;
  try {
    const res = await d.detect(text);
    if (Array.isArray(res) && res.length) return res[0].detectedLanguage || null;
  } catch {}
  return null;
}

async function availabilityOf(src, tgt) {
  const key = `${src}->${tgt}`;
  if (availCache.has(key)) return availCache.get(key);
  const a = await self.Translator.availability({ sourceLanguage: src, targetLanguage: tgt });
  if (a === 'available') availCache.set(key, a);
  return a;
}

/**
 * 「这台设备上本地翻译到底能不能用」——用 en→目标语言 作为探针。
 * 判断这个是为了区分两种 downloadable：
 *   探针也 downloadable  → 根本没下载过，该提示去设置页（冷却 30 分钟）
 *   探针 available，只是这条 downloadable → 单门语言缺，换引擎补就行（不冷却）
 */
let baseProbe = null; // { tgt, ready, at }
async function baseModelReady(tgt) {
  const fresh = baseProbe && baseProbe.tgt === tgt && Date.now() - baseProbe.at < 5 * 60 * 1000;
  if (fresh) return baseProbe.ready;
  let ready = false;
  try {
    const a = await self.Translator.availability({ sourceLanguage: 'en', targetLanguage: tgt });
    ready = a === 'available' || a === 'readily';
  } catch {
    ready = false;
  }
  baseProbe = { tgt, ready, at: Date.now() };
  return ready;
}

async function getTranslator(src, tgt) {
  const key = `${src}->${tgt}`;
  if (translators.has(key)) return translators.get(key);

  const p = (async () => {
    const avail = await availabilityOf(src, tgt);
    if (avail === 'unavailable') throw new UnsupportedPairError(src, tgt);
    if (avail !== 'available' && avail !== 'readily') {
      // downloadable / downloading：必须有一次点击才能拉起下载，这里没戏。
      // 但要分清「一门语言缺」和「整体没下」：前者不该连累整个引擎。
      if (await baseModelReady(tgt)) throw new PairNeedsDownloadError(src, tgt, avail);
      throw new NeedGestureError(key, avail);
    }

    return await self.Translator.create({
      sourceLanguage: src,
      targetLanguage: tgt,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          const pct = Math.round((e.loaded / (e.total || 1)) * 100);
          console.log(`[XT] 下载 ${key} 模型 ${pct}%`);
        });
      }
    });
  })();

  translators.set(key, p);
  p.catch(() => translators.delete(key));
  return p;
}

function normalizeTarget(t) {
  if (!t) return 'zh';
  if (t === 'zh-CN' || t === 'zh-Hans' || t === 'zh') return 'zh';
  if (t === 'zh-TW' || t === 'zh-Hant') return 'zh-Hant';
  return t.split('-')[0];
}

function normalizeSource(src) {
  if (!src) return null;
  const s = String(src).toLowerCase();
  // und = 语言检测没结论。以前直接拿去当源语言，得到 "本地模型不支持 und -> zh"，
  // 白白浪费一整批。这里回落到 null，由调用方用 en 兜底。
  if (s === 'und' || s === 'unknown' || s === 'zxx' || s === 'mul' || s === '') return null;
  return s === 'zh' || s === 'zh-hans' || s === 'zh-cn' ? 'zh' : s.split('-')[0];
}

async function translateAll(texts, targetLang) {
  const info = await probe();
  if (!info.translator || info.translator === 'undefined') {
    throw new Error('内置翻译不可用：' + (info.error || 'Translator API 缺失'));
  }

  const tgt = normalizeTarget(targetLang);
  const out = new Array(texts.length).fill(null);
  const errors = [];
  const missingLang = new Set();

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    if (!text) continue;
    const detected = normalizeSource(await detectLang(text)) || 'en';
    if (detected === tgt) {
      out[i] = { t: text, l: detected };
      continue;
    }
    try {
      const tr = await getTranslator(detected, tgt);
      out[i] = { t: await tr.translate(text), l: detected };
    } catch (e) {
      // 整台设备都没有模型：整批都没救，立刻中止并把「去设置页点一下」这句话带上去
      if (e?.kind === 'gesture') throw e;
      // 只是这一门语言缺模型（如印地语）：引擎是健康的，这条交给在线引擎补
      if (e?.kind === 'pair-download') {
        missingLang.add(detected);
        out[i] = { t: null, skip: 'need-download', l: detected };
        continue;
      }
      // 该语言 Chrome 根本不支持（如波斯语）
      if (e?.kind === 'unsupported') {
        out[i] = { t: null, skip: 'unsupported', l: detected };
        continue;
      }
      errors.push(`${detected}->${tgt}: ${e?.message || e}`);
      out[i] = null;
    }
  }

  if (missingLang.size) {
    console.warn(`[XT] 这些语言的本地模型还没下载：${[...missingLang].join(', ')}（可在设置页一次补齐）`);
  }

  // 全是「语言不支持 / 缺模型」时不抛错：引擎没坏，只是没有这几门语言。
  // 让上层用 skip 标记决定「换下一个引擎」，而不是把内置引擎打入冷却。
  if (!out.some((x) => x?.t) && errors.length) {
    throw new Error('内置翻译失败 —— ' + [...new Set(errors)].slice(0, 2).join('; '));
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'XT_OFFSCREEN_PROBE') {
    probe().then((i) => sendResponse({ ok: true, info: i }));
    return true;
  }
  if (msg?.type !== 'XT_OFFSCREEN_TRANSLATE') return;
  if (sender.id && sender.id !== chrome.runtime.id) return;

  translateAll(msg.texts || [], msg.targetLang)
    .then((results) => sendResponse({ ok: true, results }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e), kind: e?.kind || '' }));

  return true;
});

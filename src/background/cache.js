// 翻译结果持久化缓存。
// 设计目标：滚动回看 / 刷新页面后不再重复请求，显著降低限流风险。
// 策略：内存 Map 作为热缓存 + chrome.storage.local 定期批量落盘，超出上限按插入顺序淘汰。

const KEY = 'xt_cache_v1';
const MAX_ENTRIES = 4000;
const FLUSH_DELAY = 5000;

let mem = new Map();
let loaded = false;
let loadPromise = null;
let dirty = false;
let flushTimer = null;

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function cacheKey(engine, target, text) {
  return `${engine}|${target}|${hash(text)}|${text.length}`;
}

export function loadCache() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const stored = await chrome.storage.local.get(KEY);
      const raw = stored[KEY];
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) mem.set(k, v);
      }
    } catch (e) {
      console.warn('[XT] 缓存读取失败', e);
    }
    loaded = true;
  })();
  return loadPromise;
}

export function cacheGet(key) {
  if (!loaded) return undefined;
  return mem.get(key);
}

export function cacheSet(key, value) {
  if (!loaded) return;
  mem.set(key, value);
  // Map 保持插入顺序，超出上限时删最早的
  while (mem.size > MAX_ENTRIES) {
    const oldest = mem.keys().next().value;
    if (oldest === undefined) break;
    mem.delete(oldest);
  }
  dirty = true;
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_DELAY);
}

export async function flush() {
  flushTimer = null;
  if (!dirty) return;
  dirty = false;
  const obj = {};
  for (const [k, v] of mem) obj[k] = v;
  try {
    await chrome.storage.local.set({ [KEY]: obj });
  } catch (e) {
    dirty = true;
    console.warn('[XT] 缓存写入失败', e);
  }
}

export async function clearCache() {
  mem = new Map();
  dirty = false;
  await chrome.storage.local.remove(KEY);
}

export function cacheStats() {
  return { size: mem.size, loaded };
}

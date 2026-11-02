/* =========================================================================
 * 网络可达性探测（「有没有代理」的替代方案）
 * -------------------------------------------------------------------------
 * 为什么不能直接读代理设置：Chrome 扩展没有任何 API 能查询系统级 VPN / 代理
 * 的状态（chrome.proxy 只管扩展自己设的代理，管不到系统梯子）。所以唯一
 * 可靠的办法是「真发一个请求，看多久回来」。
 *
 * 设计要点：
 *   1. 探测用 gstatic 的 generate_204 —— Google 自家端点，返回 204、零字节，
 *      比拿真实翻译请求去试错快两个数量级（1.5s vs 最坏 80s）。
 *   2. 结果写 chrome.storage.local。MV3 的 service worker 空闲 30 秒就被回收，
 *      只放内存的话冷却/探测结论会跟着丢，这是老版本最大的坑。
 *   3. 带 10 分钟 TTL。开关梯子后最多 10 分钟自动适应，也可手动重探。
 * ========================================================================= */

const KEY = 'xt_probe_v1';
const TTL = 10 * 60 * 1000;
const TIMEOUT = 1500;

let mem = null;
let inflight = null;

/** 只读缓存，永远不触发探测（给渲染路径用，绝不能阻塞翻译） */
export async function peekProbe() {
  if (mem) return mem;
  try {
    const s = await chrome.storage.local.get(KEY);
    mem = s[KEY] || null;
  } catch {
    mem = null;
  }
  return mem;
}

/**
 * 取探测状态。
 * @param {object} opts
 * @param {boolean} opts.mayProbe 缓存过期时是否允许触发一次真实探测（后台进行，不阻塞调用方）
 * @returns {Promise<object|null>} { at, google, ms, error }
 */
export async function getProbeState({ mayProbe = false } = {}) {
  const cur = await peekProbe();
  const fresh = cur && Date.now() - (cur.at || 0) < TTL;
  if (fresh) return cur;
  if (mayProbe) {
    // 故意不 await：翻译不能被探测拖慢，探完下一次请求就用上新结论
    runProbe().catch(() => {});
  }
  return cur;
}

/** 真正发一次请求。多个调用方同时触发时复用同一个 Promise。 */
export function runProbe() {
  if (inflight) return inflight;
  inflight = (async () => {
    const t0 = Date.now();
    let google = false;
    let error = '';
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
      try {
        // no-cors 下拿不到状态码，但只要不抛错就说明链路是通的
        await fetch('https://www.gstatic.com/generate_204', {
          signal: ctrl.signal,
          cache: 'no-store',
          mode: 'no-cors',
          credentials: 'omit'
        });
        google = true;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      error = String(e?.message || e);
    }

    const state = {
      at: Date.now(),
      google,
      ms: Date.now() - t0,
      error,
      // 顺手判断一下「网络通但没网速」的死链接情况
      slow: google && Date.now() - t0 > 1200
    };
    mem = state;
    try {
      await chrome.storage.local.set({ [KEY]: state });
    } catch {}
    return state;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** 其它标签页/其它上下文改了探测结果时同步到本地内存 */
export function watchProbe() {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEY]) return;
      mem = changes[KEY].newValue || null;
    });
  } catch {}
}

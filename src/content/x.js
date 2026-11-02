/* =========================================================================
 * X（Twitter）适配层
 * -------------------------------------------------------------------------
 * 难点在于 X 的时间线是「虚拟滚动 + 节点复用」：
 *   - 往下滑不会刷新页面，而是不断往 DOM 里插新 article
 *   - 滑出视口的 article 会被回收，同一个 DOM 节点可能被拿去显示另一条推文
 * 所以不能用「一次性遍历翻译」，必须是「持续扫描 + 内容指纹比对」。
 * ========================================================================= */
(() => {
  const NS = globalThis.__XT;
  if (!NS?.core) return;
  const core = NS.core;

  const SEL_TWEET = 'article[data-testid="tweet"]';
  const SEL_TEXT = '[data-testid="tweetText"]';
  const SEL_PROFILE_DESC = '[data-testid="UserDescription"]';

  // 私信里的气泡不适合翻译，直接跳过
  const SKIP_ANCESTOR =
    '[data-testid="DmScroller"], [data-testid="DMDrawer"], [data-testid="dm-conversation-panel"], [data-testid="chat-container"]';

  /* ------------------------ 源文本提取 ------------------------ */

  // 递归取文本，但要跳过我们自己插入的 .xt-translation，
  // 同时把 emoji <img alt="😀"> 的 alt 也算进去，否则译文会丢表情。
  function nodeText(node) {
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';
    const el = node;
    if (el.classList && el.classList.contains('xt-translation')) return '';
    if (el.tagName === 'IMG') return el.getAttribute('alt') || '';
    if (el.tagName === 'BR') return '\n';
    let out = '';
    for (const child of el.childNodes) out += nodeText(child);
    return out;
  }

  function sourceText(host) {
    let out = '';
    for (const n of host.childNodes) out += nodeText(n);
    return out.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* -------------------------- 翻译渲染 -------------------------- */

  function renderTweet(host, translated, _source, lang) {
    // 追加在 tweetText 内部末尾：能自动继承 X 的字号、行高、宽度、RTL 方向
    return core.render(host, translated, '', 'xt-x', lang);
  }

  /* --------------------------- 扫描 --------------------------- */

  function shouldSkip(el) {
    const art = el.closest(SEL_TWEET);
    if (!art) return true;
    if (art.closest(SKIP_ANCESTOR)) return true;
    return false;
  }

  function handle(host) {
    if (shouldSkip(host)) return;
    const text = sourceText(host);
    if (!text) return;
    core.queue(host, text, renderTweet);
  }

  function scanAll() {
    const s = core.settings;
    if (!s.enabled || !s.x?.enabled) return;

    for (const art of document.querySelectorAll(SEL_TWEET)) {
      if (art.closest(SKIP_ANCESTOR)) continue;
      for (const el of art.querySelectorAll(SEL_TEXT)) handle(el);
    }

    if (s.x?.profile) {
      for (const el of document.querySelectorAll(SEL_PROFILE_DESC)) {
        const text = sourceText(el);
        if (text)         core.queue(el, text, (h, t, _s, lang) => core.render(h, t, '', 'xt-x', lang));
      }
    }
  }

  function scanNode(node) {
    if (node.nodeType !== 1) return;
    const s = core.settings;
    if (!s.enabled || !s.x?.enabled) return;

    if (node.matches?.(SEL_TEXT)) handle(node);
    const inner = node.querySelectorAll?.(SEL_TEXT);
    if (inner?.length) for (const el of inner) handle(el);
  }

  /* --------------------------- 启动 --------------------------- */

  core.ready.then(() => {
    const s = core.settings;
    if (!s.enabled || !s.x?.enabled) return;

    core.onIncremental((addedNodes) => {
      for (const n of addedNodes) scanNode(n);
    });

    core.onRescan(scanAll);

    // X 是 SPA，首屏可能还没渲染完，做几次补偿扫描
    scanAll();
    setTimeout(scanAll, 800);
    setTimeout(scanAll, 2500);

    core.watchDom({ debounce: 110 });
  });

  // 设置里重新启用后需要重扫
  core.onSettings((s) => {
    if (s.enabled && s.x?.enabled) scanAll();
  });

  // 供 popup 查询本页翻译数量
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'XT_PAGE_STATS') {
      sendResponse({
        ok: true,
        site: 'x',
        stats: core.stats(),
        boxes: document.querySelectorAll('.xt-translation').length,
        engines: core.engineStats()
      });
    }
    if (msg?.type === 'XT_RESCAN_NOW') {
      core.bumpGeneration();
      scanAll();
      sendResponse({ ok: true });
    }
  });
})();

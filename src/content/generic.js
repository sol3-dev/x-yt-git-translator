/* =========================================================================
 * 通用站点适配层（手动「添加此网页」后启用）
 * -------------------------------------------------------------------------
 * X / YouTube 有专属选择器，其它站点只能靠通用规则猜「哪段是要读的正文」。
 * 这是整个扩展里唯一「必然不完美」的部分：导航、按钮、版权声明都可能被误翻。
 * 所以做了四重过滤，宁可漏翻也不乱翻：
 *   1. 结构过滤：nav / header / footer / aside / form / pre / code 内一律不碰
 *   2. 交互过滤：段落里含 input / textarea / select / button 的跳过
 *   3. 容器过滤：段落里嵌套了 p / div / article 等块级子元素的，说明它是容器而非正文
 *   4. 长度过滤：太短的（导航词、按钮词）跳过
 *
 * 另外：这个脚本在 content_scripts 里匹配 http/https 所有站点，但只有当前
 * 域名出现在 settings.customSites 里才会真正扫描，其余页面开销只有一次 hostname 判断。
 * ========================================================================= */
(() => {
  const NS = globalThis.__XT;
  if (!NS?.core) return;
  const core = NS.core;

  const host = location.hostname.replace(/^www\./, '');

  // 已知站点有专属适配层，别在这儿重复处理
  // 已有专属适配层的站点不要再被通用规则摸一遍（GitHub 界面文案会翻错）
  if (/(^|\.)(x|twitter|youtube|github)\.com$/.test(host)) return;

  // 段落 / 标题 / 引用 / 列表项。不用 div 是因为 div 层级太乱，容易把整页当成一个块
  const BLOCK_SEL = 'p, h1, h2, h3, h4, h5, blockquote, li, dd, figcaption, td';

  const SKIP_ANCESTOR = [
    'nav',
    'header',
    'footer',
    'aside',
    'form',
    'pre',
    'code',
    'script',
    'style',
    'noscript',
    'svg',
    'button',
    'select',
    'textarea',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    '[role="complementary"]',
    '[aria-hidden="true"]',
    '[contenteditable="true"]'
  ].join(',');

  const MIN_LEN = 12;
  const MAX_LEN = 4000;

  /* ---------------------------- 域名匹配 ---------------------------- */

  function matchSite(list) {
    return (list || []).some((s) => {
      if (!s) return false;
      const d = String(s).toLowerCase().replace(/^www\./, '').trim();
      return d && (host === d || host.endsWith('.' + d));
    });
  }

  function active() {
    return !!core.settings?.enabled && matchSite(core.settings?.customSites);
  }

  /* --------------------------- 源文本提取 --------------------------- */

  // 递归取文本，跳过我们自己插入的译文节点，保留换行
  function nodeText(node) {
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';
    const el = node;
    if (el.classList && el.classList.contains('xt-translation')) return '';
    if (el.tagName === 'BR') return '\n';
    if (el.tagName === 'IMG') return el.getAttribute('alt') || '';
    let out = '';
    for (const child of el.childNodes) out += nodeText(child);
    return out;
  }

  function sourceText(el) {
    return String(nodeText(el))
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* ---------------------------- 过滤规则 ---------------------------- */

  function shouldSkip(el) {
    if (!el.isConnected) return true;
    if (el.closest(SKIP_ANCESTOR)) return true;
    if (el.isContentEditable) return true;

    // 段落里嵌了块级元素，说明它是容器而不是一段正文
    if (el.querySelector('p, div, article, section, ul, ol, table, h1, h2, h3')) return true;

    // 表单控件
    if (el.querySelector('input, textarea, select, button')) return true;

    return false;
  }

  function handle(el) {
    if (shouldSkip(el)) return;
    const text = sourceText(el);
    if (!text) return;
    if (text.length < MIN_LEN) return;
    if (text.length > MAX_LEN) return; // 超长块（整页正文）交给上层截断没意义，直接跳过
    core.queue(el, text, renderPlain);
  }

  function renderPlain(h, translated, _source, lang) {
    return core.render(h, translated, '', 'xt-gen', lang);
  }

  /* ----------------------------- 扫描 ----------------------------- */

  function scanAll() {
    if (!active()) return;
    for (const el of document.querySelectorAll(BLOCK_SEL)) handle(el);
  }

  function scanNode(node) {
    if (node.nodeType !== 1) return;
    if (node.matches?.(BLOCK_SEL)) handle(node);
    const inner = node.querySelectorAll?.(BLOCK_SEL);
    if (inner?.length) for (const el of inner) handle(el);
  }

  /* ----------------------------- 启动 ----------------------------- */

  // 监听器只注册一次：弹窗点「翻译此网站」时会再注入一次本文件，
  // 重复注册会让每次 DOM 变化被处理两遍。
  if (!NS.genericInit) {
    NS.genericInit = true;

    core.onIncremental((addedNodes) => {
      if (!active()) return;
      for (const n of addedNodes) scanNode(n);
    });

    core.onRescan(scanAll);

    core.onSettings(() => {
      // 刚在弹窗里添加本站：立刻完整启动（扫描 + 监听后续 DOM）
      if (active()) ensureStarted();
    });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg?.type === 'XT_PAGE_STATS') {
        sendResponse({
          ok: true,
          site: 'custom',
          host,
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
  }

  function ensureStarted() {
    // 用命名空间上的标记，重复注入时也能保持幂等
    if (NS.genericStarted) return;
    NS.genericStarted = true;
    scanAll();
    setTimeout(scanAll, 900);
    setTimeout(scanAll, 2600);
    // watchDom 每次调用都会新建 MutationObserver + 定时器，只能挂一次
    if (!NS.genericWatching) {
      NS.genericWatching = true;
      core.watchDom({ debounce: 140 });
    }
  }

  core.ready.then(() => {
    if (active()) ensureStarted();
  });
})();

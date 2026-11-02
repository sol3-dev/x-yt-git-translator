/* =========================================================================
 * YouTube 适配层
 * -------------------------------------------------------------------------
 * 覆盖范围：视频标题 / 简介 / 评论 / 视频卡片标题 / 播放中字幕
 * YouTube 同样是 SPA + 节点复用，所以复用 XT core 的「扫描 + 指纹比对」模型。
 * 字幕是唯一例外：它每 200ms 都在变，必须走独立的稳定检测通道。
 * ========================================================================= */
(() => {
  const NS = globalThis.__XT;
  if (!NS?.core) return;
  const core = NS.core;

  /* --------------------------- 文本提取 --------------------------- */

  function nodeText(node) {
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';
    const el = node;
    if (el.classList && el.classList.contains('xt-translation')) return '';
    if (el.tagName === 'IMG') return el.getAttribute('alt') || '';
    if (el.tagName === 'BR') return '\n';
    // 跳过 YouTube 的「更多 / 展开」按钮文字
    if (el.id === 'expand' || el.id === 'collapse' || el.tagName === 'TP-YT-PAPER-BUTTON') return '';
    let out = '';
    for (const c of el.childNodes) out += nodeText(c);
    return out;
  }

  function sourceText(el) {
    let out = '';
    for (const n of el.childNodes) out += nodeText(n);
    return out.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* --------------------------- 各区域定义 --------------------------- */

  // 视频标题：h1 里是 yt-formatted-string；译文插到 h1 之后，避免把 h1 撑成两行标题
  const TITLE_SEL = [
    'ytd-watch-metadata #title h1',
    'ytd-watch-metadata h1.ytd-watch-metadata'
  ].join(', ');

  // 简介：新版是 yt-attributed-string，旧版是 yt-formatted-string
  const DESC_SEL = [
    '#description-inline-expander #attributed-snippet-text',
    '#description-inline-expander yt-attributed-string',
    '#description ytd-text-inline-expander yt-formatted-string',
    '#description yt-formatted-string'
  ].join(', ');

  // 评论正文
  const COMMENT_SEL = [
    'ytd-comment-view-model #content-text',
    'ytd-comment-renderer #content-text',
    'yt-attributed-string#content-text'
  ].join(', ');

  // 视频卡片标题（首页 / 搜索 / 推荐侧栏 / 播放列表）
  // 新版 YouTube 用 yt-lockup-view-model + h3>a 结构，旧版是 a#video-title-link
  //
  // ★ Shorts 是另一套组件，完全不在 yt-lockup-view-model 里（2026-10 实测结构）：
  //   <ytm-shorts-lockup-view-model>
  //     <a aria-hidden>…缩略图…</a>
  //     <div class="shortsLockupViewModelHostOutsideMetadata">
  //       <div>
  //         <h3 class="shortsLockupViewModelHostMetadataTitle">
  //           <a title="完整标题"><span>标题文本</span></a>
  //         </h3>
  //         <div class="…MetadataSubhead">6503次观看</div>
  //       </div>
  //     </div>
  //   </ytm-shorts-lockup-view-model>
  // 之前只写了普通卡片，所以首页 / 搜索里的 Shorts 一条都没被扫到。
  const CARD_SEL = [
    'yt-lockup-view-model h3 a',
    'ytm-shorts-lockup-view-model h3 a',
    'ytm-shorts-lockup-view-model-v2 h3 a',
    '[class*="shortsLockupViewModelHostMetadataTitle"] a',
    'a#video-title-link',
    'a#video-title',
    'yt-formatted-string#video-title'
  ].join(', ');

  // Shorts 容器（用于区分渲染方式：卡片很窄，译文必须限行）
  const SHORTS_HOST_SEL =
    'ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-reel-item-renderer';

  // Shorts 播放页（竖屏全屏）的标题。实测结构：
  //   <yt-shorts-video-title-view-model class="…HostClickable">
  //     <h1 role="link" class="ytShortsVideoTitleViewModelShortsVideoTitle">标题</h1>
  //   </yt-shorts-video-title-view-model>
  // 注意是 h1 不是 h2，且外面套的是自定义元素（整块可点击），
  // 所以译文插在这个自定义元素**之后**，别塞进去（会连带触发跳转）。
  const SHORTS_TITLE_SEL =
    'yt-shorts-video-title-view-model h1, h1.ytShortsVideoTitleViewModelShortsVideoTitle';

  /* --------------------------- 渲染实现 --------------------------- */

  /**
   * 给译文节点挂原生悬停提示。
   * YouTube 的标题和卡片没有空白画标签（画上去必然压字），所以这里把
   * 「译自 X」（以及卡片的全文）塞进 title 属性 —— 浏览器在光标旁浮出，
   * 不会遮挡正文，也不产生任何布局跳动。
   */
  function applyTooltip(el, translated, fullText) {
    const label = el?.dataset?.xtLang || '';
    if (!label) {
      el.removeAttribute('title');
      return;
    }
    el.title = fullText ? `${label}\n${translated}` : label;
  }

  function renderTitle(h1, translated, lang) {
    // YouTube 会在导航/数据更新时重渲染元数据区。
    // 如果译文回来时 h1 已经被替换，直接放弃（返回 null 让调度器稍后重试），
    // 否则 insertAdjacentElement 会抛错。
    if (!h1.isConnected) return null;
    // 插到 #title 之后：放进 h1 内部会把标题撑成两行，贴在 h1 后面会跟角标挤在同一行
    const anchor = h1.closest('#title') || h1;
    if (!anchor.isConnected) return null;
    let el = anchor.nextElementSibling;
    if (!el || !el.classList?.contains('xt-translation')) {
      el = document.createElement('div');
      el.className = 'xt-translation xt-yt-title';
      el.setAttribute('dir', 'auto');
      anchor.insertAdjacentElement('afterend', el);
    }
    el.textContent = translated;
    core.setLang(el, lang);
    applyTooltip(el, translated, false);
    return el;
  }

  function renderPlain(host, translated, _source, lang) {
    return core.render(host, translated, '', 'xt-yt', lang);
  }

  function renderCard(anchor, translated, _source, lang) {
    // 新版卡片的标题链接在 h3 内，插到 h3 后面才不会把标题挤成一行
    const h3 = anchor.closest('h3');
    const isShorts = !!anchor.closest(SHORTS_HOST_SEL);
    if (h3 && h3.isConnected) {
      let el = h3.nextElementSibling;
      if (!el || !el.classList?.contains('xt-translation')) {
        el = document.createElement('div');
        el.className = 'xt-translation xt-yt-card' + (isShorts ? ' xt-yt-shorts' : '');
        el.setAttribute('dir', 'auto');
        h3.insertAdjacentElement('afterend', el);
      }
      el.textContent = translated;
      core.setLang(el, lang);
      // 卡片限 2 行，长标题会被截断 → title 里带上「译自 X」和完整译文，
      // 悬停就能看到全文，且不会像浮动标签那样压住字。
      applyTooltip(el, translated, true);
      return el;
    }
    if (!anchor.isConnected) return null;
    const el = core.box(anchor, 'xt-yt-card');
    el.textContent = translated;
    core.setLang(el, lang);
    applyTooltip(el, translated, true);
    return el;
  }

  /* ----------------------------- 扫描 ----------------------------- */

  function alive(el) {
    return el && el.isConnected && el.textContent !== undefined;
  }

  function handleTitle() {
    const s = core.settings;
    if (!s.youtube?.title) return;
    for (const h1 of document.querySelectorAll(TITLE_SEL)) {
      const inner = h1.querySelector('yt-formatted-string') || h1;
      const text = sourceText(inner);
      if (text) core.queue(inner, text, (h, t, _s, lang) => renderTitle(h1, t, lang));
    }
  }

  function handleDesc() {
    const s = core.settings;
    if (!s.youtube?.description) return;
    for (const el of document.querySelectorAll(DESC_SEL)) {
      const text = sourceText(el);
      if (text) core.queue(el, text, renderPlain);
    }
  }

  function handleComments(root = document) {
    const s = core.settings;
    if (!s.youtube?.comments) return;
    for (const el of root.querySelectorAll(COMMENT_SEL)) {
      const text = sourceText(el);
      if (text) core.queue(el, text, renderPlain);
    }
  }

  function handleCards(root = document) {
    const s = core.settings;
    if (!s.youtube?.cards) return;
    for (const el of root.querySelectorAll(CARD_SEL)) {
      // 只处理最外层锚点：内层 yt-formatted-string#video-title 会跟着外层一起翻
      if (el.tagName !== 'A' && el.closest('a')) continue;
      const text = sourceText(el);
      if (text) core.queue(el, text, renderCard);
    }
  }

  function renderShortsPlayerTitle(host, translated, lang) {
    if (!host.isConnected) return null;
    let el = host.nextElementSibling;
    if (!el || !el.classList?.contains('xt-translation')) {
      el = document.createElement('div');
      el.className = 'xt-translation xt-yt-shorts-title';
      el.setAttribute('dir', 'auto');
      host.insertAdjacentElement('afterend', el);
    }
    el.textContent = translated;
    core.setLang(el, lang);
    applyTooltip(el, translated, false);
    return el;
  }

  function handleShortsPlayerTitle() {
    const s = core.settings;
    if (!s.youtube?.cards) return;
    for (const h1 of document.querySelectorAll(SHORTS_TITLE_SEL)) {
      const host = h1.closest('yt-shorts-video-title-view-model') || h1;
      if (!host.isConnected) continue;
      const text = sourceText(h1);
      if (text) core.queue(host, text, (_h, t, _s, lang) => renderShortsPlayerTitle(host, t, lang));
    }
  }

  function scanAll() {
    const s = core.settings;
    if (!s.enabled || !s.youtube?.enabled) return;
    handleTitle();
    handleDesc();
    handleComments();
    handleCards();
    handleShortsPlayerTitle();
  }

  function scanNodes(nodes) {
    const s = core.settings;
    if (!s.enabled || !s.youtube?.enabled) return;
    for (const n of nodes) {
      if (n.nodeType !== 1) continue;
      if (s.youtube.comments && (n.matches?.(COMMENT_SEL) || n.querySelector(COMMENT_SEL))) {
        handleComments(n);
      }
      if (s.youtube.cards && (n.matches?.(CARD_SEL) || n.querySelector(CARD_SEL))) {
        handleCards(n);
      }
      if (s.youtube.cards && (n.matches?.(SHORTS_TITLE_SEL) || n.querySelector?.(SHORTS_TITLE_SEL))) {
        handleShortsPlayerTitle();
      }
    }
  }

  /* ---------------------------- 字幕 ---------------------------- */
  // 思路：轮询 .ytp-caption-segment 的完整文本，等它稳定 350ms 后再翻译，
  // 避免 YouTube 逐词吐出字幕时产生大量半句请求。
  // 译文以独立浮层叠在原字幕上方，不改动 YouTube 的 DOM 文本。

  const cap = {
    text: '',
    changedAt: 0,
    queued: '',
    lastSeen: 0,
    seq: 0,
    timer: null,
    running: false
  };

  function captionOverlay() {
    let el = document.querySelector('.xt-caption-overlay');
    if (el && el.isConnected) return el;
    const host = document.querySelector('.html5-video-player') || document.body;
    el = document.createElement('div');
    el.className = 'xt-caption-overlay';
    el.setAttribute('dir', 'auto');
    el.setAttribute('translate', 'no');
    host.appendChild(el);
    el.style.setProperty('--xt-cap-size', `${core.settings.youtube?.captionSize || 24}px`);
    return el;
  }

  function showCaption(text) {
    const el = captionOverlay();
    el.textContent = text;
    el.classList.add('xt-visible');
    positionOverlay(el);
  }

  // 把译文贴到原生字幕窗口正上方，避免遮挡原文
  function positionOverlay(el) {
    const player = document.querySelector('.html5-video-player');
    const win = document.querySelector('.caption-window');
    if (!player || !win) return;
    const pr = player.getBoundingClientRect();
    const cr = win.getBoundingClientRect();
    if (!cr.height) return;
    const bottom = Math.max(4, Math.round(pr.bottom - cr.top + 6));
    el.style.bottom = bottom + 'px';
  }

  function hideCaption() {
    const el = document.querySelector('.xt-caption-overlay');
    if (el) {
      el.classList.remove('xt-visible');
      el.textContent = '';
    }
  }

  function currentCaptionText() {
    const segs = document.querySelectorAll('.ytp-caption-segment');
    if (!segs.length) return '';
    const parts = [];
    for (const s of segs) {
      const t = (s.textContent || '').trim();
      if (t) parts.push(t);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function tickCaption() {
    const s = core.settings;
    if (!s.enabled || !s.youtube?.enabled || !s.youtube?.captions) {
      hideCaption();
      return;
    }

    const text = currentCaptionText();

    if (!text) {
      // 句子之间的空档：译文保留 1.2 秒再撤，否则每句话之间都会闪一下
      if (cap.lastSeen && Date.now() - cap.lastSeen > 1200) {
        hideCaption();
        cap.lastSeen = 0;
        cap.text = '';
        cap.queued = '';
      }
      return;
    }

    cap.lastSeen = Date.now();

    if (text !== cap.text) {
      cap.text = text;
      cap.changedAt = Date.now();
      return;
    }
    // YouTube 是逐词吐字幕的，等它稳定 320ms 再翻译，避免翻译半句话
    if (Date.now() - cap.changedAt < 320) return;
    if (text === cap.queued) return;

    cap.queued = text;
    const mySeq = ++cap.seq;

    core
      .translateOne(text)
      .then((rec) => {
        if (!rec?.t) return;
        // 只有在没有更新字幕顶上来时才显示，避免旧句译文盖住新句
        if (mySeq !== cap.seq) return;
        if (!currentCaptionText()) return;
        // 字幕浮层是 pointer-events:none，悬停不了，所以不挂语言标签（会干扰阅读）
        showCaption(rec.t);
      })
      .catch(() => {});
  }

  function startCaptionLoop() {
    if (cap.running) return;
    cap.running = true;
    cap.timer = setInterval(tickCaption, 200);
  }

  /* ----------------------------- 启动 ----------------------------- */

  function boot() {
    const s = core.settings;
    if (!s.enabled || !s.youtube?.enabled) return;

    core.onIncremental(scanNodes);
    core.onRescan(scanAll);

    scanAll();
    setTimeout(scanAll, 600);
    setTimeout(scanAll, 2000);

    core.watchDom({ debounce: 130 });

    // YouTube 自己的 SPA 导航事件，比 URL 轮询更及时
    document.addEventListener('yt-navigate-finish', () => {
      setTimeout(scanAll, 300);
      setTimeout(scanAll, 1200);
      cap.text = '';
      cap.queued = '';
      hideCaption();
    });

    if (s.youtube?.captions) startCaptionLoop();
  }

  core.ready.then(boot);

  core.onSettings((s) => {
    if (s.enabled && s.youtube?.enabled) {
      scanAll();
      if (s.youtube?.captions) startCaptionLoop();
      else hideCaption();
    } else {
      hideCaption();
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'XT_PAGE_STATS') {
      sendResponse({
        ok: true,
        site: 'youtube',
        stats: core.stats(),
        boxes: document.querySelectorAll('.xt-translation').length,
        engines: core.engineStats(),
        captions: !!document.querySelector('.xt-caption-overlay.xt-visible')
      });
    }
    if (msg?.type === 'XT_RESCAN_NOW') {
      core.bumpGeneration();
      scanAll();
      sendResponse({ ok: true });
    }
  });
})();

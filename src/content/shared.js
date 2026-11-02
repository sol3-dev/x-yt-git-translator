/* =========================================================================
 * XT core —— X / YouTube 双语翻译的共享内核
 * -------------------------------------------------------------------------
 * 这个文件被注入到 X 和 YouTube 两个站点，负责：
 *   1. 设置读取与热更新（改设置不用刷新页面）
 *   2. 翻译请求的批量合并、去重、内存缓存
 *   3. 统一的调度器：状态去重 + 视口懒加载 + 结果过期校验
 *   4. DOM 变化监听（防抖 + 忽略自己插入的节点，避免自激循环）
 *
 * 关键设计：「结果过期校验」。
 * X 的时间线是虚拟滚动，DOM 节点会被复用去显示另一条推文。
 * 因此翻译结果是异步返回的，回来时必须校验 host 的源文本是否还是当初那一份，
 * 否则会把 A 推文的译文贴到 B 推文上。这是这类扩展最典型的 bug。
 * ========================================================================= */
(() => {
  const NS = (globalThis.__XT = globalThis.__XT || {});
  if (NS.core) return;

  const DEFAULTS = {
    enabled: true,
    targetLang: 'zh-CN',
    engine: 'auto',
    displayMode: 'bilingual',
    minLength: 2,
    skipSameLang: true,
    customSites: [],
    // 站点开关必须在这里也有默认值：否则后台消息还没回来时
    // `settings.youtube?.enabled` 是 undefined，整个站点会被误判为关闭。
    x: { enabled: true, tweets: true, profile: false },
    youtube: { enabled: true, title: true, description: true, comments: true, cards: true, captions: true, captionSize: 24 },
    github: { enabled: true, menu: true, readme: true, issues: true, commits: true }
  };

  let settings = { ...DEFAULTS };
  let generation = 0; // 设置变更 / 开关切换时递增，用于让旧结果失效
  const stat = { translated: 0, failed: 0, skipped: 0, requests: 0 };

  /* ------------------------------ 设置 ------------------------------ */

  const stateMap = new WeakMap(); // host -> { text, hash, status, box, gen }
  const observed = new Map(); // host -> runFn（交给 IntersectionObserver 的）
  const inflight = new Map(); // text -> Promise<string|null>
  const memCache = new Map(); // text -> translation
  const MEM_CACHE_MAX = 3000;

  let settingsListeners = [];

  // 失败节点的重试冷却时间
  const RETRY_COOLDOWN = 30000;

  async function loadSettings() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'XT_GET_SETTINGS' });
      if (res?.ok) settings = res.settings;
    } catch (e) {
      console.warn('[XT] 读取设置失败，使用默认值', e);
    }
    return settings;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const prev = settings;
    settings = changes.settings.newValue || settings;
    generation++;
    // 引擎 / 目标语言 / 显示模式变了，旧译文必须重来
    if (
      prev.targetLang !== settings.targetLang ||
      prev.engine !== settings.engine ||
      prev.displayMode !== settings.displayMode
    ) {
      memCache.clear();
      resetAll();
    }
    if (prev.enabled !== settings.enabled) {
      if (!settings.enabled) removeAllBoxes();
      else resetAll();
    }
    settingsListeners.forEach((fn) => {
      try {
        fn(settings);
      } catch {}
    });
  });

  /* ------------------------------ 工具 ------------------------------ */

  function hashText(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  function isVisible(el, margin = 350) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return r.bottom > -margin && r.top < window.innerHeight + margin;
  }

  // 粗略判断文本是否已经是目标语言（避免把中文再翻成中文）
  function detectScript(text) {
    const hira = (text.match(/[\u3040-\u309f]/g) || []).length;
    const kata = (text.match(/[\u30a0-\u30ff]/g) || []).length;
    const hangul = (text.match(/[\uac00-\ud7af]/g) || []).length;
    const han = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    if (hira + kata > 0) return 'ja';
    if (hangul > 0) return 'ko';
    if (han > 0 && han >= latin * 0.6) return 'zh';
    if (latin > 0) return 'latin';
    return 'other';
  }

  /**
   * 译文是不是原样返回了原文。
   * 后台已经拦了一道，这里是最后一道：万一缓存里还躺着旧记录，
   * 也不能把「和原文一模一样的灰字」画到页面上 —— 看起来就像没翻。
   * 忽略空白 / 标点 / 大小写 / emoji，只比可读字符。
   */
  function sameText(a, b) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
    const na = norm(a);
    return na.length > 0 && na === norm(b);
  }

  function isTargetText(text) {
    const t = settings.targetLang || 'zh-CN';
    const script = detectScript(text);
    if (t.startsWith('zh')) return script === 'zh';
    if (t.startsWith('ja')) return script === 'ja';
    if (t.startsWith('ko')) return script === 'ko';
    return false;
  }

  /* --------------------------- 翻译请求队列 --------------------------- */
  // 把 40ms 内产生的请求合成一批发给 background，
  // 这样滚动时 10 条推文只发 1~2 次消息，而不是 10 次。

  let batch = [];
  let batchTimer = null;
  // 站点语境：GitHub 这类站点的译文需要「技术术语保持原样」，
  // 由各适配层调用 setContext('github') 声明，随请求带到后台拼进提示词。
  let context = '';

  function scheduleFlush() {
    if (batchTimer) return;
    batchTimer = setTimeout(flushBatch, 40);
  }

  async function flushBatch() {
    batchTimer = null;
    if (!batch.length) return;
    // 16 → 10：单批小一点，首批译文能早 2~3 秒出现（并发和间隔不变，
    // 总请求速率不受影响，只是「一次出几条」变细了）
    const items = batch.splice(0, 10);
    const texts = items.map((i) => i.text);

    stat.requests++;
    let results = null;
    let langs = null;
    let engines = null;
    let error = null;
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'XT_TRANSLATE',
        texts,
        targetLang: settings.targetLang,
        engine: settings.engine,
        context
      });
      if (res?.ok) {
        results = res.results;
        langs = res.langs;
        engines = res.engines;
      } else error = new Error(res?.error || '翻译失败');
    } catch (e) {
      error = e;
    }

    items.forEach((it, i) => {
      const v = results?.[i];
      if (typeof v === 'string' && v) {
        // e = 这条译文实际出自哪个引擎（后台给的可读名：deepseek-flash / 本地模型 / Google…）
        const rec = { t: v, l: langs?.[i] || '', e: engines?.[i] || '' };
        memCache.set(it.text, rec);
        if (memCache.size > MEM_CACHE_MAX) {
          memCache.delete(memCache.keys().next().value);
        }
        it.resolve(rec);
      } else {
        it.resolve(null);
        if (error) stat.failed++;
      }
    });

    if (error) console.warn('[XT] 翻译请求失败', error.message);
    if (batch.length) scheduleFlush();
  }

  function translateOne(text) {
    const hit = memCache.get(text);
    if (hit) return Promise.resolve(hit);
    if (inflight.has(text)) return inflight.get(text);

    const p = new Promise((resolve) => {
      batch.push({ text, resolve });
      scheduleFlush();
    });
    inflight.set(text, p);
    p.finally(() => inflight.delete(text));
    return p;
  }

  /* ---------------------------- 调度器 ---------------------------- */

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const fn = observed.get(e.target);
        if (!fn) continue;
        observed.delete(e.target);
        io.unobserve(e.target);
        fn();
      }
    },
    { rootMargin: '400px 0px 400px 0px' }
  );

  /**
   * 取元素的「原文」。
   * ------------------------------------------------------------------
   * 必须排除我们自己插进去的 .xt-translation —— 这是个真实踩过的坑：
   * GitHub 的简介 / README 段落既是渲染宿主，又是下次扫描的文本来源。
   * 一旦直接读 textContent，第二次扫到的就是「原文 + 上一次的译文」，
   * 于是翻出来是「译文 + 译文」，重扫几次越叠越长（实测 About 描述变成
   * 「跨平台…模拟器。跨平台…新颖模拟」）。所有取源文本的地方统一走这里。
   */
  function sourceText(host) {
    if (!host) return '';
    let text;
    const boxes = host.querySelectorAll?.('.xt-translation');
    if (boxes?.length) {
      const clone = host.cloneNode(true);
      clone.querySelectorAll?.('.xt-translation').forEach((n) => n.remove());
      text = clone.textContent || '';
    } else {
      text = host.textContent || '';
    }
    return String(text).replace(/\s+/g, ' ').trim();
  }

  /**
   * 把一段元素登记为「待翻译」。
   * @param {Element} host   承载译文的元素
   * @param {string}  text   源文本（已归一化）
   * @param {(host, translated, source, lang) => void} render 渲染回调
   * @param {object}  opts   { force: boolean 忽略视口懒加载 }
   */
  function queue(host, text, render, opts = {}) {
    if (!settings.enabled) return;
    if (!host || !host.isConnected) return;
    if (!text || text.length < (settings.minLength || 2)) return;

    const h = hashText(text);
    const prev = stateMap.get(host);

    // 同一个 host 同一份文本，已经处理过就不再重复
    if (prev && prev.hash === h && prev.gen === generation) {
      if (prev.status === 'done') {
        // YouTube 等框架会重渲染宿主节点，把注入的译文一起清掉。
        // 这里校验译文容器是否还挂在 DOM 上，没了就补一次（翻译走缓存，几乎零成本）。
        if (!prev.box || prev.box.isConnected) return;
      } else if (prev.status === 'running' || prev.status === 'pending') {
        return;
      } else if (prev.status === 'error' && Date.now() - (prev.errorAt || 0) < RETRY_COOLDOWN) {
        return;
      }
    }

    if (settings.skipSameLang !== false && isTargetText(text)) {
      if (prev?.box) prev.box.remove();
      stateMap.set(host, { hash: h, text, status: 'skip', gen: generation, box: null });
      stat.skipped++;
      return;
    }

    const st = { hash: h, text, status: 'pending', gen: generation, box: prev?.box || null };
    stateMap.set(host, st);

    const run = async () => {
      if (st.gen !== generation) return; // 设置已变，放弃
      st.status = 'running';
      let out = null;
      try {
        out = await translateOne(text);
      } catch {
        out = null;
      }
      if (!out) {
        st.status = 'error';
        st.errorAt = Date.now();
        stat.failed++;
        return;
      }

      // 原样返回：不渲染。页面上少一行灰字，比多一行「假译文」好。
      if (sameText(out.t, text)) {
        st.status = 'skip';
        stat.skipped++;
        return;
      }
      if (st.gen !== generation) return;

      // ★ 过期校验：X 的虚拟滚动可能已经把这个节点换成了别的推文
      const cur = stateMap.get(host);
      if (cur !== st && cur?.text !== text) return;
      if (!host.isConnected) return;

      try {
        const boxEl = render(host, out.t, text, out.l);
        stampEngine(boxEl, out.e);
        if (boxEl === null) {
          // 渲染时宿主已经失效（页面重渲染），标记为 stale 让后续扫描重试
          st.status = 'stale';
          st.box = null;
          return;
        }
        st.box = boxEl || st.box;
        st.status = 'done';
        stat.translated++;
      } catch (e) {
        st.status = 'error';
        st.errorAt = Date.now();
        console.warn('[XT] 渲染译文失败', e);
      }
    };

    if (opts.force || isVisible(host)) {
      run();
    } else {
      observed.set(host, run);
      io.observe(host);
    }
  }

  /* --------------------------- 渲染工具 --------------------------- */

  const LANG_NAMES = {
    en: '英语', ja: '日语', ko: '韩语', fr: '法语', de: '德语', es: '西班牙语',
    pt: '葡萄牙语', it: '意大利语', ru: '俄语', ar: '阿拉伯语', th: '泰语',
    zh: '中文', nl: '荷兰语', vi: '越南语', tr: '土耳其语', pl: '波兰语',
    id: '印尼语', hi: '印地语', sv: '瑞典语', da: '丹麦语', fi: '芬兰语',
    no: '挪威语', cs: '捷克语', el: '希腊语', he: '希伯来语', uk: '乌克兰语',
    fa: '波斯语', ms: '马来语', ro: '罗马尼亚语', hu: '匈牙利语'
  };

  /**
   * 源语言标签文案。
   * 只写进 data-xt-lang，由 CSS ::after 在悬停时显示 —— 伪元素的内容
   * 不参与选区、不会被复制，所以「选中译文复制」仍然是干净的纯译文。
   */
  function langLabel(code) {
    if (!code) return '';
    const c = String(code).toLowerCase().split('-')[0];
    if (!c || c === 'und' || c === 'auto') return '';
    return '译自 ' + (LANG_NAMES[c] || c.toUpperCase());
  }

  function setLang(el, code) {
    const label = langLabel(code);
    if (label) el.dataset.xtLang = label;
    else delete el.dataset.xtLang;
  }

  /**
   * 把「这条是谁翻的」写到节点上。
   * 自动模式会依次尝试多个引擎（Key → 本地模型 → Google → MyMemory），
   * 光看页面根本分不清某条出自哪个。这里做两件事：
   *   1. data-xt-engine 存来源，弹窗按它统计；
   *   2. 把来源追加进悬停标签：『译自 法语 · deepseek-flash』。
   */
  function stampEngine(el, engineName) {
    if (!el || !engineName || !el.dataset) return;
    el.dataset.xtEngine = engineName;
    const cur = el.dataset.xtLang;
    if (cur && !cur.includes('·')) el.dataset.xtLang = `${cur} · ${engineName}`;
    // YouTube 的卡片/标题走原生提示，里面也补上引擎名，保持一致
    if (cur && el.title && el.title.startsWith(cur)) {
      el.title = `${cur} · ${engineName}` + el.title.slice(cur.length);
    }
  }

  /** 本页译文来源分布：{ 'deepseek-flash': 12, '本地模型': 3 } */
  function engineStats() {
    const out = {};
    for (const el of document.querySelectorAll('.xt-translation[data-xt-engine]')) {
      const e = el.dataset.xtEngine;
      if (!e) continue;
      out[e] = (out[e] || 0) + 1;
    }
    return out;
  }

  /**
   * 在 host 内部末尾取（或创建）一个译文容器。
   */
  function box(host, className = '') {
    let el = host.querySelector(':scope > .xt-translation');
    if (!el) {
      el = document.createElement('div');
      el.className = 'xt-translation' + (className ? ' ' + className : '');
      el.setAttribute('dir', 'auto');
      el.setAttribute('translate', 'no');
      host.appendChild(el);
    }
    return el;
  }

  function applyDisplayMode(host) {
    const mode = settings.displayMode || 'bilingual';
    host.setAttribute('data-xt-mode', mode);
    if (mode === 'replace' && !host.style.getPropertyValue('--xt-fs')) {
      const fs = getComputedStyle(host).fontSize;
      if (fs) host.style.setProperty('--xt-fs', fs);
    }
  }

  /**
   * 默认渲染：双语对照 / 行内追加 / 替换原文
   */
  function render(host, translated, source, className = '', lang = '') {
    applyDisplayMode(host);
    const el = box(host, className);
    el.textContent = translated;
    el.dataset.xtSrc = source.slice(0, 40);
    setLang(el, lang);

    // 行内 / 替换模式没有分割线，标签画上去必然压字 → 改用原生悬停提示。
    // 双语对照模式有 border-top 分割线，标签挂在线的左端，不动 DOM。
    const mode = host.getAttribute('data-xt-mode');
    if (mode === 'inline' || mode === 'replace') {
      if (el.dataset.xtLang) el.title = `${el.dataset.xtLang}\n${translated}`;
      else el.removeAttribute('title');
    }
    return el;
  }

  function removeAllBoxes() {
    document.querySelectorAll('.xt-translation').forEach((n) => n.remove());
    document.querySelectorAll('[data-xt-mode]').forEach((n) => n.removeAttribute('data-xt-mode'));
  }

  function resetAll() {
    removeAllBoxes();
    // WeakMap 无法清空，用 generation 让所有旧状态失效
    observed.clear();
    io.disconnect();
    dispatchRescan();
  }

  /* --------------------------- DOM 监听 --------------------------- */

  let rescanFns = [];

  function dispatchRescan() {
    rescanFns.forEach((fn) => {
      try {
        fn();
      } catch (e) {
        console.warn('[XT] rescan 出错', e);
      }
    });
  }

  function isOwnNode(node) {
    if (!node) return false;
    if (node.nodeType === 1) {
      if (node.classList?.contains('xt-translation')) return true;
      if (node.closest?.('.xt-translation')) return true;
    } else if (node.nodeType === 3) {
      return !!node.parentElement?.closest?.('.xt-translation');
    }
    return false;
  }

  const pendingMutations = new Set();
  let debounceTimer = null;

  function processMutations() {
    debounceTimer = null;
    const added = [...pendingMutations];
    pendingMutations.clear();
    // 先做增量处理（快），再兜底全量扫描（由各站点自己决定是否需要）
    for (const fn of incrementalFns) {
      try {
        fn(added);
      } catch (e) {
        console.warn('[XT] 增量处理出错', e);
      }
    }
    dispatchRescan();
  }

  const incrementalFns = [];

  function watchDom({ debounce = 110 } = {}) {
    const mo = new MutationObserver((muts) => {
      let relevant = false;
      for (const m of muts) {
        if (isOwnNode(m.target)) continue;
        if (m.type === 'childList') {
          let hasReal = false;
          for (const n of m.addedNodes) {
            if (!isOwnNode(n)) {
              hasReal = true;
              break;
            }
          }
          if (!hasReal) continue;
          for (const n of m.addedNodes) if (n.nodeType === 1) pendingMutations.add(n);
        } else if (m.type === 'characterData') {
          // 文本内容变了（X 复用节点时常见）
        }
        relevant = true;
      }
      if (!relevant) return;
      if (debounceTimer) return;
      debounceTimer = setTimeout(processMutations, debounce);
    });

    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // SPA 路由切换兜底
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(dispatchRescan, 400);
      }
    }, 1000);

    // 低频兜底扫描：网络抖动导致翻译失败的节点，在这里被自动重试补上。
    // 已完成的节点只做一次指纹比对，不会重复发请求。
    setInterval(() => {
      if (settings.enabled) dispatchRescan();
    }, 15000);
  }

  /* ---------------------------- 对外 API ---------------------------- */

  NS.core = {
    get settings() {
      return settings;
    },
    get generation() {
      return generation;
    },
    ready: null, // 由各站点脚本 await
    queue,
    render,
    box,
    sourceText,
    applyDisplayMode,
    setLang,
    langLabel,
    stampEngine,
    engineStats,
    setContext(ctx) {
      context = String(ctx || '');
    },
    translateOne,
    watchDom,
    isVisible,
    isTargetText,
    detectScript,
    hashText,
    resetAll,
    removeAllBoxes,
    onRescan(fn) {
      rescanFns.push(fn);
    },
    onIncremental(fn) {
      incrementalFns.push(fn);
    },
    onSettings(fn) {
      settingsListeners.push(fn);
    },
    stats() {
      return { ...stat };
    },
    bumpGeneration() {
      generation++;
    }
  };

  NS.core.ready = loadSettings();
})();

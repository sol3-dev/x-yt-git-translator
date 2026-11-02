const $ = (id) => document.getElementById(id);

let settings = null;
let currentTab = null;
let siteInfo = null;
let statsTimer = null;

const SITE_LABEL = {
  x: 'X（Twitter）',
  youtube: 'YouTube',
  github: 'GitHub'
};

const ENGINE_NAME = {
  auto: '自动',
  google: 'Google',
  mymemory: 'MyMemory',
  openai: 'OpenAI',
  builtin: '本地翻译'
};

/* --------------------------- 当前站点判定 --------------------------- */

function classify(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '');
  if (/(^|\.)(x|twitter)\.com$/.test(host)) return { kind: 'x', host };
  if (/(^|\.)youtube\.com$/.test(host)) return { kind: 'youtube', host };
  if (/(^|\.)github\.com$/.test(host)) return { kind: 'github', host };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const sites = settings?.customSites || [];
  const on = sites.some((s) => s && (host === s || host.endsWith('.' + s)));
  return { kind: 'custom', host, on };
}

function paintSite() {
  const card = $('siteCard');
  const btn = $('toggleSite');

  if (!siteInfo || siteInfo.kind !== 'custom') {
    card.hidden = true;
    return;
  }

  card.hidden = false;
  $('siteLabel').textContent = siteInfo.host;
  btn.textContent = siteInfo.on ? '已启用' : '翻译此网站';
  btn.classList.toggle('on', !!siteInfo.on);
  btn.title = siteInfo.on ? '点击移除本站（会刷新页面）' : '添加后访问该域名自动翻译';
}

/* ------------------------------ 网络探测 ------------------------------ */

/** Google 是否正处于「被判定为代理」的冷却里 */
async function googleBlocked() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'XT_HEALTH' });
    const g = res?.health?.google;
    return !!g && g.active && g.ok === false && g.kind === 'ratelimit';
  } catch {
    return false;
  }
}

async function refreshProbe(force = false) {
  const el = $('probeText');
  if (force) {
    el.textContent = '探测中…';
    el.className = 'probe';
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: 'XT_PROBE', force });
    const p = res?.probe;
    if (!p) {
      el.textContent = '尚未探测';
      el.className = 'probe';
      return;
    }
    if (p.google) {
      // 注意：这只说明网络能连到 Google（gstatic 204 通了），不代表 Google
      // *愿意提供翻译*。出口 IP 被判定为代理时，网络照样通，翻译接口却返回
      // 429 / 人机验证页 —— 所以要结合引擎健康状态一起说，别自相矛盾。
      const g = await googleBlocked();
      if (g) {
        el.textContent = '网络正常，但 Google 拒绝翻译（见下方）';
        el.className = 'probe bad';
      } else {
        el.textContent = p.slow ? `网络较慢（Google ${p.ms}ms）` : `网络正常（Google ${p.ms}ms）`;
        el.className = 'probe ok';
      }
    } else {
      el.textContent = 'Google 不可达 · 走备用引擎';
      el.className = 'probe bad';
    }
  } catch {
    el.textContent = '探测失败';
    el.className = 'probe bad';
  }
}

/* --------------------------- 引擎健康提示 --------------------------- */

// 失败类型 → 人话。reason 里已经有引擎给的细节时优先用 reason。
function whyBad(v) {
  const r = String(v?.reason || '');
  switch (v?.kind) {
    case 'ratelimit':
      return /Google/.test(r) ? '被判定为代理流量' : '触发限流';
    case 'auth':
      return 'Key 被拒绝（401/403），检查是否填错或已失效';
    case 'nokey':
      return '未填写 Key';
    case 'gesture':
      return '本地模型未下载，去设置页点一次「下载本地模型」';
    case 'network':
      return '连接超时';
    case 'empty':
      return '返回为空';
    default:
      return r.replace(/^MyMemory\s*/, '') || '不可用';
  }
}

async function refreshHealth() {
  const box = $('health');
  const text = $('healthText');
  let lastErr = '';
  try {
    const raw = await chrome.storage.local.get('xt_last_err_v1');
    const e = raw?.xt_last_err_v1;
    // 只在 30 分钟内的错误算「最近」，老错误别拿来吓人
    if (e && Date.now() - e.at < 30 * 60 * 1000) {
      lastErr = String(e.msg || '').replace(/^所有引擎均失败 —— /, '').slice(0, 120);
    }
  } catch {}
  try {
    const res = await chrome.runtime.sendMessage({ type: 'XT_HEALTH' });
    const health = res?.health || {};
    const order = ['google', 'mymemory', 'openai', 'builtin'];
    const bad = Object.entries(health)
      .filter(([, v]) => v && v.active && v.ok === false)
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));

    if (!bad.length) {
      box.hidden = true;
      return;
    }

    // 三件套全挂 = 换节点 / 填 Key 的时候了，这时候不该只说某一个引擎
    if (bad.length >= 3) {
      const brief = bad.map(([n, v]) => `${ENGINE_NAME[n] || n} ${whyBad(v)}`).join('，');
      const hasKey = !!settings.openai?.apiKey;
      // 已经配了 Key 还说「填个 Key」纯属误导 —— 这时该看真实错误
      const tail = hasKey
        ? lastErr
          ? `。最近一次错误：${lastErr}。点 `
          : '。点 '
        : '。换个代理节点或填一个 API Key，然后点 ';
      text.textContent = `所有引擎都不可用：${brief}${tail}`;
    } else {
      const [name, info] = bad[0];
      const mins = Math.max(1, Math.ceil((info.until - Date.now()) / 60000));
      const wait = mins >= 60 ? `约 ${Math.round(mins / 60)} 小时后` : `约 ${mins} 分钟后`;
      text.textContent = `${ENGINE_NAME[name] || name} 暂时跳过（${whyBad(info)}），${wait}自动重试。也可以现在 `;
    }
    box.hidden = false;
  } catch {
    box.hidden = true;
  }
}

/* ------------------------------ 数据读写 ------------------------------ */

async function savePatch(patch) {
  const res = await chrome.runtime.sendMessage({ type: 'XT_SET_SETTINGS', patch });
  if (res?.ok) settings = res.settings;
  return settings;
}

function paintMode(mode) {
  for (const b of document.querySelectorAll('#modeGroup button')) {
    b.classList.toggle('on', b.dataset.mode === mode);
  }
}

/**
 * 「自动」到底是按什么顺序挑引擎。
 * 之前只有选项名，配了 Key 却看到译文质量没变，会怀疑扩展没在用 Key ——
 * 这里直接把顺序写出来，一眼可核对。规则见 engines.js 的 autoOrder()。
 */
function paintEngineHint(engine) {
  const el = $('engineHint');
  if (!el) return;
  if ((engine || settings.engine || 'auto') !== 'auto') {
    el.hidden = true;
    return;
  }
  const hasKey = !!settings.openai?.apiKey;
  const model = (settings.openai?.model || '').trim();
  el.innerHTML = hasKey
    ? `自动顺序：<b>${model || 'OpenAI 兼容'}（你的 Key）</b> → 本地模型 → Google → MyMemory。<br>
       Key 引擎永远第一，只有它失败或漏翻的部分才交给后面补。`
    : `自动顺序：本地模型 → Google → MyMemory。<br>
       还没填 Key —— 填了之后它会自动排到<b>第一位</b>。`;
  el.hidden = false;
}

async function refreshStats() {
  if (!currentTab?.id) return;
  try {
    const res = await chrome.tabs.sendMessage(currentTab.id, { type: 'XT_PAGE_STATS' });
    if (!res?.ok) return;
    $('cntBoxes').textContent = res.boxes ?? 0;
    $('cntReq').textContent = res.stats?.requests ?? 0;
    $('cntFail').textContent = res.stats?.failed ?? 0;
    paintEngineUse(res.engines || {});
  } catch {
    // 页面没有 content script（刚装扩展没刷新），忽略
  }
}

/**
 * 「本页译文实际来自谁」。
 * 自动模式会在多个引擎间切换，页面肉眼分不出差别 —— 这里按条统计写出来，
 * 悬停译文时标签上也会带引擎名（译自 法语 · deepseek-flash）。
 */
function paintEngineUse(map) {
  const el = $('engineUse');
  if (!el) return;
  const list = Object.entries(map).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!list.length) {
    el.hidden = true;
    return;
  }
  el.innerHTML =
    '本页译文来源：' +
    list.map(([name, n]) => `<b>${name}</b> ${n} 条`).join(' · ') +
    '<br>鼠标停在译文上可看到单条的来源。';
  el.hidden = false;
}

function startStatsLoop() {
  if (statsTimer) clearInterval(statsTimer);
  refreshStats();
  refreshHealth();
  statsTimer = setInterval(() => {
    refreshStats();
    refreshHealth();
  }, 2500);
}

/* --------------------------- 注入到当前页 --------------------------- */

async function injectCurrent() {
  if (!currentTab?.id) return false;
  try {
    await chrome.scripting.insertCSS({
      target: { tabId: currentTab.id },
      files: ['src/content/content.css']
    });
  } catch {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      files: ['src/content/shared.js', 'src/content/generic.js']
    });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------- 初始化 ------------------------------- */

async function init() {
  const res = await chrome.runtime.sendMessage({ type: 'XT_GET_SETTINGS' });
  settings = res?.settings || {};

  $('enabled').checked = !!settings.enabled;
  $('engine').value = settings.engine || 'auto';
  $('targetLang').value = settings.targetLang || 'zh-CN';
  paintMode(settings.displayMode || 'bilingual');
  paintEngineHint(settings.engine || 'auto');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  siteInfo = classify(tab?.url || '');

  paintSite();
  refreshProbe(false);

  if (!siteInfo) {
    $('status').textContent = '当前页面不受支持';
    $('status').className = 'status inactive';
  } else if (!settings.enabled) {
    $('status').textContent = `${SITE_LABEL[siteInfo.kind] || siteInfo.host} · 已暂停`;
    $('status').className = 'status inactive';
  } else if (siteInfo.kind === 'custom' && !siteInfo.on) {
    $('status').textContent = `${siteInfo.host} · 未添加`;
    $('status').className = 'status inactive';
  } else {
    $('status').textContent = `${SITE_LABEL[siteInfo.kind] || siteInfo.host} · 运行中`;
    $('status').className = 'status active';
    startStatsLoop();
  }
}

/* ------------------------------ 交互 ------------------------------ */

$('enabled').addEventListener('change', async (e) => {
  await savePatch({ enabled: e.target.checked });
  location.reload();
});

$('engine').addEventListener('change', async (e) => {
  settings.engine = e.target.value;
  paintEngineHint(e.target.value);
  await savePatch({ engine: e.target.value });
  // 换了引擎，缓存键不同，让内容脚本重扫
  if (currentTab?.id) chrome.tabs.sendMessage(currentTab.id, { type: 'XT_RESCAN_NOW' }).catch(() => {});
});

$('targetLang').addEventListener('change', async (e) => {
  await savePatch({ targetLang: e.target.value });
});

$('modeGroup').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  paintMode(btn.dataset.mode);
  await savePatch({ displayMode: btn.dataset.mode });
});

$('reprobe').addEventListener('click', () => refreshProbe(true));

// 换节点 / 换 Key 之后清掉所有引擎冷却，立即重试
$('healthRetry').addEventListener('click', async () => {
  const btn = $('healthRetry');
  btn.disabled = true;
  btn.textContent = '重试中…';
  try {
    await chrome.runtime.sendMessage({ type: 'XT_HEALTH_RESET' });
    if (currentTab?.id) {
      chrome.tabs.sendMessage(currentTab.id, { type: 'XT_RESCAN_NOW' }).catch(() => {});
    }
  } catch {}
  // 重扫和重新请求要几秒，交给 2.5 秒的轮询去刷新结论
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = '立即重试';
  }, 2500);
});

$('toggleSite').addEventListener('click', async () => {
  if (siteInfo?.kind !== 'custom' || !currentTab?.id) return;
  const h = siteInfo.host;
  const sites = settings.customSites || [];
  const wasOn = siteInfo.on;

  const next = wasOn ? sites.filter((s) => !(h === s || h.endsWith('.' + s))) : [...sites, h];

  await savePatch({ customSites: next });
  siteInfo.on = !wasOn;
  paintSite();

  if (wasOn) {
    // 移除后要把已插入的译文清掉，最省事的方式是刷新
    chrome.tabs.reload(currentTab.id);
    window.close();
    return;
  }

  // 添加后立即注入，省掉手动刷新
  $('status').textContent = `${h} · 正在启用…`;
  $('status').className = 'status active';
  const ok = await injectCurrent();
  if (!ok) {
    chrome.tabs.reload(currentTab.id);
    window.close();
    return;
  }
  $('status').textContent = `${h} · 运行中`;
  startStatsLoop();
});

$('rescan').addEventListener('click', async () => {
  if (!currentTab?.id) return;
  try {
    await chrome.tabs.sendMessage(currentTab.id, { type: 'XT_RESCAN_NOW' });
    $('rescan').textContent = '已重新扫描';
    setTimeout(() => ($('rescan').textContent = '重新扫描本页'), 1200);
  } catch {
    // 页面未注入时，尝试重新加载
    chrome.tabs.reload(currentTab.id);
  }
});

$('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

window.addEventListener('unload', () => clearInterval(statsTimer));

init();

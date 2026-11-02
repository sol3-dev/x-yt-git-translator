const $ = (id) => document.getElementById(id);

const ENGINE_HINT = {
  microsoft: '无需配置，开箱可用。支持批量请求，延迟最低。',
  google: '无需配置。国内网络通常需要代理才能访问。',
  openai: '需要在下方填写 Base URL 与 API Key，并授权访问该域名。',
  builtin:
    '使用 Chrome 138+ 的本地翻译模型：完全离线、不限额度、不受代理节点 IP 被风控的影响。首次使用需在上面点一次「下载全部本地模型」——浏览器规定模型下载必须由点击手势触发。'
};

/* 表单字段 → 设置路径 */
const FIELDS = [
  { id: 'enabled', path: 'enabled', type: 'bool' },
  { id: 'engine', path: 'engine', type: 'value' },
  { id: 'targetLang', path: 'targetLang', type: 'value' },
  { id: 'skipSameLang', path: 'skipSameLang', type: 'bool' },
  { id: 'xEnabled', path: 'x.enabled', type: 'bool' },
  { id: 'xProfile', path: 'x.profile', type: 'bool' },
  { id: 'ytEnabled', path: 'youtube.enabled', type: 'bool' },
  { id: 'ytTitle', path: 'youtube.title', type: 'bool' },
  { id: 'ytDesc', path: 'youtube.description', type: 'bool' },
  { id: 'ytComments', path: 'youtube.comments', type: 'bool' },
  { id: 'ytCards', path: 'youtube.cards', type: 'bool' },
  { id: 'ytCaptions', path: 'youtube.captions', type: 'bool' },
  { id: 'ytCaptionSize', path: 'youtube.captionSize', type: 'number' },
  { id: 'ghEnabled', path: 'github.enabled', type: 'bool' },
  { id: 'ghMenu', path: 'github.menu', type: 'bool' },
  { id: 'ghReadme', path: 'github.readme', type: 'bool' },
  { id: 'ghCommits', path: 'github.commits', type: 'bool' },
  { id: 'oaBase', path: 'openai.baseUrl', type: 'value' },
  { id: 'oaKey', path: 'openai.apiKey', type: 'value' },
  { id: 'oaModel', path: 'openai.model', type: 'value' }
];

let settings = {};
let saveTimer = null;

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function makePatch(path, value) {
  const parts = path.split('.');
  const patch = {};
  let cur = patch;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return patch;
}

function paintMode(mode) {
  for (const b of document.querySelectorAll('#modeGroup button')) {
    b.classList.toggle('on', b.dataset.mode === mode);
  }
}

function setSaveState(text) {
  $('saveState').textContent = text;
}

async function save(patch) {
  const res = await chrome.runtime.sendMessage({ type: 'XT_SET_SETTINGS', patch });
  if (res?.ok) {
    settings = res.settings;
    setSaveState('已保存 ' + new Date().toLocaleTimeString());
  } else {
    setSaveState('保存失败：' + (res?.error || '未知错误'));
  }
}

function scheduleSave(patch) {
  setSaveState('保存中…');
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(patch), 280);
}

/* ---------------------------- 初始化 ---------------------------- */

async function init() {
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;

  const res = await chrome.runtime.sendMessage({ type: 'XT_GET_SETTINGS' });
  settings = res?.settings || {};

  for (const f of FIELDS) {
    const el = $(f.id);
    if (!el) continue;
    const v = getPath(settings, f.path);
    if (f.type === 'bool') el.checked = !!v;
    else el.value = v ?? '';
  }

  paintMode(settings.displayMode || 'bilingual');
  $('capSizeVal').textContent = `${settings.youtube?.captionSize || 24} px`;
  $('engineHint').textContent = ENGINE_HINT[settings.engine] || '';

  renderSites();
  refreshCache();
}

/* ------------------------ 已添加的网站列表 ------------------------ */

function renderSites() {
  const list = $('siteList');
  const sites = settings.customSites || [];
  list.textContent = '';
  $('siteEmpty').hidden = sites.length > 0;

  for (const s of sites) {
    const row = document.createElement('div');
    row.className = 'site-item';

    const name = document.createElement('span');
    name.className = 'host';
    name.textContent = s;
    name.title = s;

    const btn = document.createElement('button');
    btn.textContent = '移除';
    btn.addEventListener('click', async () => {
      const next = (settings.customSites || []).filter((x) => x !== s);
      btn.disabled = true;
      await save({ customSites: next });
      renderSites();
    });

    row.append(name, btn);
    list.append(row);
  }
}

async function refreshCache() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'XT_CACHE_STATS' });
    $('cacheCount').textContent = res?.ok ? `${res.size ?? 0} 条` : '—';
  } catch {
    $('cacheCount').textContent = '—';
  }
}

/* ---------------------------- 事件绑定 ---------------------------- */

for (const f of FIELDS) {
  const el = $(f.id);
  if (!el) continue;

  if (f.type === 'bool') {
    el.addEventListener('change', () => {
      scheduleSave(makePatch(f.path, el.checked));
    });
  } else if (f.id === 'ytCaptionSize') {
    el.addEventListener('input', () => {
      $('capSizeVal').textContent = `${el.value} px`;
      scheduleSave(makePatch(f.path, Number(el.value)));
    });
  } else {
    el.addEventListener('change', () => {
      if (f.id === 'engine') $('engineHint').textContent = ENGINE_HINT[el.value] || '';
      scheduleSave(makePatch(f.path, el.value));
    });
  }
}

$('modeGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  paintMode(btn.dataset.mode);
  scheduleSave({ displayMode: btn.dataset.mode });
});

/* 授权 OpenAI 自定义域名 */
$('grantOrigin').addEventListener('click', async () => {
  let origin;
  try {
    origin = new URL($('oaBase').value.trim()).origin;
  } catch {
    showResult('err', '请先填写合法的 Base URL，例如 https://api.deepseek.com/v1');
    return;
  }
  const pattern = origin + '/*';
  try {
    // 扩展已是全站授权（host_permissions 含 <all_urls>），这里只是确认状态，
    // 不再调用 request —— 请求一个必需权限会被 Chrome 直接拒绝。
    const granted = await chrome.permissions.contains({ origins: [pattern] });
    showResult(
      granted ? 'ok' : 'err',
      granted
        ? `已授权访问 ${pattern}（全站授权已覆盖，可直接使用）`
        : `未覆盖 ${pattern}，该域名无法直接请求；请换用 DeepSeek 等已在白名单内的地址`
    );
  } catch (e) {
    showResult('err', '检查授权失败：' + (e.message || e));
  }
});

/* 测试引擎 */
$('testEngine').addEventListener('click', async () => {
  const engine = $('engine').value;
  showResult('', '测试中…');
  const msg = { type: 'XT_TEST_ENGINE', engine, text: 'Hello world, this is a translation test.' };
  if (engine === 'openai') {
    msg.openai = { baseUrl: $('oaBase').value.trim(), apiKey: $('oaKey').value.trim(), model: $('oaModel').value.trim() };
  }
  try {
    const res = await chrome.runtime.sendMessage(msg);
    if (res?.ok) {
      showResult('ok', `引擎：${res.engine}\n耗时：${res.ms} ms\n译文：${res.output}`);
    } else {
      showResult('err', `引擎：${res?.engine || engine}\n失败：${res?.error || '未知错误'}`);
    }
  } catch (e) {
    showResult('err', '请求失败：' + (e.message || e));
  }
});

function showResult(kind, text) {
  const el = $('testResult');
  el.className = 'result show' + (kind ? ' ' + kind : '');
  el.textContent = text;
}

/* 下载 Chrome 内置翻译模型
 * ---------------------------------------------------------------------------
 * 为什么不能「后台自动下载」：Chrome 要求模型下载必须由点击手势触发，
 * 扩展的 service worker / offscreen 没有手势，create() 直接抛
 *   "Requires a user gesture when availability is 'downloading' or 'downloadable'"
 * 所以必须由这个页面上的真实点击来拉。
 *
 * 实测（Chrome 156，2026-10-28）：
 *   - en→zh 下载只用了约 5 秒，92% 后完成 —— 走 update.googleapis.com，没被墙
 *   - 每个语言对是独立模型，下完 en→zh 之后 es→zh 仍是 downloadable
 *   - 但同一次点击之后，本页面内后续 create() 不再要求手势（sticky activation），
 *     所以一次点击就能把常用语言对全部拉下来
 */
/**
 * 候选语言池：不猜「浏览器支持哪些」，交给 availability() 自己回答。
 * 以前这里是手写的 20 个，漏了印地语（hi）——
 * 结果刷到印地语推文时 hi→zh 是 downloadable，代码当成「整体没下模型」，
 * 把本地引擎冷却 30 分钟，整个页面都不翻了。这类问题靠人工枚举永远补不全。
 * 现在池子里多放一些，unavailable 的自动跳过，不支持的不会被下载。
 */
const MODEL_CANDIDATES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'cs', 'sk', 'hu', 'ro', 'bg', 'hr', 'sl', 'sr',
  'uk', 'ru', 'el', 'sv', 'da', 'no', 'fi', 'is', 'et', 'lv', 'lt', 'tr', 'ar', 'fa', 'he',
  'hi', 'bn', 'gu', 'mr', 'ta', 'te', 'kn', 'ml', 'pa', 'ur', 'th', 'vi', 'id', 'ms', 'tl', 'fil',
  'ja', 'ko', 'zh'
];

function targetModelCode() {
  const t = settings?.targetLang || 'zh-CN';
  return t === 'zh-TW' ? 'zh-Hant' : t === 'zh-CN' ? 'zh' : String(t).split('-')[0];
}

/**
 * 给一个 Promise 加超时。
 * Translator.create() 在连续下载若干个模型后会「静默挂起」：
 * 既不 resolve 也不 reject，也没有 downloadprogress —— 界面就永久停在「正在下载」。
 * 没有这层保护，点一次按钮等于把设置页挂死。
 */
function raceTimeout(p, ms, tag = '操作') {
  let timer;
  return Promise.race([
    p,
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`${tag} 无响应（${Math.round(ms / 1000)}s）`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

/**
 * 记录「下载会挂起」的语言对。
 * 实测：no→zh（挪威语）每次点都卡满超时，fi→zh 紧随其后 ——
 * 这不是偶发抖动，是这两个模型的服务端就是没响应。
 * 不记住的话，每点一次都从同一个地方开始白等，永远下不完后面的语言。
 * 1 小时后自动重试（万一只是当时服务器抽风）。
 */
const STUCK_KEY = 'xt_model_stuck_v1';
const STUCK_TTL = 60 * 60 * 1000;

function loadStuck() {
  try {
    const raw = JSON.parse(localStorage.getItem(STUCK_KEY) || '{}');
    const now = Date.now();
    for (const k of Object.keys(raw)) if (now - raw[k] > STUCK_TTL) delete raw[k];
    return raw;
  } catch {
    return {};
  }
}
function saveStuck(obj) {
  try {
    localStorage.setItem(STUCK_KEY, JSON.stringify(obj));
  } catch {}
}

$('downloadModel').addEventListener('click', async () => {
  const btn = $('downloadModel');
  const out = $('modelStatus');
  const log = (kind, text) => {
    out.className = 'result show' + (kind ? ' ' + kind : '');
    out.textContent = text;
  };

  btn.disabled = true;
  const lines = [];
  const show = (cur) => log('', [...lines, cur].filter(Boolean).join('\n'));

  try {
    if (typeof self.Translator === 'undefined') {
      log('err', '当前浏览器不支持 Translator API（需要 Chrome 138 及以上版本）');
      return;
    }

    const tgt = targetModelCode();
    // 双向都准备：外语→中文 用于读推文，中文→英语 用于确认反向也通
    const pairs = MODEL_CANDIDATES.filter((s) => s !== tgt).map((s) => [s, tgt]);
    if (tgt !== 'en') pairs.push([tgt, 'en']);
    const unsupportedLangs = [];

    show('正在检查模型状态…');
    let okCount = 0;
    let skipCount = 0;
    const failed = [];
    const newlyDone = [];
    const stuckShort = []; // 本次跳过的「会挂起」语言
    const stuckMap = loadStuck();
    let stuckRun = 0; // 连续「无响应」计数，用来识别浏览器是否已经拒绝继续下载
    // 单次点击最多下载这么多个。
    // 实测：同一个页面连续 create 到第 9 个时会静默挂起（既不 resolve 也不报错），
    // 而单独下任何一个都只要 2~8 秒。所以按批次下，到量就停，提示是否再点一次。
    // 已下载的会被 availability() 判成 available 直接跳过，不会重复下载。
    const MAX_PER_CLICK = 8;
    let doneThisRound = 0;

    for (let i = 0; i < pairs.length; i++) {
      const [src, dst] = pairs[i];
      const tag = `${src}→${dst}`; // 只用于显示
      const pairKey = `${src}->${dst}`; // 存储键：纯 ASCII，避免箭头字符引起的匹配问题
      let avail = 'unknown';
      try {
        avail = await self.Translator.availability({ sourceLanguage: src, targetLanguage: dst });
      } catch (e) {
        failed.push(`${tag} 查询失败`);
        continue;
      }

      if (avail === 'available') {
        skipCount++;
        lines.push(`✓ ${tag} 已就绪`);
        show(`[${i + 1}/${pairs.length}] 跳过已就绪的 ${tag}`);
        continue;
      }
      if (avail === 'unavailable') {
        // 浏览器本身不支持这门语言 —— 不算失败，只是没有这个模型可下
        unsupportedLangs.push(src);
        lines.push(`— ${tag} 浏览器不支持该语言，跳过`);
        continue;
      }

      if (doneThisRound >= MAX_PER_CLICK) {        log(
          'warn',
          [
            `本次已下载 ${doneThisRound} 个（单次点击连续下载有上限，再多浏览器会卡住）。`,
            ...lines.slice(-4),
            '',
            newlyDone.length ? '本次补齐：' + newlyDone.join(', ') : '',
            '请再点一次上面的按钮继续补齐 —— 已经下好的不会重复下载。'
          ]
            .filter(Boolean)
            .join('\n')
        );
        await chrome.runtime.sendMessage({ type: 'XT_HEALTH_RESET' }).catch(() => {});
        return;
      }

      // 上次点过就卡住的语言，1 小时内直接跳过，否则每次点击都在同一个坑里白等
      if (stuckMap[pairKey]) {
        stuckShort.push(src);
        lines.push(`— ${tag} 上次下载无响应，先跳过（1 小时后重试）`);
        continue;
      }

      show(`[${i + 1}/${pairs.length}] 正在下载 ${tag}…`);
      try {
        // ★ 每个语言对单独限时。实测过：连续下到第 9 个时 create() 会一直不 resolve
        //   （既没有 downloadprogress，也不抛错），整个按钮就永久停在「正在下载」。
        //   没法知道是卡了还是在慢慢下，只能关页面 —— 必须自己兜住。
        const t = await raceTimeout(
          self.Translator.create({
            sourceLanguage: src,
            targetLanguage: dst,
            monitor(m) {
              m.addEventListener('downloadprogress', (e) => {
                const pct = e.total ? Math.round((e.loaded / e.total) * 100) : Math.round(e.loaded / 1024);
                show(`[${i + 1}/${pairs.length}] 正在下载 ${tag} … ${pct}${e.total ? '%' : ' KB'}`);
              });
            }
          }),
          30000,
          tag
        );
        await raceTimeout(t.translate('test'), 30000, tag + ' 试译');
        okCount++;
        newlyDone.push(src);
        doneThisRound++;
        lines.push(`✓ ${tag} 下载完成`);
        stuckRun = 0;
      } catch (e) {
        const m = String(e?.message || e);
        if (/user gesture/i.test(m)) {
          lines.push(`⚠ ${tag} 需要再次点击才能继续`);
          log('warn', lines.join('\n') + '\n\n浏览器要求每次下载都由一次点击触发，请再点一次按钮继续（已完成的不会重复下载）。');
          return;
        }
        if (/无响应/.test(m)) {
          stuckRun++;
          stuckMap[pairKey] = Date.now();
          saveStuck(stuckMap);
          lines.push(`⚠ ${tag} 下载无响应，跳过（1 小时内不再重试）`);
          // 连着几个都不响应：要么是浏览器卡了，要么这几个模型服务端就是没反应。
          // 继续硬等只会干等十几分钟。停下来提示再点一次 ——
          // 刚跳过的语言已经记进 stuckMap，下一次点击会直接越过它们继续往后下。
          if (stuckRun >= 3) {
            log(
              'warn',
              [
                `已下载 ${okCount} 个后连续 3 个语言对下载无响应，先停下。`,
                ...lines.slice(-5),
                '',
                '请再点一次上面的按钮 —— 已经下好的不会重复下载，刚才卡住的语言会自动跳过。'
              ].join('\n')
            );
            await chrome.runtime.sendMessage({ type: 'XT_HEALTH_RESET' }).catch(() => {});
            return;
          }
          continue;
        }
        stuckRun = 0;
        failed.push(`${tag}：${m.slice(0, 60)}`);
        lines.push(`✗ ${tag} 失败`);
      }
    }

    const parts = [`新下载 ${okCount} 个`, `已存在 ${skipCount} 个`];
    if (unsupportedLangs.length) parts.push(`浏览器不支持 ${new Set(unsupportedLangs).size} 种`);
    if (stuckShort.length) parts.push(`无响应跳过 ${stuckShort.length} 种`);
    if (failed.length) parts.push(`失败 ${failed.length} 个`);
    const summary = '完成：' + parts.join('，');

    const detail = [];
    if (newlyDone.length) detail.push('本次补齐：' + newlyDone.join(', '));
    if (unsupportedLangs.length) {
      detail.push('浏览器不支持（无法下载，会交给在线引擎）：' + [...new Set(unsupportedLangs)].join(', '));
    }
    if (stuckShort.length) {
      detail.push('下载无响应（1 小时后可重试，期间会交给在线引擎）：' + [...new Set(stuckShort)].join(', '));
    }
    if (failed.length) detail.push('失败明细：' + failed.join('；'));

    log(failed.length ? 'warn' : 'ok', [summary, ...lines.slice(-6), ...detail].filter(Boolean).join('\n'));
    if (okCount || skipCount) {
      // 之前 builtin 若因「模型未下载」被记进冷却（30 分钟），下完模型必须立刻放出来，
      // 否则会以为下好了却还是不翻。
      await chrome.runtime.sendMessage({ type: 'XT_HEALTH_RESET' }).catch(() => {});
      out.textContent +=
        '\n\n引擎状态已重置。现在可以把上方「翻译引擎」切换为「Chrome 内置本地翻译」，' +
        '或留在「自动」—— 自动模式会优先用本地模型，本地没有的语言再交给在线引擎。';
    }
  } catch (e) {
    log('err', '失败：' + (e?.message || e) + '\n常见原因：网络无法访问 Chrome 模型下载服务器。');
  } finally {
    btn.disabled = false;
  }
});

/* 清空缓存 */
$('clearCache').addEventListener('click', async () => {
  $('clearCache').disabled = true;
  $('clearCache').textContent = '清理中…';
  try {
    await chrome.runtime.sendMessage({ type: 'XT_CLEAR_CACHE' });
    await refreshCache();
  } finally {
    $('clearCache').disabled = false;
    $('clearCache').textContent = '清空缓存';
  }
});

init();

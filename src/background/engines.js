// 翻译引擎适配层。
// 统一签名：(texts: string[], targetLang: string, cfg) => Promise<Array<{t,l}|null>>
// 返回数组与输入等长同序；t = 译文，l = 检测到的源语言码；无法翻译的项返回 null。
//
// 关于引擎可用性（2026-10 实测，中国大陆网络）：
//   - MyMemory   ：直连可用，无需 Key，有每日额度（匿名 5000 词/天）
//   - Google     ：translate.googleapis.com 直连不通，需要代理才可用
//   - Microsoft  ：官方免费鉴权端点 edge.microsoft.com/translate/auth 已返回 404，弃用
//   - OpenAI     ：需自备 Key
//   - Chrome内置 ：本地模型，离线可用（需 Chrome 138+）

import { getProbeState } from './probe.js';

const LANG = {
  'zh-CN': { mm: 'zh-CN', google: 'zh-CN', openai: 'Simplified Chinese (简体中文)', builtin: 'zh' },
  'zh-TW': { mm: 'zh-TW', google: 'zh-TW', openai: 'Traditional Chinese (繁體中文)', builtin: 'zh-Hant' },
  'en': { mm: 'en', google: 'en', openai: 'English', builtin: 'en' },
  'ja': { mm: 'ja', google: 'ja', openai: 'Japanese', builtin: 'ja' },
  'ko': { mm: 'ko', google: 'ko', openai: 'Korean', builtin: 'ko' },
  'fr': { mm: 'fr', google: 'fr', openai: 'French', builtin: 'fr' },
  'de': { mm: 'de', google: 'de', openai: 'German', builtin: 'de' },
  'es': { mm: 'es', google: 'es', openai: 'Spanish', builtin: 'es' },
  'ru': { mm: 'ru', google: 'ru', openai: 'Russian', builtin: 'ru' }
};

function lang(table, targetLang) {
  return (LANG[targetLang] || LANG['zh-CN'])[table];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, opts = {}, timeout = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * 带类型的引擎错误。
 * 为什么要分类：以前所有失败都写成「返回为空」，于是
 *   - Google 因 IP 被判定为代理（429 / 302 到人机验证页）
 *   - MyMemory 当日额度耗尽（要等 15 小时）
 *   - 真的没网（超时）
 * 三种完全不同的处境在弹窗里长得一模一样，看到的只是「又不翻译了」。
 * 现在带上 kind，上层就能给不同的冷却时间和人话解释。
 *
 * kind: ratelimit | quota | auth | network | empty | other
 */
class EngineError extends Error {
  constructor(message, kind = 'other', until = 0) {
    super(message);
    this.name = 'EngineError';
    this.kind = kind;
    /** 引擎自己给出的「何时恢复」时间戳（毫秒），比如 MyMemory 的额度重置 */
    this.until = until;
  }
}

/** 把普通 Error 归一化，超时类错误要归到 network */
function normalizeErr(err) {
  if (err instanceof EngineError) return err;
  const msg = String(err?.message || err || '未知错误');
  const kind = /整批超时|aborted|timeout|Failed to fetch|NetworkError/i.test(msg) ? 'network' : 'other';
  return new EngineError(msg, kind);
}

/**
 * 批次级硬超时。
 * 单条 fetch 的超时只能管住「一个请求」，管不住「16 条 × 15 秒排队」。
 * 没代理时 Google 会逐条卡到超时，整批叠起来能拖到 80 秒，
 * 看到的就是「页面一直不翻译」。这里给每个引擎一个整批上限，
 * 到点直接放弃当前引擎、冷却并降级到下一个。
 *
 * 各引擎改成低并发后（见 RUNNERS 里的 concurrency / gap），
 * 整批耗时被拉长，deadline 相应放宽 —— 反正撞到 429 会立即中止，
 * 不会真的傻等到上限。
 */
const BATCH_DEADLINE = {
  google: 15000,
  mymemory: 35000,
  openai: 50000,
  builtin: 60000
};

function withDeadline(promise, ms, name) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} 整批超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/* ------------------------------------------------------------------ *
 * 源语言识别（只用于显示「译自 X」，猜错不影响翻译本身）
 * ------------------------------------------------------------------ */

const LATIN_HINTS = {
  en: [' the ', ' and ', ' you ', ' that ', ' this ', ' with ', ' have ', ' not ', ' are ', ' is '],
  fr: [' le ', ' la ', ' les ', ' des ', ' une ', ' est ', ' et ', ' pour ', ' que ', ' dans '],
  de: [' der ', ' die ', ' das ', ' und ', ' ist ', ' nicht ', ' ein ', ' mit ', ' auf ', ' sich '],
  es: [' el ', ' los ', ' las ', ' que ', ' una ', ' por ', ' con ', ' para ', ' pero ', ' como '],
  pt: [' os ', ' uma ', ' que ', ' não ', ' para ', ' com ', ' isso ', ' mais ', ' você ', ' são '],
  it: [' il ', ' gli ', ' che ', ' una ', ' per ', ' con ', ' non ', ' sono ', ' questo ', ' come '],
  nl: [' het ', ' een ', ' van ', ' dat ', ' niet ', ' zijn ', ' voor ', ' met ', ' maar ', ' ook ']
};

// 引擎没给源语言时的兜底：先看文字体系，拉丁语系再按停用词打分
export function guessLanguage(text) {
  const t = ' ' + String(text).toLowerCase() + ' ';
  const hira = (t.match(/[\u3040-\u309f]/g) || []).length;
  const kata = (t.match(/[\u30a0-\u30ff]/g) || []).length;
  const hangul = (t.match(/[\uac00-\ud7af]/g) || []).length;
  const cyr = (t.match(/[\u0400-\u04ff]/g) || []).length;
  const arab = (t.match(/[\u0600-\u06ff]/g) || []).length;
  const thai = (t.match(/[\u0e00-\u0e7f]/g) || []).length;
  const han = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (t.match(/[a-z]/g) || []).length;

  if (hira + kata > 0) return 'ja';
  if (hangul > 0) return 'ko';
  if (arab > 0) return 'ar';
  if (thai > 0) return 'th';
  if (cyr > latin * 0.5) return 'ru';
  if (han > 0 && han >= latin * 0.6) return 'zh';

  let best = 'en';
  let bestScore = 0;
  for (const [code, words] of Object.entries(LATIN_HINTS)) {
    let s = 0;
    for (const w of words) if (t.includes(w)) s++;
    if (s > bestScore) {
      bestScore = s;
      best = code;
    }
  }
  return latin > 0 ? best : '';
}


function unescapeHtml(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------------ *
 * 1) MyMemory —— 默认引擎
 *    免费、无需 Key、中国大陆可直连。
 *    限制：单次 q 最多约 500 字节，所以要分段；匿名有每日额度。
 * ------------------------------------------------------------------ */

const MM_CHUNK = 420;

// 按句子 / 空格边界把长文本切成 <= MM_CHUNK 的块
function splitText(text, max = MM_CHUNK) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = -1;
    // 优先在句末切
    for (const sep of ['\n\n', '\n', '. ', '! ', '? ', '。', '！', '？', '; ', ', ', ' ']) {
      const idx = rest.lastIndexOf(sep, max);
      if (idx > max * 0.4) {
        cut = idx + sep.length;
        break;
      }
    }
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

async function myMemoryOne(text, targetLang) {
  const tl = lang('mm', targetLang);
  const url =
    'https://api.mymemory.translated.net/get?q=' +
    encodeURIComponent(text) +
    '&langpair=' +
    encodeURIComponent('autodetect|' + tl);

  const r = await fetchWithTimeout(url, {}, 15000);
  if (r.status === 429) throw new EngineError('MyMemory 429 限流', 'ratelimit');
  if (!r.ok) throw new EngineError(`MyMemory HTTP ${r.status}`, r.status >= 500 ? 'network' : 'other');
  const data = await r.json();

  const status = Number(data?.responseStatus);
  const out = data?.responseData?.translatedText ?? '';

  if (data?.quotaFinished) throw new EngineError('MyMemory 今日额度已用完', 'quota');
  // 额度 / 长度超限时，接口会把警告当译文返回
  if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID LANGUAGE PAIR/i.test(out)) {
    if (/QUERY LENGTH LIMIT/i.test(out)) throw new EngineError('MyMemory：文本过长', 'other');
    if (/INVALID LANGUAGE PAIR/i.test(out)) throw new EngineError('MyMemory：不支持该语言对', 'other');
    // 额度告警里自带恢复时间：NEXT AVAILABLE IN  15 HOURS 07 MINUTES 13 SECONDS
    // 解析出来直接当冷却结束时间，别再傻等固定的 12 小时
    const m = out.match(/NEXT AVAILABLE IN\s+(\d+)\s*HOURS?(?:\s+(\d+)\s*MINUTES?)?/i);
    const hours = m ? Number(m[1]) : 12;
    const mins = m?.[2] ? Number(m[2]) : 0;
    throw new EngineError(
      `MyMemory 今日免费额度已用完（约 ${hours} 小时 ${mins} 分后恢复）`,
      'quota',
      Date.now() + (hours * 60 + mins + 5) * 60000
    );
  }
  if (status === 429) throw new EngineError('MyMemory 429 限流', 'ratelimit');
  if (status && status !== 200) throw new EngineError(`MyMemory 返回状态 ${status}`, 'other');

  return unescapeHtml(out).trim();
}

export async function myMemoryTranslate(texts, targetLang, cfg = {}) {
  // MyMemory 匿名调用有明显的速率限制：并发必须压到 1，并留出间隔，
  // 否则一批推文里会有一半被静默丢弃（返回空）。
  // 间隔从 250ms 放宽到 450ms：这个接口按 IP 算额度，
  // 首页一次 16 条怼进去很容易直接吃到 429，慢一点反而整体成功率更高。
  const concurrency = Math.max(1, Math.min(2, cfg.concurrency || 1));
  const gap = Math.max(0, cfg.gap ?? 450);
  const out = new Array(texts.length).fill(null);

  let cursor = 0;
  async function worker() {
    while (cursor < texts.length) {
      const i = cursor++;
      const chunks = splitText(texts[i]);
      const pieces = [];
      let failed = false;
      for (const c of chunks) {
        try {
          pieces.push(await myMemoryWithRetry(c, targetLang));
        } catch (e) {
          // 额度耗尽 / 限流：整批都没救了，直接上交切引擎
          if (e.kind === 'quota' || e.kind === 'ratelimit' || /额度/.test(e.message)) throw e;
          failed = true;
          break;
        }
        if (gap) await sleep(gap);
      }
      out[i] = failed ? null : { t: pieces.join(''), l: guessLanguage(texts[i]) };
      if (gap) await sleep(gap);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, worker));
  return out;
}

async function myMemoryWithRetry(text, targetLang, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const v = await myMemoryOne(text, targetLang);
      if (v) return v;
      lastErr = new Error('返回为空');
    } catch (e) {
      lastErr = e;
      // 额度 / 限流类错误重试毫无意义，只会把整批时间耗光，直接上交切引擎
      if (e.kind === 'quota' || e.kind === 'ratelimit' || /额度|429|Too Many|quota/i.test(e.message)) throw e;
    }
    await sleep(400 * (i + 1));
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ *
 * 2) Google 免费端点（需要网络可达，国内通常要代理）
 * -------------------------------------------------------------------------
 * 2026-10-28 实测（同一出口 IP，美国 Phoenix / iCastCenter，ip-api 查得 proxy:true）：
 *   translate.googleapis.com/translate_a/single (POST client=gtx) → HTTP 429
 *   translate.googleapis.com/translate_a/t      (GET dict-chrome-ex) → 302 到 /sorry
 *   clients5.google.com/translate_a/t           (GET dict-chrome-ex) → 第一次 200，再打就 302 到 /sorry
 * 结论：限流是**按出口 IP** 判定的，换端点只能多搏一次，不是万能药。
 * 所以这里做两件事：
 *   ① 两个端点轮换，成功过的那条下次优先（不同端点阈值不同，能多撑一会儿）
 *   ② 认出 429 / 302→/sorry / HTML 验证页，明确归类为 ratelimit，
 *      上层冷却 60 分钟。旧版只冷却 5 分钟 = 每 5 分钟把同一堵墙再撞一遍。
 */

// 上次成功的端点下标，下次优先用它
let googleEpPref = 0;

const GOOGLE_ENDPOINTS = [
  {
    id: 'clients5',
    // dict-chrome-ex 的返回：[[译文, 源语言], ...]，长文本会被切成多段
    buildUrl(text, tl) {
      return (
        'https://clients5.google.com/translate_a/t?client=dict-chrome-ex' +
        '&sl=auto&tl=' +
        encodeURIComponent(tl) +
        '&q=' +
        encodeURIComponent(text)
      );
    },
    opts: { method: 'GET', credentials: 'omit' },
    parse(data) {
      if (!Array.isArray(data)) return null;
      const segs = data.filter((x) => Array.isArray(x) && typeof x[0] === 'string');
      if (!segs.length) return null;
      const t = segs.map((s) => s[0]).join('');
      if (!t) return null;
      const l = segs[0][1] ? String(segs[0][1]).toLowerCase().split('-')[0] : '';
      return { t, l };
    }
  },
  {
    id: 'gtx',
    // gtx 的返回：[[[译文, 原文, ...]], null, "源语言", ...]
    buildUrl(_text, tl) {
      return (
        'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
        encodeURIComponent(tl) +
        '&dt=t&ie=UTF-8&oe=UTF-8'
      );
    },
    opts: {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }
    },
    body: (text) => 'q=' + encodeURIComponent(text),
    parse(data) {
      const segs = data?.[0];
      if (!Array.isArray(segs)) return null;
      const t = segs.map((s) => (Array.isArray(s) ? s[0] || '' : '')).join('');
      if (!t) return null;
      // data[2] 就是 Google 自己判定出的源语言码，免费蹭一个语言检测
      const detected = Array.isArray(data?.[2]) ? data[2][0] : null;
      return { t, l: detected ? String(detected).toLowerCase().split('-')[0] : '' };
    }
  }
];

async function googleOne(text, targetLang, ep) {
  const tl = lang('google', targetLang);
  const opts = { ...ep.opts };
  if (ep.body) opts.body = ep.body(text);

  const r = await fetchWithTimeout(ep.buildUrl(text, tl), opts, 12000);

  if (r.status === 429) throw new EngineError('Google 429 限流', 'ratelimit');

  // 被判定为代理流量时 Google 会 302 到 www.google.com/sorry（人机验证页）。
  // fetch 会自动跟随跳转，最终拿到 200 + text/html —— 只看 r.ok 会误判成成功，
  // 所以必须同时检查 content-type。
  const ct = r.headers.get('content-type') || '';
  if (r.redirected || !r.ok || !/json/i.test(ct)) {
    throw new EngineError(
      `Google 拒绝服务（HTTP ${r.status}${r.redirected ? '，被跳到验证页' : ''}），该 IP 被判定为代理流量`,
      'ratelimit'
    );
  }

  let data;
  try {
    data = await r.json();
  } catch {
    throw new EngineError('Google 返回体不是有效 JSON（疑似验证页）', 'ratelimit');
  }

  const v = ep.parse(data);
  if (!v) return null;
  if (!v.l) v.l = guessLanguage(text);
  return v;
}

export async function googleTranslate(texts, targetLang, cfg = {}) {
  // 并发 3→2、间隔 100→350ms。
  // 免费接口的风控是「按 IP 算请求速率」的，我们自己一秒打出去好几个请求，
  // 等于主动把一个还能用的 IP 打成 429。慢一点，但整体可用率高得多。
  const concurrency = Math.max(1, Math.min(4, cfg.concurrency || 2));
  const gap = Math.max(0, cfg.gap ?? 350);
  const out = new Array(texts.length).fill(null);

  // 一旦确认「整台 IP 被封」，别再让剩下十几条挨个去撞 —— 那是纯烧时间。
  let aborted = null;
  let cursor = 0;

  async function worker() {
    while (cursor < texts.length && !aborted) {
      const i = cursor++;
      let value = null;

      for (let k = 0; k < GOOGLE_ENDPOINTS.length; k++) {
        const ep = GOOGLE_ENDPOINTS[(googleEpPref + k) % GOOGLE_ENDPOINTS.length];
        try {
          value = await googleOne(texts[i], targetLang, ep);
          googleEpPref = (googleEpPref + k) % GOOGLE_ENDPOINTS.length;
          break;
        } catch (e) {
          const err = normalizeErr(e);
          if (err.kind === 'ratelimit') {
            // 还有下一个端点没试过，就换端点再搏一次
            if (k < GOOGLE_ENDPOINTS.length - 1) continue;
            aborted = err;
            throw err;
          }
          // 网络层错误（没代理 / DNS 挂了）：这一条放弃，整批也别再试了
          aborted = err;
          throw err;
        }
      }

      if (aborted) break;
      out[i] = value;
      if (gap) await sleep(gap);
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, worker));
  } catch (e) {
    const err = normalizeErr(e);
    const good = out.filter((x) => x && x.t).length;
    // 已经翻出来的条目别浪费：挂到错误对象上，上层可以只用这部分
    err.partial = out;
    if (!good) throw err;
    // 有部分结果时不抛，但要把「这次被封了」记下来 —— 由上层 markHealth 处理
    return out;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 站点语境提示词
 * -------------------------------------------------------------------------
 * 同一个模型，翻 GitHub 和翻推特的要求完全不同：
 *   - 推特要口语、要保留语气词；
 *   - GitHub 要术语准确、**技术名词一律不译**。
 * 中文开发者圈子的习惯是「C++ / Rust / Kubernetes / PR / commit」直接用英文，
 * 硬翻成「锈语言」「库伯内特斯」「拉取请求」反而看不懂。
 * 由内容脚本声明 context，这里拼进系统提示词。
 * ------------------------------------------------------------------------- */
const CONTEXT_SYS = {
  github: [
    'The content comes from GitHub, a software development site.',
    'Hard rules:',
    '- Never translate code, identifiers, file paths, branch/tag names, CLI commands, or anything inside backticks.',
    '- Keep technology, language and product names in English exactly as written. Examples that MUST stay:',
    '  C, C++, C#, F#, Objective-C, Python, Rust, Zig, Go, Java, Kotlin, Swift, TypeScript, JavaScript,',
    '  Ruby, PHP, Elixir, Haskell, Scala, Lua, Dart, R, Julia, Perl, Shell, Bash,',
    '  React, Vue, Svelte, Next.js, Node.js, Deno, Bun, Docker, Kubernetes, Terraform, Nginx, Redis,',
    '  PostgreSQL, MySQL, SQLite, MongoDB, Git, GitHub, GitLab, Linux, macOS, iOS, Android,',
    '  WebAssembly, WASM, LLVM, CUDA, TensorFlow, PyTorch, OpenAI, DeepSeek, Copilot, Codespaces,',
    '  API, SDK, CLI, HTTP, TCP, TLS, JSON, YAML, TOML, XML, HTML, CSS, SQL, GPU, CPU, RAM, CI/CD, OOM.',
    '- For well-established dev terms (pull request, commit, merge, rebase, fork, workflow, repository,',
    '  branch, release, issue), use the term a Chinese developer would actually say; never translate the',
    '  technical meaning away (e.g. never turn "commit" into "承诺").',
    '- Tone: concise, professional, like GitHub Chinese documentation. No filler, no added explanations.',
    '- Avoid calques. Do not turn English nouns/verbs into stiff Chinese compounds:',
    '  "not mirrored" → "不提供镜像"（不是"未镜像"）; "not supported" → "不支持";',
    '  "moved to" → "已迁移至". Read like a Chinese developer wrote it, not a dictionary.',
    '- Preserve markdown structure (lists, tables, emphasis) exactly.'
  ].join('\n')
};

/* ------------------------------------------------------------------ *
 * 3) OpenAI 兼容接口（DeepSeek / 通义 / Ollama / llama.cpp 均可）
 * ------------------------------------------------------------------ */

export async function openaiTranslate(texts, targetLang, cfg, opts = {}) {
  // 没填 Key 不是「引擎坏了」，单独归为 nokey（只冷却 1 分钟）。
  // 旧版抛 auth → 冷却 1 小时，配好 Key 后「自动」还会跳过它一小时。
  if (!cfg?.apiKey) throw new EngineError('未配置 API Key（在设置页填写 OpenAI / DeepSeek Key）', 'nokey');
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = cfg.model || 'gpt-4o-mini';
  const langName = lang('openai', targetLang);

  // DeepSeek V4 默认开启 thinking（effort=high）。翻译场景完全用不到推理，
  // 开着会让每次请求多花几百到几千个 reasoning token（按输出计费），而且延迟翻几倍。
  // 其他 OpenAI 兼容服务不认识这个字段，所以只在 DeepSeek 域名下加。
  const isDeepSeek = /(^|\.)deepseek\.com/i.test(base);

  const payload = texts.map((t, i) => ({ i, t }));
  const sys =
    `You are a precise translator. Translate every "t" field into ${langName}.\n` +
    (opts?.extraSys ? opts.extraSys + '\n' : '') +
    `Rules:\n` +
    `- Keep @handles, #hashtags, URLs, emoji, and code blocks unchanged.\n` +
    `- Preserve line breaks and tone (social media phrasing, slang, sarcasm).\n` +
    `- If a text is already in ${langName}, return it unchanged.\n` +
    `- Set "l" to the ISO 639-1 code of the source text (e.g. "en", "ja", "de").\n` +
    `- Respond with ONLY a JSON object: {"r":[{"i":<number>,"t":"<translation>","l":"<src lang>"}]}, no extra prose.`;

  const r = await fetchWithTimeout(
    `${base}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify({
        model,
        // 0 而不是 0.2：翻译要的是稳定复现。
        // 0.2 时同一句话重翻一遍会换个说法，切换引擎重扫就会觉得
        // 「译文怎么又变了、是不是换了个更差的引擎」——其实都是同一个模型。
        temperature: 0,
        ...(isDeepSeek ? { thinking: { type: 'disabled' } } : {}),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: JSON.stringify(payload) }
        ]
      })
    },
    45000
  );

  if (!r.ok) {
    const body = await r.text().catch(() => '');
    const kind = r.status === 401 || r.status === 403 ? 'auth' : r.status === 429 ? 'ratelimit' : 'other';
    throw new EngineError(`OpenAI 翻译失败 HTTP ${r.status} ${body.slice(0, 160)}`, kind);
  }
  const data = await r.json();
  const content = data?.choices?.[0]?.message?.content || '';
  const finish = data?.choices?.[0]?.finish_reason || '';
  const parseOut = (raw) => {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return null;
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    const arr = new Array(texts.length).fill(null);
    for (const item of parsed?.r || []) {
      const idx = Number(item?.i);
      if (Number.isInteger(idx) && idx >= 0 && idx < arr.length) {
        const t = String(item?.t ?? '');
        if (!t) continue;
        const l = item?.l ? String(item.l).toLowerCase().split('-')[0] : guessLanguage(texts[idx]);
        arr[idx] = { t, l };
      }
    }
    return arr;
  };

  const out = parseOut(content) || new Array(texts.length).fill(null);

  // ★ 整批一条都没拿到：拆成单条重试。
  // 真实会发生的两种情况：模型把 JSON 写坏 / 输出被截断（finish_reason=length）、
  // 或某些句子让它跑偏。旧版直接把整批 10 条判死，看到的是「已翻译 0，失败 27」。
  if (!out.some((x) => x && x.t)) {
    console.warn(
      `[XT] OpenAI 本批 ${texts.length} 条无有效结果（finish=${finish || '?'}），content 片段：`,
      content.slice(0, 240)
    );
    if (texts.length > 1) {
      for (let i = 0; i < texts.length; i++) {
        try {
          const one = await openaiTranslate([texts[i]], targetLang, cfg);
          if (one?.[0]?.t) out[i] = one[0];
        } catch {
          /* 单条也没救就算了，交给下一个引擎 */
        }
      }
    } else if (!content) {
      throw new Error('OpenAI 返回内容为空');
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 4) Chrome 内置翻译（本地模型，离线、免费、无限额）
 * ------------------------------------------------------------------ */

let offscreenReady = null;

async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const has = await chrome.offscreen.hasDocument?.();
    if (!has) {
      await chrome.offscreen.createDocument({
        url: 'src/offscreen/offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: '调用 Chrome 内置 Translator / LanguageDetector API 需要 DOM 上下文'
      });
    }
  })();
  try {
    await offscreenReady;
  } catch (e) {
    offscreenReady = null;
    throw e;
  }
  return offscreenReady;
}

export async function builtinTranslate(texts, targetLang) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    type: 'XT_OFFSCREEN_TRANSLATE',
    texts,
    targetLang: lang('builtin', targetLang)
  });
  if (!res?.ok) {
    const msg = res?.error || '内置翻译失败';
    // 模型没下载时 create() 要一次点击，后台永远等不到 —— 这不是「暂时失败」，
    // 得靠人手动到设置页点一次，所以冷却给长一点，别每批都撞。
    if (res?.kind === 'gesture') throw new EngineError(msg, 'gesture');
    throw new EngineError(msg, 'other');
  }
  return res.results;
}

/* ------------------------------------------------------------------ *
 * 引擎注册与调度
 * ------------------------------------------------------------------ */

const RUNNERS = {
  mymemory: (t, l, s) => myMemoryTranslate(t, l, s?.mymemory),
  google: (t, l, s) => googleTranslate(t, l, s?.google),
  openai: (t, l, s, o) => openaiTranslate(t, l, s?.openai, o),
  builtin: (t, l) => builtinTranslate(t, l)
};

/**
 * 给结果盖上「这条是谁翻的」。
 * 自动模式会依次尝试多个引擎，页面必须能说清某条到底是 DeepSeek 翻的
 * 还是本地模型翻的 —— 否则永远搞不懂「为什么换了引擎质量就变了」。
 */
function stampEngine(arr, engine) {
  if (!Array.isArray(arr)) return arr;
  for (const x of arr) {
    if (x && x.t && !x.e) x.e = engine;
  }
  return arr;
}

/**
 * 译文是否「原样返回」了原文。
 *
 * 会真实发生：短句 / 大量俚语 / 纯专有名词时，模型或接口偶尔把输入原封不动吐回来；
 * 本地模型在语言检测出错时也会直接把原文当译文返回。
 * 这种结果**不能当成功** —— 否则页面上会多出一行和原文一模一样的灰字，
 * 看到的就是「这句话没被翻译」。
 *
 * 比较时忽略空白、标点、大小写和 emoji，只比可读字符。
 */
function isSameText(a, b) {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]/gu, '');
  const na = norm(a);
  return na.length > 0 && na === norm(b);
}

export { isSameText };

/* ------------------------------------------------------------------ *
 * 引擎健康状态（冷却）
 * -------------------------------------------------------------------------
 * 旧版只放在内存 Map 里。MV3 的 service worker 空闲 30 秒就被回收，
 * 冷却记录跟着一起没了 —— 于是「Google 被封」这件事每批都要重新撞一遍，
 * 每批都白等几秒，看到的就是「一直转圈不翻译」。
 * 现在落到 storage.local，SW 重启后照样生效。
 * ------------------------------------------------------------------------- */

const HEALTH_KEY = 'xt_health_v1';

/**
 * 冷却时长按失败类型区分。
 * 关键点：Google 对「被判定为代理」的 IP 是按小时封的，
 * 旧版统一 5 分钟冷却等于没冷却。
 */
const COOLDOWN = {
  ratelimit: 60 * 60 * 1000, // 429 / 验证页：1 小时
  quota: 12 * 60 * 60 * 1000, // 额度耗尽：12 小时兜底（引擎给了准确时间就用引擎的）
  auth: 60 * 60 * 1000, // Key 错（填了但被拒）：1 小时，改完设置会重置
  // 「没填 Key」不算失败，只冷却 1 分钟占位。以前这里也按 auth 记 1 小时，
  // 结果配好 Key 切到「自动」，openai 还带着旧冷却被跳过，
  // 一路掉到内置 / Google —— 表现就是「配了 Key 反而翻得更差」。
  nokey: 60 * 1000,
  gesture: 30 * 60 * 1000, // 本地模型未下载：得手动到设置页触发
  network: 5 * 60 * 1000, // 超时 / 断网：5 分钟
  empty: 5 * 60 * 1000,
  other: 5 * 60 * 1000
};

const health = new Map();
let healthLoaded = null;

async function loadHealth() {
  if (healthLoaded) return healthLoaded;
  healthLoaded = (async () => {
    try {
      const s = await chrome.storage.local.get(HEALTH_KEY);
      const obj = s[HEALTH_KEY] || {};
      const now = Date.now();
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v.until === 'number' && v.until > now) health.set(k, v);
      }
    } catch {}
  })();
  return healthLoaded;
}

function persistHealth() {
  const now = Date.now();
  const obj = {};
  for (const [k, v] of health) if (v.until > now) obj[k] = v;
  try {
    chrome.storage.local.set({ [HEALTH_KEY]: obj });
  } catch {}
}

/**
 * 引擎当前是否可用。
 *
 * ★ 这里曾经有个致命反转（v1.1.8 之前）：
 *   markHealth(ok=true) 写入的是 `{ ok: true, until: now + 10min }`，
 *   而 isHealthy 只看 `now > until`，于是**成功的引擎反而被判成不健康 10 分钟**。
 *   后果：openai 第一次成功 → 立刻被踢出候选 → 后面 10 分钟全部落到
 *   内置模型 / Google。看到的就是「选自动和选 OpenAI 译文不一样，
 *   而且根本不知道现在是什么引擎翻的」。
 *   ok:true 的 until 表示「这段时间内可以信任」，不是冷却终点。
 */
function isHealthy(engine) {
  const h = health.get(engine);
  if (!h) return true;
  if (h.ok) return true; // 成功记录：信任期内一直可用
  return Date.now() > h.until; // 失败记录：过了冷却终点才恢复
}

function markHealth(engine, ok, err) {
  if (ok) {
    health.set(engine, { ok: true, kind: '', reason: '', until: Date.now() + 10 * 60 * 1000 });
    persistHealth();
    return;
  }
  const e = normalizeErr(err);
  let ms = e.until && e.until > Date.now() ? e.until - Date.now() : COOLDOWN[e.kind] || COOLDOWN.other;
  // 配了 Key 的引擎「返回为空」通常是瞬时的（模型写坏 JSON / 输出被截断），
  // 已经做了单条兜底重试，这里只短暂冷静 1 分钟，别干等 5 分钟。
  if (engine === 'openai' && e.kind === 'empty') ms = 60 * 1000;
  health.set(engine, {
    ok: false,
    kind: e.kind,
    reason: String(e.message || ''),
    until: Date.now() + Math.max(30000, ms)
  });
  persistHealth();
}

export async function engineHealth() {
  await loadHealth();
  const out = {};
  const now = Date.now();
  // usable 才是「现在能不能用它」，active 只是「记录是否还在有效窗口内」。
  // 两者对失败记录相同，对成功记录不同 —— 混用就会重现「成功的引擎被踢出候选」的老 bug。
  for (const [k, v] of health) out[k] = { ...v, active: now < v.until, usable: isHealthy(k) };
  return out;
}

/** 清空所有冷却记录（弹窗「立即重试」/ 改了设置时用） */
export async function resetHealth() {
  await loadHealth();
  health.clear();
  persistHealth();
  return engineHealth();
}

/**
 * 只清某一个引擎的冷却。
 * 改 Key / Base URL / 模型之后必须调用 —— 否则旧的 auth 冷却还在，
 * 「自动」会继续跳过它，翻译质量悄悄退回到内置或 Google。
 */
export async function clearEngineHealth(engine) {
  await loadHealth();
  if (!health.has(engine)) return engineHealth();
  health.delete(engine);
  persistHealth();
  return engineHealth();
}

function autoOrder(settings, probe) {
  const hasKey = !!settings?.openai?.apiKey;
  // 探测结论说 Google 不通时，不给它靠前的位置。
  // 但仍留在队列末尾兜底，避免探测 URL 被单独墙掉造成误判。
  const googleDown = probe && probe.google === false;

  // 排序铁律：**填了 Key，Key 引擎永远第一**。
  // 配 Key 图的就是质量，不能被「本地模型免费」或「Google 免 Key」抢在前面 ——
  // 本地模型只有 ~37 个语种、译文偏直译，Google/MyMemory 更糙。
  // 其余位置按性价比排：本地模型（0 秒、离线）→ Google → MyMemory。
  let order;
  if (hasKey) {
    order = googleDown
      ? ['openai', 'builtin', 'mymemory', 'google']
      : ['openai', 'builtin', 'google', 'mymemory'];
  } else {
    order = googleDown ? ['builtin', 'mymemory', 'google'] : ['builtin', 'google', 'mymemory'];
  }

  // 下面的「健康优先」排序是稳定排序，同等健康度时保持上面的顺序；
  // 但 openai 若因历史冷却被排到后面，就等于白配了 Key，
  // 所以有 Key 时先清掉它的 auth/nokey 旧账（见 XT_SET_SETTINGS）。

  // 健康的排前面（稳定排序，同等健康度时保持上面的优先顺序）
  return order.sort((a, b) => (isHealthy(b) ? 1 : 0) - (isHealthy(a) ? 1 : 0));
}

function describeDead(list) {
  return list
    .map((e) => {
      const h = health.get(e);
      const why = h?.reason || (h?.ok ? '正常' : '不可用');
      return `${ENGINE_LABELS[e]?.split('（')[0] || e}：${why}`;
    })
    .join('；');
}

/**
 * 把还没翻出来的下标，依次交给 engines 里可用的引擎补。
 * 只填空位，绝不覆盖已有结果（本地模型翻好的那些保持原样）。
 */
async function chainFill(out, pendingInit, texts, targetLang, settings, engines, opts) {
  let pending = pendingInit.filter((i) => !out[i]);
  for (const e of engines) {
    if (!pending.length) break;
    if (!isHealthy(e)) continue;
    const sub = pending.map((i) => texts[i]);
    try {
      const r = stampEngine(
        await withDeadline(RUNNERS[e](sub, targetLang, settings, opts), BATCH_DEADLINE[e] || 20000, e),
        e
      );
      let filled = 0;
      if (Array.isArray(r)) {
        r.forEach((v, k) => {
          const at = pending[k];
          if (at == null || !v?.t || out[at]) return;
          if (isSameText(v.t, texts[at])) return; // 原样返回，不算翻出来
          out[at] = v;
          filled++;
        });
      }
      if (filled) {
        markHealth(e, true);
        pending = pending.filter((i) => !out[i]);
      }
    } catch (err) {
      markHealth(e, false, normalizeErr(err));
    }
  }
  if (pending.length) {
    console.warn(`[XT] 仍有 ${pending.length} 条没能翻译（这些语言本地没模型，在线引擎也不可用）`);
  }
  return out;
}

export async function translate(texts, targetLang, engine, settings, opts = {}) {
  await loadHealth();

  // 站点语境（如 github）→ 额外系统提示词。只对 OpenAI 兼容引擎生效，
  // Google / MyMemory 无法接受提示词，术语可能被意译，这是免 Key 方案的固有短板。
  const ctxOpts = {
    ...opts,
    extraSys: opts?.context ? CONTEXT_SYS[opts.context] || '' : ''
  };

  if (engine === 'auto') {
    // 缓存过期时会在后台重探一次，但不阻塞本次翻译
    const probe = await getProbeState({ mayProbe: true }).catch(() => null);
    const order = autoOrder(settings, probe);

    // 冷却中的引擎直接跳过。旧版只排序不过滤，等于「排在后面但还是会撞」。
    // 全都冷却时立刻报错并说明原因 —— 继续挨个撞只会白等十几秒，
    // 而且对已经被封的 IP 来说再多请求只会让封得更久。
    const usable = opts.ignoreCooldown ? order : order.filter((e) => isHealthy(e));
    if (!usable.length) {
      throw new EngineError('所有引擎都在冷却中 —— ' + describeDead(order), 'other');
    }

    const errors = [];
    // 已翻好的位置结果；pending 是还没填上的下标
    const out = new Array(texts.length).fill(null);
    let pending = texts.map((_, i) => i);

    for (const e of usable) {
      if (!pending.length) break;
      const sub = pending.map((i) => texts[i]);
      const budget = BATCH_DEADLINE[e] || 20000;

      // 把某个引擎的结果并进 out，返回这次填了几条
      const merge = (arr) => {
        let filled = 0;
        if (!Array.isArray(arr)) return 0;
        arr.forEach((v, k) => {
          const at = pending[k];
          if (!v?.t || at == null || out[at]) return;
          // 原样返回（译文 === 原文）不算成功：不进结果、留给下一个引擎
          if (isSameText(v.t, texts[at])) return;
          out[at] = v;
          filled++;
        });
        if (filled) pending = pending.filter((i) => !out[i]);
        return filled;
      };

      try {
        const r = stampEngine(await withDeadline(RUNNERS[e](sub, targetLang, settings, ctxOpts), budget, e), e);
        const good = merge(r);
        // 「该语言没模型」和「引擎挂了」必须分开：
        // X 时间线上偶尔连着几条本地模型不覆盖的语种（波斯语等），
        // 若把这种批次判为引擎故障，最健康的本地引擎会被无谓冷却 5 分钟。
        // need-download = 这门语言的模型没下（如印地语）；unsupported = Chrome 压根不支持
        const skipped = Array.isArray(r)
          ? r.filter((x) => x && (x.skip === 'unsupported' || x.skip === 'need-download' || x.skip === 'same'))
              .length
          : 0;
        if (good) {
          markHealth(e, true);
          if (good < sub.length) {
            // ★ 链式补齐：一个引擎翻不了的语言（比如内置模型不支持某语种）
            // 不整批丢弃，把剩下的交给下一个引擎。X 时间线混着多国语言，
            // 这一步能实打实补回漏掉的几条。
            console.warn(`[XT] ${e} 本批 ${good}/${sub.length} 条，剩余交给下一个引擎`);
          }
          continue;
        }
        if (skipped) {
          // 引擎本身是好的，只是这几条的语言它不支持。不冷却，直接交给下一个引擎。
          console.warn(`[XT] ${e} 跳过 ${skipped}/${sub.length} 条：语言不支持或缺模型（引擎健康，不冷却）`);
          errors.push(`${e}: ${skipped} 条语言不支持`);
          continue;
        }
        // ★ 返回空 ≠ 引擎健康。
        // 以前这里只记 errors 不做 markHealth，导致「没代理时 Google 返回空」
        // 永远不会进冷却，auto 模式每批都先白等它一轮超时。
        markHealth(e, false, new EngineError('返回为空（可能被静默限流）', 'empty'));
        errors.push(`${e}: 空结果`);
      } catch (raw) {
        const err = normalizeErr(raw);
        // 部分成功的批次：已经翻出来的先用上，剩下的继续找下一个引擎
        const filled = merge(stampEngine(err.partial, e));
        if (filled) {
          markHealth(e, false, err);
          console.warn(`[XT] ${e} 中途失败，保留已翻译的 ${filled} 条：${err.message}`);
          continue;
        }
        markHealth(e, false, err);
        errors.push(`${e}: ${err.message}`);
      }
    }

    // 有缺口但已经翻出来一部分，也比整批丢掉强
    if (out.some(Boolean)) return out;
    throw new EngineError('所有引擎均失败 —— ' + errors.join(' / '), 'other');
  }

  const runner = RUNNERS[engine] || RUNNERS.mymemory;
  try {
    const r = stampEngine(
      await withDeadline(runner(texts, targetLang, settings, ctxOpts), BATCH_DEADLINE[engine] || 20000, engine),
      engine
    );
    // 原样返回 = 没翻出来。换成 skip:'same'，既不显示成译文，也不冷却引擎。
    if (Array.isArray(r)) {
      r.forEach((x, i) => {
        if (x?.t && isSameText(x.t, texts[i])) r[i] = { t: null, skip: 'same', l: x.l, e: x.e };
      });
    }
    const hasGood = r.some((x) => x && x.t);
    // 这些下标是「引擎本身没坏，只是这几门语言它没有 / 原样吐回来了」
    const skippedIdx = Array.isArray(r)
      ? r.reduce(
          (acc, x, i) =>
            x && !x.t && (x.skip === 'unsupported' || x.skip === 'need-download' || x.skip === 'same')
              ? acc.concat(i)
              : acc,
          []
        )
      : [];

    if (hasGood) {
      markHealth(engine, true);
    } else if (skippedIdx.length) {
      // 手动选了内置引擎，但这几条的语言它没模型。引擎没坏，不冷却。
      console.warn(`[XT] ${engine} 本批全部语言不支持或缺模型，保持健康状态`);
    } else {
      markHealth(engine, false, new EngineError('返回为空', 'empty'));
    }

    // ★ 手选「Chrome 内置」时，本地模型没有的语言自动借在线引擎补上。
    // 否则刷到一条印地语推文就是一片空白，看不出是缺模型还是扩展坏了。
    // 只补 skip 的部分，已翻好的本地结果原样保留（本地 0 秒，速度优势不受影响）。
    if (engine === 'builtin' && skippedIdx.length && opts.chainFallback !== false) {
      const order = autoOrder(settings, null).filter((e) => e !== 'builtin');
      if (order.length) {
        console.warn(`[XT] 内置引擎缺 ${skippedIdx.length} 条，交回在线引擎：${order.join(' → ')}`);
        return await chainFill(r, skippedIdx, texts, targetLang, settings, order, ctxOpts);
      }
    }
    return r;
  } catch (raw) {
    markHealth(engine, false, normalizeErr(raw));
    throw normalizeErr(raw);
  }
}

export const ENGINE_LABELS = {
  auto: '自动（依次尝试可用引擎）',
  mymemory: 'MyMemory（免费 / 国内直连 / 有日额度）',
  google: 'Google 翻译（免费 / 需要代理）',
  openai: 'OpenAI 兼容接口（自带 Key）',
  builtin: 'Chrome 内置本地翻译（离线）'
};

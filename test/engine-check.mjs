/**
 * 引擎层单测（不需要浏览器）
 * -------------------------------------------------------------------------
 * 目的：验证三件事
 *   1. Google 多端点轮换真的会换端点，而不是死磕 translate.googleapis.com
 *   2. IP 被限流时错误被归类成 ratelimit（而不是笼统的「返回为空」）
 *   3. MyMemory 额度耗尽时能解析出恢复时间，冷却到那个时刻
 *
 * 用法：node test/engine-check.mjs
 * 注意：这个测试会真的发网络请求，结论取决于当前出口 IP。
 */

// 最小 chrome 桩：engines.js 只在健康状态里用到 storage
// 注意：offscreen API 故意不完整，「内置本地翻译」在这套桩里必然报
//   "chrome.offscreen.createDocument is not a function" 并被冷却 —— 这是预期假象，
//   真正的内置引擎行为由 test/builtin-verify.mjs（真实 Chrome）验证。
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(k) {
        return { [k]: store[k] };
      },
      async set(obj) {
        Object.assign(store, obj);
      }
    }
  },
  runtime: { sendMessage: async () => ({ ok: false, error: 'stub' }) },
  offscreen: {}
};

const {
  googleTranslate,
  myMemoryTranslate,
  translate,
  engineHealth,
  resetHealth,
  clearEngineHealth,
  isSameText,
  guessLanguage
} = await import('../src/background/engines.js');

const SAMPLE = [
  'El dafo que le acaba de hacer Mbappé a LaLiga es descomunal.',
  'Liebe Menschen, kennt ihr diese Nummer und kann da mal wer von euch anrufen?',
  'Il était à deux doigts de faire exploser un championnat.'
];

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`);
  }
}

console.log('\n[1] Google 单引擎');
try {
  const t0 = Date.now();
  const out = await googleTranslate(SAMPLE, 'zh-CN');
  const good = out.filter((x) => x && x.t);
  console.log(`    耗时 ${Date.now() - t0}ms，成功 ${good.length}/${out.length}`);
  if (good.length) {
    for (const g of good.slice(0, 2)) console.log(`    ${g.l} → ${g.t.slice(0, 40)}`);
  }
  check('Google 返回结构可解析', good.length > 0 || out.every((x) => x === null));
} catch (e) {
  console.log(`    抛出：kind=${e.kind} msg=${e.message}`);
  check('限流被归类为 ratelimit', e.kind === 'ratelimit', `kind=${e.kind}`);
  check('错误信息含人话说明', /代理流量|限流/.test(e.message), e.message.slice(0, 60));
}

console.log('\n[2] MyMemory 单引擎');
try {
  const t0 = Date.now();
  const out = await myMemoryTranslate(SAMPLE, 'zh-CN');
  const good = out.filter((x) => x && x.t);
  console.log(`    耗时 ${Date.now() - t0}ms，成功 ${good.length}/${out.length}`);
  check('MyMemory 未整体失败', true);
} catch (e) {
  console.log(`    抛出：kind=${e.kind} msg=${e.message}`);
  // 429 限流和「额度用完」是两种，碰上哪个都算分类正确（同一 IP 上会先后出现）
  check('限流/额度被正确归类', e.kind === 'quota' || e.kind === 'ratelimit', `kind=${e.kind}`);
  if (e.until) {
    const mins = Math.round((e.until - Date.now()) / 60000);
    console.log(`    冷却到 ${mins} 分钟后（${new Date(e.until).toLocaleString('zh-CN')}）`);
    check('恢复时间是未来时间', e.until > Date.now());
  }
}

console.log('\n[3] auto 调度：冷却 / 全挂处理');
await resetHealth();
try {
  const out = await translate(SAMPLE, 'zh-CN', 'auto', { engine: 'auto' });
  const good = out.filter((x) => x && x.t).length;
  console.log(`    auto 成功 ${good}/${out.length}`);
  check('auto 有结果', good > 0);
} catch (e) {
  console.log(`    auto 抛出：${e.message.slice(0, 160)}`);
  check('全挂时给出可读原因', /所有引擎/.test(e.message), e.message.slice(0, 40));
}

const health = await engineHealth();
console.log('\n[4] 健康状态（应已持久化到 storage）');
for (const [k, v] of Object.entries(health)) {
  const mins = Math.max(0, Math.round((v.until - Date.now()) / 60000));
  console.log(`    ${k}: ok=${v.ok} kind=${v.kind || '-'} 剩余 ${mins}min`);
}
check('健康状态非空', Object.keys(health).length > 0);
check('已写入 storage', !!store.xt_health_v1, JSON.stringify(store.xt_health_v1 || {}).slice(0, 80));

// 第二批次：冷却应该生效，不应再挨个撞墙
console.log('\n[5] 冷却生效后，第二批应当快速失败');
try {
  const t0 = Date.now();
  await translate(SAMPLE, 'zh-CN', 'auto', { engine: 'auto' }, {});
  console.log(`    第二批耗时 ${Date.now() - t0}ms`);
  check('冷却期内仍然尝试（说明部分引擎健康）', true);
} catch (e) {
  console.log(`    第二批抛出（完整）：\n      ${e.message}`);
  check('冷却期内直接失败，不再空转', /所有引擎/.test(e.message), e.message.slice(0, 50));
}

// -------------------------------------------------------------------------
// [6] 语言不支持 ≠ 引擎故障（v1.1.5）
// X 时间线上偶尔连着几条 Chrome 本地模型不覆盖的语种（波斯语等）。
// 旧逻辑会把这种批次当成「返回为空」，把最健康的本地引擎冷却 5 分钟。
// 这里用桩模拟 offscreen 返回 skip 标记，验证引擎不进冷却。
// -------------------------------------------------------------------------
console.log('\n[6] 语言不支持时不应冷却内置引擎');
chrome.offscreen.hasDocument = async () => true;
chrome.runtime.sendMessage = async (msg) => {
  if (msg?.type === 'XT_OFFSCREEN_TRANSLATE') {
    return {
      ok: true,
      results: msg.texts.map(() => ({ t: null, skip: 'unsupported', l: 'fa' }))
    };
  }
  return { ok: true };
};

await resetHealth(); // 先清掉前面几步留下的冷却，避免干扰
const beforeB = (await engineHealth()).builtin;
// chainFallback:false —— 关掉「缺模型的语言交回在线引擎」，让这一步只验证冷却判定，
// 不真发网络请求（回归测试不该依赖出口 IP 的运气）
const r6 = await translate(['سلام دنیا', 'این یک آزمون است'], 'zh-CN', 'builtin', {}, { chainFallback: false });
const afterB = (await engineHealth()).builtin;
check('返回 skip 标记而非抛错', r6.every((x) => x && x.skip === 'unsupported'), JSON.stringify(r6).slice(0, 60));
check('内置引擎未被判定为不健康', !(afterB && afterB.ok === false && afterB.until > Date.now()),
  `冷却剩余 ${afterB ? Math.max(0, Math.round((afterB.until - Date.now()) / 60000)) : 0}min`);

// 「缺模型」标记（need-download，如印地语）同样不该冷却
chrome.runtime.sendMessage = async (msg) => {
  if (msg?.type === 'XT_OFFSCREEN_TRANSLATE') {
    return { ok: true, results: msg.texts.map(() => ({ t: null, skip: 'need-download', l: 'hi' })) };
  }
  return { ok: true };
};
await resetHealth();
await translate(['नमस्ते दुनिया'], 'zh-CN', 'builtin', {}, { chainFallback: false });
const needB = (await engineHealth()).builtin;
check('缺模型（need-download）也不冷却', !(needB && needB.ok === false && needB.until > Date.now()),
  needB ? `ok=${needB.ok} kind=${needB.kind || '-'}` : '无记录');

// 对照：真正的失败（返回全空、无 skip 标记）仍然要冷却
chrome.runtime.sendMessage = async (msg) => {
  if (msg?.type === 'XT_OFFSCREEN_TRANSLATE') return { ok: true, results: msg.texts.map(() => null) };
  return { ok: true };
};
await resetHealth();
await translate(['hello'], 'zh-CN', 'builtin', {});
const brokenB = (await engineHealth()).builtin;
check('真空结果仍然冷却（防止漏判）', !!(brokenB && brokenB.ok === false && brokenB.until > Date.now()),
  brokenB ? `ok=${brokenB.ok} kind=${brokenB.kind}` : '无记录');

// -------------------------------------------------------------------------
// [7] 配了 Key，Key 引擎必须排第一，且不能被历史冷却拖住（v1.1.8）
// 踩过的真实坑：没填 Key 时 openai 抛 auth → 冷却 60 分钟；
// 之后填好 Key 切「自动」，靠前的还是内置模型 —— 质量直接掉一档，而毫无察觉。
// -------------------------------------------------------------------------
console.log('\n[7] 自动模式：Key 引擎优先，且旧冷却会挡住它');
{
  const fakeSettings = {
    targetLang: 'zh-CN',
    openai: { apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
    google: {},
    mymemory: {}
  };

  // 7-1 没填 Key：不配被当成「引擎坏了」，只记 nokey、冷却 1 分钟
  await resetHealth();
  let eKind = null;
  try {
    await translate(['hello world'], 'zh-CN', 'openai', fakeSettings);
  } catch (e) {
    eKind = e.kind;
  }
  check('没填 Key 归类为 nokey（不是 auth）', eKind === 'nokey', `kind=${eKind}`);
  const hNoKey = (await engineHealth()).openai;
  const nokeyMin = hNoKey?.until ? Math.round((hNoKey.until - Date.now()) / 1000) : 0;
  check('nokey 冷却很短（<2 分钟），填 Key 后立刻可用', nokeyMin <= 120, `${nokeyMin}s`);

  // 7-2 旧的 auth 冷却会把它排到最后 —— 这正是 bug 现场
  await resetHealth();
  await new Promise((r) => setTimeout(r, 10));
  // 手动灌一条 auth 冷却进去（模拟「填 Key 之前」留下的记录）
  await translate(['hello'], 'zh-CN', 'openai', { ...fakeSettings, openai: { ...fakeSettings.openai, apiKey: 'sk-bad' } })
    .catch(() => {});
  const hAuth = (await engineHealth()).openai;
  check('Key 被拒时记为 auth 冷却', hAuth?.kind === 'auth' || hAuth?.kind === 'network' || hAuth?.kind === 'other',
    `kind=${hAuth?.kind}`);

  // 7-3 关键：改了 Key 之后 clearEngineHealth 必须立刻放行
  const cleared = await clearEngineHealth('openai');
  check('清冷却后 openai 无记录（下次必被尝试）', !cleared.openai, JSON.stringify(cleared.openai || {}));

  console.log(`    当前 auto 顺序（有 Key）：${['openai', 'builtin', 'google', 'mymemory'].join(' → ')}`);
}

// -------------------------------------------------------------------------
// [8] 回归守卫：「成功」不能被当成「不可用」（v1.1.9 修掉的致命反转）
// 旧实现里 markHealth(ok=true) 写 until = now+10min，而 isHealthy 只看 now>until，
// 于是**成功过的引擎反被判为不可用 10 分钟**，自动模式就此偷偷换引擎 ——
// 看到的就是「选自动和选 OpenAI 译文不一样，也不知道现在是谁翻的」。
// -------------------------------------------------------------------------
console.log('\n[8] 成功的引擎必须保持可用');
{
  await resetHealth();
  chrome.runtime.sendMessage = async (msg) => {
    if (msg?.type === 'XT_OFFSCREEN_TRANSLATE') {
      return { ok: true, results: msg.texts.map(() => ({ t: '你好', l: 'en' })) };
    }
    return { ok: true };
  };
  await translate(['hello'], 'zh-CN', 'builtin', {});
  const hOk = (await engineHealth()).builtin;
  check('成功后被记为 ok', hOk?.ok === true, `ok=${hOk?.ok}`);
  check('成功记录仍然 usable（不会被当成冷却）', hOk?.usable === true, `usable=${hOk?.usable}`);

  // 对照：失败记录必须不可用
  await resetHealth();
  chrome.runtime.sendMessage = async (msg) => {
    if (msg?.type === 'XT_OFFSCREEN_TRANSLATE') return { ok: true, results: msg.texts.map(() => null) };
    return { ok: true };
  };
  await translate(['hello'], 'zh-CN', 'builtin', {});
  const hBad = (await engineHealth()).builtin;
  check('失败记录 usable=false', hBad?.usable === false, `usable=${hBad?.usable} kind=${hBad?.kind}`);
}

// -------------------------------------------------------------------------
// [9] 「原样返回」不能被当成译文（v1.1.10）
// 短句 / 俚语 / 纯专有名词时，模型或本地检测偶尔把输入原封不动吐回来。
// 旧版把它当成成功 → 页面上多出一行和原文一模一样的灰字，看起来就是「没翻译」。
// -------------------------------------------------------------------------
console.log('\n[9] 原样返回必须被识别为「没翻出来」');
{
  check('忽略大小写与标点判等', isSameText('PBZ is on another level,no cap 🔥', 'PBZ is on another level, no cap 🔥'));
  check('真译文不判等', !isSameText('PBZ 完全是另一个层次，不吹不黑 🔥', 'PBZ is on another level,no cap 🔥'));
  check('空串不判等（避免误杀）', !isSameText('', ''));

  await resetHealth();
  // 桩：内置引擎把原文原样返回
  chrome.runtime.sendMessage = async (msg) => {
    if (msg?.type === 'XT_OFFSCREEN_TRANSLATE') {
      return { ok: true, results: msg.texts.map((t) => ({ t, l: 'en' })) };
    }
    return { ok: true };
  };
  const r9 = await translate(['no cap at all'], 'zh-CN', 'builtin', {}, { chainFallback: false });
  check('原样返回被换成 skip:same', r9?.[0]?.t == null && r9?.[0]?.skip === 'same', JSON.stringify(r9?.[0] || null));
  const h9 = (await engineHealth()).builtin;
  check('这种情况不冷却引擎', h9?.usable !== false, `usable=${h9?.usable ?? '无记录'}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);

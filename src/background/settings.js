// 设置读写与默认值
export const DEFAULTS = {
  enabled: true,
  targetLang: 'zh-CN',
  engine: 'auto',
  displayMode: 'bilingual', // bilingual | inline | replace
  minLength: 2,
  maxCharsPerItem: 4000,
  skipSameLang: true,
  // 手动添加的站点（域名数组，不带 www）。命中后走 generic.js 通用适配
  customSites: [],
  x: {
    enabled: true,
    tweets: true,
    profile: false
  },
  // GitHub：界面文案走本地词典（零请求），README / 简介走模型
  github: {
    enabled: true,
    menu: true,
    readme: true,
    issues: true,
    // 提交信息（仓库首页「最近提交信息」列、/commits 列表）走模型翻译
    commits: true
  },
  youtube: {
    enabled: true,
    title: true,
    description: true,
    comments: true,
    cards: true,
    captions: true,
    captionSize: 22
  },
  microsoft: {},
  mymemory: { concurrency: 2, gap: 220 },
  google: {},
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini'
  },
  builtin: {
    sourceLang: 'auto'
  }
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

export async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return deepMerge(DEFAULTS, stored.settings || {});
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = deepMerge(cur, patch);
  await chrome.storage.local.set({ settings: next });
  return next;
}

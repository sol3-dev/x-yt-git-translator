# X / YouTube / GitHub 双语翻译

Chrome 扩展。给 X、YouTube、GitHub 加一层中文对照，原文保持不动。

## 安装

1. 下载或克隆这个仓库
2. 打开 `chrome://extensions`
3. 右上角打开「开发者模式」
4. 点「加载已解压的扩展程序」，选这个文件夹

Edge 走 `edge://extensions`，步骤一样。没有构建步骤，也不依赖 npm 包。

## 能翻什么

| 站点 | 内容 |
|---|---|
| X | 推文正文、个人简介；时间线滚动出来的新推文自动跟上 |
| YouTube | 标题、简介、评论、列表卡片标题、实时字幕 |
| GitHub | 界面文案、README、仓库简介、提交信息、议题标题 |
| 其它网站 | 点扩展图标 →「翻译此网站」，之后访问该域名自动翻 |

GitHub 的界面文案走本地词典（900+ 条词条、60 条数字/组合规则），**零请求**，翻不中的保持英文，不会出现「Home → 家」这类机翻。README、简介、提交信息这类正文走模型，术语按原样保留（C++、Rust、Zig、Kubernetes、PR…）。

## 翻译引擎

| 引擎 | 说明 |
|---|---|
| 自动（默认） | 配了 Key 用 Key，没有就依次退到 Chrome 本地模型 → Google → MyMemory |
| OpenAI 兼容 | DeepSeek / 通义 / 本地 Ollama / llama.cpp 都能填，质量最好 |
| Chrome 内置 | 设备端模型，离线、免费、不限量，首次使用要下载 |
| Google | 免费接口，国内需要代理 |
| MyMemory | 免费，有频率限制 |

用 DeepSeek 的话：Base URL 填 `https://api.deepseek.com`，模型填 `deepseek-flash`。

Key 只存在浏览器本地（`chrome.storage.local`），不会发到别处。

## 显示方式

- **双语对照**（默认）：原文下面追加一条中文，中间一条细线
- **行内追加**：紧贴原文，不画线
- **替换原文**：只留译文

## 设置

扩展图标 → 齿轮，或者 `chrome://extensions` → 详情 → 扩展选项。

每个站点、每个板块都能单独关；也能配超时、并发、跳过已经是中文的内容。

## 文件结构

```
manifest.json
src/
  background/   引擎、缓存、设置、消息路由
  content/      各站适配（x / youtube / github / generic）+ 共享内核
  options/      设置页
  popup/        工具栏弹窗
  offscreen/    Chrome 内置翻译的宿主页面
test/           验证脚本（Node + Playwright，不是运行依赖）
```

## 已知限制

- 画布型编辑器（Google Docs、Notion、Figma）没有可读的文本节点，翻不出来
- YouTube 字幕要求视频本身已有字幕（含自动生成）
- X 虚拟滚动复用节点，偶尔会闪一下再自动纠正
- 图片里的文字不处理

## 开发

改完代码在 `chrome://extensions` 点一下刷新按钮就生效。

跑验证脚本需要 Node，以及一份 `playwright-core`：

```bash
set XT_PW=C:\path\to\node_modules\playwright-core     # macOS/Linux 用 export
node test/engine-check.mjs      # 引擎选择与冷却逻辑
node test/github-labels.mjs     # 界面词典断言
node test/github-verify.mjs     # GitHub 界面 mock 验证
node test/yt-verify.mjs         # YouTube mock 验证
```


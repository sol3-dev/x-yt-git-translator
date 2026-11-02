/* =========================================================================
 * GitHub 适配层
 * -------------------------------------------------------------------------
 * GitHub 和其他站点不一样：它的界面文本是「产品文案」，不是阅读正文。
 * 拿模型逐条翻会有三个必然的毛病：慢（几十次请求）、术语飘（Pull Request 一会
 * 叫拉取请求一会叫合并请求）、像机翻（Home→"家"、Stars→"星星"）。
 *
 * 所以这里分两层，各用各的办法：
 *
 *   ① 界面文案（左侧导航 / 账号菜单 / 仓库页签 / 按钮）→ **本地词典，原位替换**
 *      零请求、零延迟、术语统一。翻不中的不碰，宁可留英文也不乱翻。
 *   ② 阅读内容（仓库简介 / README / Issue 与 PR 正文）→ 走模型，双语对照，
 *      并带上「技术术语保持原样」的提示词（C++ / Rust / Zig / Kubernetes …）。
 *
 * 另外两个坑：
 *   - 新版 GitHub 前端用 CSS Modules，类名带构建哈希（description__ej4leF），
 *     所以结构类只能按前缀匹配：[class*="SharedMarkdownContent"]。
 *   - 页面是 Turbo 局部导航，DOM 会被整块换掉 → 必须用 MutationObserver 重扫。
 * ========================================================================= */
(() => {
  const NS = globalThis.__XT;
  if (!NS?.core) return;
  const core = NS.core;

  /* =======================================================================
   * 一、界面文案词典
   * -----------------------------------------------------------------------
   * 译法尽量贴 GitHub 中文版的习惯（issue=议题、pull request=拉取请求、
   * repository=仓库、star=星标），并刻意**保留**这些不该翻的东西：
   *   Codespaces / Copilot / Actions / Gists / MCP / Enterprise 等产品名。
   * 键统一小写，值就是最终显示文本。
   * ===================================================================== */
  const UI_DICT = {
    'home': '首页',
    'feed': '动态',
    'all issues': '所有议题',
    'all pull requests': '所有拉取请求',
    'all repositories': '所有仓库',
    'projects': '项目',
    'discussions': '讨论',
    'codespaces': 'Codespaces',
    'copilot': 'Copilot',
    'explore': '探索',
    'marketplace': '市场',
    'mcp registry': 'MCP 注册表',
    'top repositories': '热门仓库',
    'trending': '热门趋势',
    'trending repos': '热门仓库',
    'collections': '集合',
    'events': '活动',
    'sponsors': '赞助',
    'github sponsors': 'GitHub 赞助',
    'set status': '设置状态',
    'profile': '个人资料',
    'repositories': '仓库',
    'stars': '星标',
    'gists': 'Gists',
    'organizations': '组织',
    'enterprises': '企业',
    'settings': '设置',
    'copilot settings': 'Copilot 设置',
    'feature preview': '功能预览',
    'appearance': '外观',
    'accessibility': '无障碍',
    'try enterprise': '试用企业版',
    'sign out': '退出登录',
    'your profile': '你的个人资料',
    'your repositories': '你的仓库',
    'your copilot': '你的 Copilot',
    'your stars': '你的星标',
    'your gists': '你的 Gists',
    'your projects': '你的项目',
    'your organizations': '你的组织',
    'your enterprises': '你的企业',
    'upgrade': '升级',
    'new': '新',
    'code': '代码',
    'issues': '议题',
    'pull requests': '拉取请求',
    'wiki': 'Wiki',
    'security': '安全',
    'insights': '洞察',
    'settings tab': '设置',
    'watch': '关注',
    'unwatch': '取消关注',
    'fork': '派生',
    'star': '星标',
    'starred': '已星标',
    'about': '关于',
    'releases': '发行版',
    'packages': '软件包',
    'contributors': '贡献者',
    'languages': '语言',
    'activity': '动态',
    'readme': '自述文件',
    'license': '许可证',
    'go to file': '转到文件',
    'add file': '添加文件',
    'latest commit': '最新提交',
    'commits': '提交',
    'branches': '分支',
    'tags': '标签',
    'search or jump to': '搜索或跳转',
    'type / to search': '输入 / 搜索',
    'search': '搜索',
    'copy': '复制',
    'download zip': '下载 ZIP',
    'raw': '原始文件',
    'blame': '追溯',
    'history': '历史',
    'open': '开放',
    'closed': '已关闭',
    'merged': '已合并',
    'draft': '草稿',
    'new issue': '新建议题',
    'new pull request': '新建拉取请求',
    'compare': '比较',
    'preview': '预览',
    'write': '编辑',
    'edit': '编辑',
    'save': '保存',
    'cancel': '取消',
    'comment': '评论',
    'subscribe': '订阅',
    'unsubscribe': '取消订阅',
    'public': '公开',
    'private': '私有',
    'pin': '置顶',
    'unpin': '取消置顶',
    'report abuse': '举报滥用',
    'people': '成员',
    'latest release': '最新发行版',
    'no description, website, or topics provided.': '未提供简介、网站或主题标签。',
    'sponsor': '赞助',
    'follow': '关注',
    'following': '已关注',
    'unfollow': '取消关注',
    'sign in': '登录',
    'sign up': '注册',
    'search github': '搜索 GitHub',
    'back': '返回',
    'next': '下一页',
    'previous': '上一页',
    'loading': '加载中',
    'more': '更多',
    'show more': '显示更多',
    'show less': '显示更少',
    'security and quality': '安全与代码质量',
    watching: '关注',
    forks: '派生',
    'used by': '被使用',
    notifications: '通知',
    'report repository': '举报仓库',
    'more actions': '更多操作',
    'add to list': '加入列表',
    'download': '下载',
    'use this template': '使用此模板',
    'sync fork': '同步派生',
    'contribute': '参与贡献',
    'discuss': '讨论',
    'issue': '议题',
    'pull request': '拉取请求',
    'action': '操作',
    'results': '结果',
    'filter': '筛选',
    'sort': '排序',
    'clear': '清除',
    'close': '关闭',
    'submit': '提交',
    products: '产品',
    developers: '开发者',
    businesses: '企业',
    resources: '资源',
    pricing: '定价',
    'solutions': '解决方案',
    'team': '团队',
    'startups': '初创公司',
    'customers': '客户',
    'enterprise': '企业版',
    'partners': '合作伙伴',
    'education': '教育',
    'open source': '开源',
    'security lab': '安全实验室',
    'site-wide announcements': '全站公告',
    'read the docs': '阅读文档',
    'compare plans': '对比方案',
    'contact sales': '联系销售',

    // ---------- 仓库 / 组织主页的各种区块与列表 ----------
    actions: '自动化',
    'code of conduct': '行为准则',
    overview: '概览',
    "this organization has no public members. you must be a member to see who's a part of this organization.":
      '该组织暂无公开成员。你必须是成员才能查看组织成员。',
    'this user has no public members.': '该用户暂无公开成员。',
    'no members found': '未找到成员',
    'read the contributing guide': '阅读贡献指南',
    'custom properties': '自定义属性',
    'popular repositories': '热门仓库',
    'top languages': '主要语言',
    'pinned': '置顶',
    'forked from': '派生自',
    'repositories list': '仓库列表',
    'find a repository…': '查找仓库…',
    'find a repository...': '查找仓库…',
    'type': '类型',
    'language': '语言',
    'label': '标签',
    'labels': '标签',
    'milestone': '里程碑',
    'assignee': '负责人',
    'reviewer': '审查者',
    'new discussion': '新建讨论',
    'view all discussions': '查看所有讨论',
    'categories': '分类',
    'announcements': '公告',
    'general': '综合',
    'ideas': '想法',
    'polls': '投票',
    'q&a': '问答',
    'show and tell': '展示与分享',
    'most helpful': '最有帮助',
    'latest': '最新',
    'deployments': '部署',
    'environments': '环境',
    'projects (classic)': '项目（经典）',
    'nsfw': '成人内容',
    'muted': '已静音',
    'archived': '已归档',
    'template': '模板',
    'mirror': '镜像',
    'sponsorable': '可赞助',
    'unlisted': '未列出',
    'beta': '测试版',
    'pre-release': '预发布',
    'search or filter': '搜索或筛选',
    'back to top': '回到顶部',
    'permissions': '权限',
    'read more': '阅读更多',
    'show all': '显示全部',
    'see all': '查看全部',
    'view all': '查看全部',
    'load more': '加载更多',

    // ---------- 成员 / 软件包 / 仓库列表 三个页签 ----------
    all: '全部',
    'contributed by me': '我参与贡献的',
    'admin access': '管理权限',
    'sources': '源仓库',
    'templates': '模板',
    'collapse sidebar': '收起侧栏',
    'search repositories': '搜索仓库',
    'find a member…': '查找成员…',
    'find a member...': '查找成员…',
    'search packages…': '搜索软件包…',
    'search packages...': '搜索软件包…',
    'organization permissions': '组织权限',
    'members': '成员',
    'github packages': 'GitHub Packages',
    'linked artifacts': '关联构件',
    'visibility': '可见性',
    'visibility:': '可见性：',
    'type:': '类型：',
    'published': '发布于',
    'last pushed': '最近推送',
    'view all repositories': '查看所有仓库',
    'repository navigation': '仓库导航',
    'folders and files': '文件夹与文件',
    'name': '名称',
    'last commit message': '最近提交信息',
    'last commit date': '最近提交时间',
    'files': '文件',
    'filter files by name': '按名称筛选文件',

    // ---------- Issues / PR 列表 ----------
    'assigned to me': '分配给我',
    'created by me': '我创建的',
    'mentioned': '提及我',
    'recent activity': '最近活动',
    'views': '浏览',
    'milestones': '里程碑',
    'feedback': '反馈',
    'search issues': '搜索议题',
    'author': '作者',
    'assignees': '负责人',
    'types': '类型',
    'newest': '最新',
    'status:': '状态：',
    'unconfirmed': '未确认',
    'bug': '缺陷',
    'unread': '未读',
    'filter by author': '按作者筛选',
    'select all': '全选',
    'opened': '创建于',
    'commented': '评论于',

    // ---------- 「+」新建菜单 ----------
    'new repository': '新建仓库',
    'import repository': '导入仓库',
    'new codespace': '新建 Codespace',
    'new gist': '新建 Gist',
    'new organization': '新建组织',
    'new project': '新建项目',

    // ---------- Copilot 菜单 ----------
    'ask copilot…': '向 Copilot 提问…',
    'ask copilot...': '向 Copilot 提问…',
    'in immersive chat': '在沉浸式对话中',
    'in a space': '在空间中',
    'download for…': '下载…',
    'download for...': '下载…',

    // ---------- 通知页 ----------
    'search notifications': '搜索通知',
    'dismiss': '忽略',
    'get started': '立即开始',
    'saved': '已保存',
    'done': '已完成',
    'filters': '筛选器',
    'assigned': '已分配',
    'participating': '参与中',
    'team mentioned': '团队被提及',
    'review requested': '请求审查',
    'add new filter': '添加筛选器',
    'manage notifications': '管理通知',
    'prev': '上一页',
    'clear out the clutter.': '清理收件箱里的杂讯。',
    'newest to oldest': '最新到最旧',
    'oldest to newest': '最旧到最新',
    'group by:': '分组：',
    'group by': '分组',
    // ProTip 那句被 <kbd>e</kbd> 切成三段，只能逐段翻
    'when viewing a notification, press': '查看通知时，按',
    'to mark it as done.': '即可标记为已完成。',

    // ---------- 设置页 / 生成 Token 页 ----------
    'public profile': '公开资料',
    'account': '账户',
    'account settings': '账户设置',
    'billing and plans': '账单与套餐',
    'billing and licensing': '账单与许可',
    'emails': '邮箱',
    'password and authentication': '密码与身份验证',
    'sessions': '会话',
    'ssh and gpg keys': 'SSH 与 GPG 密钥',
    'applications': '应用程序',
    'scheduled reminders': '定时提醒',
    'security log': '安全日志',
    'sponsorship log': '赞助日志',
    'developer settings': '开发者设置',
    'personal access tokens': '个人访问令牌',
    'tokens (classic)': '令牌（经典）',
    'tokens': '令牌',
    'fine-grained tokens': '细粒度令牌',
    'generate new token': '生成新令牌',
    'generate new token (classic)': '生成新令牌（经典）',
    'classic': '经典版',
    'note': '备注',
    'expiration': '有效期',
    'select scopes': '选择权限范围',
    'scopes': '权限范围',
    'scopes:': '权限范围：',
    'delete': '删除',
    'delete token': '删除令牌',
    'regenerate': '重新生成',
    'revoke': '撤销',
    'revoke all': '全部撤销',
    'regenerate token': '重新生成令牌',
    'git over http (recommended)': '通过 HTTP 使用 Git（推荐）',
    'personal access tokens (classic)': '个人访问令牌（经典）',
    'personal access tokens (fine-grained)': '个人访问令牌（细粒度）',
    'manage personal access tokens': '管理个人访问令牌',
    'you need a token to use the github api': '使用 GitHub API 需要令牌',
    'expires on': '过期于',
    'never': '永不',
    'no expiration': '永不过期',
    'last used within the last week': '最近一周内使用过',
    'select the scopes': '选择权限范围',
    'required scopes': '必需权限',
    'optional scopes': '可选权限',
    'danger zone': '危险操作区',
    'save changes': '保存更改',
    'confirm': '确认',
    'enable': '启用',
    'disable': '禁用',
    'enabled': '已启用',
    'disabled': '已禁用',
    'email': '邮箱',
    'password': '密码',
    'username': '用户名',
    'full name': '全名',
    'bio': '个人简介',
    'company': '公司',
    'location': '所在地',
    'website': '网站',
    'timezone': '时区',
    'theme': '主题',
    'font size': '字号',
    'tab size': '制表符宽度',
    'default': '默认',
    'custom': '自定义',
    'details': '详情',
    'status': '状态',
    'value': '值',
    'reviewed': '审查于',
    'protip!': '小提示！',
    'english': 'English',

    // ---------- 页脚 ----------
    'terms': '使用条款',
    'privacy': '隐私',
    'community': '社区',
    'docs': '文档',
    'contact': '联系我们',
    'manage cookies': '管理 Cookie',
    'do not share my personal information': '不要分享我的个人信息',
    'site-wide links': '全站链接',
    'find code, projects, and people on github:': '在 GitHub 上查找代码、项目与用户：',
    'contact support': '联系客服',

    // ---------- 个人主页：贡献图 ----------
    'contribution graph': '贡献图',
    'contribution activity': '贡献动态',
    'day of week': '星期',
    'skip to contributions year list': '跳转到贡献年份列表',
    'learn how we count contributions': '了解我们如何统计贡献',
    'less': '少',
    'no contributions.': '无贡献。',
    'low contributions.': '少量贡献。',
    'medium-low contributions.': '中低贡献。',
    'medium-high contributions.': '中高贡献。',
    'high contributions.': '高贡献。',
    'show more activity': '显示更多动态',
    'footer navigation': '页脚导航',

    // ---------- 登录 / 注册页 ----------
    'sign in to github': '登录 GitHub',
    'username or email address': '用户名或邮箱地址',
    'forgot password?': '忘记密码？',
    'forgot password': '忘记密码',
    'create an account': '创建账号',
    'continue with google': '使用 Google 继续',
    'continue with apple': '使用 Apple 继续',
    'sign in with a passkey': '使用通行密钥登录',
    'sign in with a passkey instead': '改用通行密钥登录',
    'email address': '邮箱地址',
    'new to github?': '初次使用 GitHub？',
    'terms of service': '服务条款',
    'privacy statement': '隐私声明',
    'two-factor authentication': '双重身份验证',
    'authentication code': '验证码',
    'verify': '验证',
    'resend': '重新发送',
    'device verification': '设备验证',
    'verify your device': '验证你的设备',
    'we just sent your authentication code via email to': '我们已将验证码通过邮件发送至',

    // ===== 2026-11-02 按真实登录态扫描补齐（settings 全站）=====
    "using a comma within certain filters will aggregate the results. for example:": "在部分筛选条件里用逗号可以聚合结果。例如：",
    "will show all repositories that have either go or ruby as their primary language.": "会显示主语言为 Go 或 Ruby 的所有仓库。",
    "using a comma within certain filters will aggregate the results. for example": "在部分筛选条件里用逗号可以聚合结果。例如",
    "great repository names are short and memorable. how about": "好的仓库名应当简短好记。比如",
    "owner": "所有者",
    "choose visibility": "选择可见性",
    "repositories contain a project's files and version history.": "仓库用于存放项目的文件和版本历史。",
    "have a project elsewhere?": "项目在别处？",
    "how about": "比如",
    "readmes can be used as longer descriptions.": "README 可用作更长的描述。",
    ".gitignore tells git which files not to track.": ".gitignore 告诉 git 哪些文件不纳入跟踪。",
    "licenses explain how others can use your code.": "许可证说明他人可以如何使用你的代码。",
    "characters": "字符",
    "name cannot be blank.": "名称不能为空。",
    "create a new repository": "新建仓库",
    "import a repository": "导入仓库",
    "required fields are marked with an asterisk (*).": "必填字段标有星号（*）。",
    "repository owner and name": "仓库所有者与名称",
    "(required)": "（必填）",
    "repository name": "仓库名称",
    "description": "描述",
    "configuration": "配置",
    "choose who can see and commit to this repository": "选择谁可以查看此仓库并向其提交",
    "choose visibility *": "选择可见性 *",
    "add readme": "添加 README",
    "about readmes": "关于 README",
    "add .gitignore": "添加 .gitignore",
    "about ignoring files": "关于忽略文件",
    "no .gitignore": "无 .gitignore",
    "about licenses": "关于许可证",
    "add license": "添加许可证",
    "no license": "无许可证",
    "create repository": "创建仓库",
    "owner *": "所有者 *",
    "great repository names are short and memorable.": "好的仓库名应当简短好记。",
    "repositories contain a project's files and version history. have a project elsewhere?": "仓库用于存放项目的文件和版本历史。项目在别处？",
    "name cannot be blank": "名称不能为空",
    "initialize this repository with:": "初始化此仓库：",
    "inbox": "收件箱",
    "no saved views": "没有已保存的视图",
    "authored by me": "我创建的",
    "involves me": "与我相关",
    "review requests": "审查请求",
    "select repositories": "选择仓库",
    "customize your view": "自定义你的视图",
    "tailor your inbox to fit your workflow, or pick a different view to open by default at github.com/pulls": "按你的工作流定制收件箱，或选择默认在 github.com/pulls 打开的视图",
    "needs your review": "等待你审查",
    "needs your teams' review": "等待你团队审查",
    "your drafts": "你的草稿",
    "waiting for review or checks": "等待审查或检查",
    "needs action": "需要处理",
    "ready to merge": "可以合并",
    "saved views": "已保存的视图",
    "my contributions": "我的贡献",
    "my repositories": "我的仓库",
    "my forks": "我的派生",
    "relevance": "相关度",
    "your teams": "你的团队",
    "most recent": "最近",
    "block user": "屏蔽用户",
    "unblock user": "取消屏蔽",
    "youtube": "YouTube",
    "system": "系统",
    "to search": "搜索",
    "type to search": "输入 / 搜索",
    "seen in jp": "在日本使用",
    "once you delete your account, there is no going back. please be certain.": "账号一旦删除将无法恢复，请务必确认。",
    "choose how github looks to you. select a single theme, or sync with your system and automatically switch between day and night themes. selections are applied immediately and saved automatically.": "选择 GitHub 的显示外观。可以固定使用一个主题，也可以跟随系统在日间与夜间主题之间自动切换。选择会立即生效并自动保存。",
    "this theme will be active when your system is set to \"light mode\"": "系统处于「浅色模式」时将使用此主题",
    "this theme will be active when your system is set to \"dark mode\"": "系统处于「深色模式」时将使用此主题",
    "enable high contrast for light or dark mode (or both) based on your system settings": "根据系统设置，为浅色或深色模式（或两者）启用高对比度",
    "choose the number of spaces a tab is equal to when rendering code": "选择渲染代码时一个制表符相当于几个空格",
    "font preference for plain text editors that support markdown styling (e.g. pull request and issue descriptions, comments.)": "支持 Markdown 样式的纯文本编辑器字体偏好（例如拉取请求与议题的描述、评论）。",
    "toggle the visibility of underlines on links that are adjacent to text.": "切换正文旁链接的下划线是否可见。",
    "pasting a url while having text selected will format to a markdown link": "选中文本时粘贴网址，会格式化为 Markdown 链接",
    "pasting a url while having text selected will replace the text": "选中文本时粘贴网址，会替换所选文本",
    "add or remove instructions for how to operate complex controls.": "添加或移除复杂控件的操作说明。",
    "choose where you'd like emails to be sent. you can add more email addresses. use custom routes to specify different email addresses to be used for individual organizations.": "选择希望接收邮件的地址。你可以添加更多邮箱，并使用自定义路由为各个组织指定不同的收件地址。",
    "notifications for all repositories, teams, or conversations you're watching.": "你关注的所有仓库、团队或会话的通知。",
    "notifications for the conversations you are participating in, or if someone cites you with an @mention. also for all activity when subscribed to specific events.": "你参与的会话，或有人用 @ 提及你时的通知；订阅特定事件后，也会收到这些事件的全部动态。",
    "choose which additional events you'll receive emails for when participating or watching.": "选择在参与或关注时，还会通过邮件通知你的额外事件。",
    "email a regular summary of dependabot alerts for up to 10 of your repositories.": "为最多 10 个仓库定期发送 Dependabot 提醒摘要邮件。",
    "receive email notifications about security campaigns in repositories where you have access to security alerts.": "在你可查看安全提醒的仓库中，接收关于安全活动的邮件通知。",
    "when you are given admin permissions to an organization, automatically receive notifications when a new deploy key is added.": "获得组织管理员权限后，在新增部署密钥时自动接收通知。",
    "get tips, solutions and exclusive offers from github about products, services and events we think you might find interesting.": "接收 GitHub 关于你可能感兴趣的产品、服务和活动的技巧、方案与专属优惠。",
    "total billable usage after subtracting discounts from consumed usage": "从已用用量中扣除折扣后的计费用量总计",
    "you have a single verified email associated with your github account. add an additional verified email address in case you lose access to your primary email.": "你的 GitHub 账号只关联了一个已验证邮箱。建议再添加一个已验证邮箱，以防无法访问主邮箱。",
    "this email address is the default for github notifications, such as replies to issues, pull requests, and similar activity.": "此邮箱用作 GitHub 通知的默认地址，例如议题、拉取请求的回复等。",
    "select an email to be used for account-related notifications and can be used for password reset.": "选择一个用于账号相关通知、并可用于重置密码的邮箱。",
    "your backup github email address will be used as an additional destination for security-relevant account notifications and can also be used for password resets.": "备用 GitHub 邮箱将作为安全相关账号通知的附加收件地址，也可用于重置密码。",
    "previously authored commits associated with a public email will remain public.": "此前使用公开邮箱提交的记录仍将保持公开。",
    "when you push to github, we'll check the most recent commit. if the author email on that commit is a private email on your github account, we will block the push and warn you about exposing your private email.": "当你推送到 GitHub 时，我们会检查最近的提交。如果该提交的作者邮箱是你账号上的私密邮箱，我们会阻止这次推送，并提醒你存在泄露私密邮箱的风险。",
    "this is a list of devices that have logged into your account. revoke any sessions that you do not recognize.": "以下是登录过你账号的设备列表。请撤销任何你不认识的会话。",
    "other users will see the time difference from their local time.": "其他用户会看到与其本地时间的时差。",
    "enabling this will hide your contributions and activity from your github profile and from social features like followers, stars, feeds, leaderboards and releases.": "启用后，将从你的 GitHub 资料页以及关注者、星标、动态、排行榜和发行版等社交功能中隐藏你的贡献与动态。",
    "designed for businesses or teams who collaborate on github.com": "适用于在 GitHub.com 上协作的企业或团队",
    "by enabling, your codespaces will be able to pull from vs code settings sync service and push only for the trusted repositories you specify. only enable this for repositories that you trust.": "启用后，你的 Codespaces 可从 VS Code 设置同步服务拉取，并仅向你指定的受信任仓库推送。请只对信任的仓库启用。",
    "when enabled, you will receive emails when your codespaces are nearing deletion due to inactivity.": "启用后，当你的 Codespaces 因长期闲置即将被删除时，你会收到邮件提醒。",
    "warning notifications for codespace deletions will be enabled": "将启用 Codespace 删除的警告通知",
    "the following repositories will be referenced by gpg verification and settings sync.": "以下仓库将被 GPG 验证和设置同步引用。",
    "gpg signing and vs code settings sync will be available for codespaces for all repositories": "GPG 签名和 VS Code 设置同步将在所有仓库的 Codespaces 中可用",
    "gpg signing and vs code settings sync will be available for codespaces from the selected repositories": "GPG 签名和 VS Code 设置同步将在所选仓库的 Codespaces 中可用",
    "gpg and vs code settings sync will be available for codespaces from these repositories.": "GPG 和 VS Code 设置同步将在这些仓库的 Codespaces 中可用。",
    "codespaces you create for your personal account can either be restricted to accessing the repository it was opened for, or granted read access to other repositories you own.": "你为个人账号创建的 Codespaces，可以限制为仅访问打开时所在的仓库，也可以授予对你拥有的其他仓库的只读权限。",
    "limit access of personal codespaces to the repository they were opened for": "将个人 Codespaces 的访问限制在打开时所在的仓库",
    "personal codespaces created for specific repositories can access other repositories i own": "为特定仓库创建的个人 Codespaces 可以访问我拥有的其他仓库",
    "use a beta image configuration when available. otherwise, use the latest stable configuration.": "有 Beta 镜像配置时使用它，否则使用最新的稳定配置。",
    "we will determine the closest available region based on your location (ip address) at codespace creation time.": "我们会在创建 Codespace 时，根据你的位置（IP 地址）确定最近的可用区域。",
    "this setting will be applied to new container, npm, rubygems and nuget packages.": "此设置将应用于新建的 Container、npm、rubygems 和 NuGet 软件包。",
    "these are packages that have been previously deleted belonging to you. you can restore a package deleted within the last 30 days.": "这些是你之前删除过的软件包。最近 30 天内删除的软件包可以恢复。",
    "organizations can provide their members (including you) and their teams access to github copilot.": "组织可以为其成员（包括你）和团队提供 GitHub Copilot 访问权限。",
    "verify domains to restrict who can publish github pages on them.": "验证域名，以限制谁可以在其上发布 GitHub Pages。",
    "want to build something that integrates with and extends github? register a new github app to get started developing on the github api.": "想构建与 GitHub 集成并扩展其功能的项目？注册一个新的 GitHub App，即可开始在 GitHub API 上开发。",
    "your name may appear around github where you contribute or are mentioned. you can remove it at any time.": "你的名字可能出现在 GitHub 上你参与贡献或被提及的地方，随时可以移除。",
    "select a verified email to display": "选择一个已验证的邮箱用于展示",
    "you have set your email address to private. to toggle email privacy, go to": "你已将邮箱地址设为私密。要切换邮箱隐私，请前往",
    "and uncheck": "并取消勾选",
    "tell us a little bit about yourself": "简单介绍一下你自己",
    "you can mention other users and organizations to link to them.": "你可以在此提及其他用户和组织，为它们建立关联。",
    "link to social profile": "社交主页链接",
    "name may appear around github where you contribute or are mentioned.": "你的名字可能出现在 GitHub 上你参与贡献或被提及的地方。",
    "default notifications email": "默认通知邮箱",
    "custom routing": "自定义路由",
    "view watched repositories": "查看关注中的仓库",
    "participating, @mentions and custom": "参与中、提及与自定义",
    "customize email updates": "自定义邮件更新",
    "reviews, pushes, comments": "审查、推送、评论",
    "ignored repositories": "已忽略的仓库",
    "you'll never be notified.": "你将不会收到通知。",
    "view ignored repositories": "查看已忽略的仓库",
    "on github, email. (failed workflows only)": "在 GitHub、邮件（仅失败的工作流）",
    "dependabot alerts: new vulnerabilities": "Dependabot 提醒：新漏洞",
    "dependabot alerts": "Dependabot 提醒",
    "on github, email, cli": "在 GitHub、邮件、CLI",
    "dependabot alerts: email digest": "Dependabot 提醒：邮件摘要",
    "don't send": "不发送",
    "security campaign emails": "安全活动邮件",
    "agent sessions": "代理会话",
    "notifications for agent sessions that you started.": "你发起的代理会话的通知。",
    "'deploy key' alert email": "「部署密钥」提醒邮件",
    "in-product messages": "产品内消息",
    "current metered usage": "当前按量用量",
    "current included usage": "当前包含用量",
    "more details": "更多详情",
    "next payment due": "下次付款时间",
    "subscriptions": "订阅",
    "manage subscriptions": "管理订阅",
    "per month": "每月",
    "metered usage": "按量用量",
    "timeframe: current month": "时间范围：本月",
    "usage by products": "按产品统计用量",
    "products selector navigation": "产品选择导航",
    "billable usage": "计费用量",
    "view details": "查看详情",
    "consumed usage": "已用用量",
    "included usage": "包含用量",
    "manage budgets": "管理预算",
    "compute": "计算",
    "actions storage": "Actions 存储",
    "usage by repository": "按仓库统计用量",
    "no usage found": "未发现用量",
    "primary": "主要",
    "verified": "已验证",
    "connected to google": "已连接 Google",
    "add": "添加",
    "primary email address": "主要邮箱地址",
    "select email to become primary": "选择设为主要邮箱",
    "backup email address": "备用邮箱地址",
    "select email to become backup": "选择设为备用邮箱",
    "keep my email addresses private": "保持邮箱地址私密",
    "set your email in git": "在 Git 中设置邮箱",
    "block command line pushes that expose my email": "阻止会暴露邮箱的命令行推送",
    "web sessions": "网页会话",
    "your current session": "当前会话",
    "github mobile sessions": "GitHub Mobile 会话",
    "learn more about authentication with github mobile.": "了解使用 GitHub Mobile 进行身份验证。",
    "ssh keys": "SSH 密钥",
    "new ssh key": "新建 SSH 密钥",
    "there are no ssh keys associated with your account.": "你的账号没有关联任何 SSH 密钥。",
    "connecting to github using ssh keys": "使用 SSH 密钥连接 GitHub",
    "common ssh problems": "常见 SSH 问题",
    "gpg keys": "GPG 密钥",
    "new gpg key": "新建 GPG 密钥",
    "there are no gpg keys associated with your account.": "你的账号没有关联任何 GPG 密钥。",
    "generate a gpg key and add it to your account": "生成 GPG 密钥并添加到账号",
    "vigilant mode": "警戒模式",
    "learn about vigilant mode": "了解警戒模式",
    "you are not a member of any organizations.": "你尚未加入任何组织。",
    "move to an organization": "迁移到组织",
    "move work to an organization": "将工作迁移到组织",
    "you don't have any enterprises": "你没有任何企业账号",
    "start free for 30 days": "免费试用 30 天",
    "learn more about enterprises": "了解更多企业版信息",
    "repository default branch": "仓库默认分支",
    "learn more about default branches.": "了解默认分支。",
    "update": "更新",
    "commit comments": "提交评论",
    "commit comments:": "提交评论：",
    "enabled by default": "默认启用",
    "0 collaborators": "0 位协作者",
    "dotfiles": "点文件",
    "automatically install dotfiles": "自动安装点文件",
    "learn how to set up your dotfiles for codespaces.": "了解如何为 Codespaces 设置点文件。",
    "secrets": "机密",
    "codespace user secrets": "Codespace 用户机密",
    "learn more": "了解更多",
    "there are no codespace secrets.": "没有 Codespace 机密。",
    "new secret": "新建机密",
    "gpg verification": "GPG 验证",
    "gpg signing will be available in codespaces": "GPG 签名将在 Codespaces 中可用",
    "settings sync": "设置同步",
    "vs code settings sync will be available in codespaces": "VS Code 设置同步将在 Codespaces 中可用",
    "trusted repositories": "受信任的仓库",
    "select repository": "选择仓库",
    "deprecated": "已弃用",
    "all codespaces can access other repositories i own": "所有 Codespaces 均可访问我拥有的其他仓库",
    "editor preference": "编辑器偏好",
    "edit and preview changes straight from the browser.": "直接在浏览器中编辑和预览更改。",
    "edit and run notebooks from the browser with jupyterlab.": "使用 JupyterLab 在浏览器中编辑并运行笔记本。",
    "default idle timeout": "默认空闲超时",
    "default retention period": "默认保留期",
    "learn about retention setting": "了解保留期设置",
    "host image version preference": "主机镜像版本偏好",
    "learn more about host images": "了解更多主机镜像",
    "stable": "稳定版",
    "always use the latest stable configuration.": "始终使用最新的稳定配置。",
    "region": "区域",
    "set automatically": "自动设置",
    "set manually": "手动设置",
    "choose your default region": "选择默认区域",
    "packages permissions": "软件包权限",
    "default package setting": "默认软件包设置",
    "deleted packages": "已删除的软件包",
    "start using copilot free": "开始使用 Copilot Free",
    "buy copilot pro": "购买 Copilot Pro",
    "allow github to use my data for ai model training": "允许 GitHub 使用我的数据训练 AI 模型",
    "github's privacy statement": "GitHub 隐私声明",
    "show copilot": "显示 Copilot",
    "get copilot from an organization": "从组织获取 Copilot",
    "you do not belong to any organizations.": "你不属于任何组织。",
    "create an organization": "创建组织",
    "verified domains": "已验证域名",
    "add a domain": "添加域名",
    "there are no verified domains.": "没有已验证的域名。",
    "learn more about working with saved replies": "了解如何使用已保存回复",
    "no saved replies yet.": "还没有已保存回复。",
    "add a saved reply": "添加已保存回复",
    "saved reply title": "已保存回复标题",
    "add your saved reply": "添加你的已保存回复",
    "is supported": "支持",
    "paste, drop, or click to add files": "粘贴、拖放或点击添加文件",
    "add saved reply": "添加已保存回复",
    "no github apps": "没有 GitHub Apps",
    "new github app": "新建 GitHub App",
    "view documentation": "查看文档",
    "installed github apps": "已安装的 GitHub Apps",
    "authorized github apps": "已授权的 GitHub Apps",
    "authorized oauth apps": "已授权的 OAuth Apps",
    "no installed github apps": "没有已安装的 GitHub Apps",
    "you have no github apps installed on this account.": "此账号没有安装任何 GitHub Apps。",
    "visit marketplace": "访问市场",
    "my github apps": "我的 GitHub Apps",
    "github apps": "GitHub Apps",
    "oauth apps": "OAuth Apps",
    "customize your pins": "自定义置顶",
    "you don't have any public repositories yet.": "你还没有公开仓库。",
    "created their first repository": "创建了第一个仓库",
    "first repository": "第一个仓库",
    "github profile guide": "GitHub 个人资料指南",
    "create list": "创建列表",
    "create your first list": "创建你的第一个列表",
    "create your first list.": "创建你的第一个列表。",
    "showing results": "显示结果",
    "you don't have any starred repositories yet.": "你还没有星标任何仓库。",
    "explore github": "探索 GitHub",
    "public archive": "公开归档",
    "selected repositories": "已选择的仓库",
    "access": "访问权限",
    "usage": "用量",
    "ai usage": "AI 用量",
    "budgets and alerts": "预算与提醒",
    "licensing": "许可",
    "payment information": "付款信息",
    "additional billing details": "附加账单信息",
    "education benefits": "教育优惠",
    "credentials": "凭据",
    "moderation": "内容审核",
    "blocked users": "已屏蔽用户",
    "interaction limits": "互动限制",
    "code review limits": "代码审查限制",
    "code, planning, and automation": "代码、规划与自动化",
    "features": "功能",
    "cloud": "云端",
    "code security": "代码安全",
    "integrations": "集成",
    "archives": "归档",
    "payment history": "付款历史",
    "saved replies": "已保存回复",
    "your personal account": "你的个人账号",
    "on": "开",
    "off": "关",
    "notify me:": "通知我：",
    "hovercards": "悬停卡片",
    "on github, email": "在 GitHub、邮件",
    "public email": "公开邮箱",
    "email settings": "邮箱设置",
    "pronouns": "代词",
    "url": "网址",
    "social accounts": "社交账号",
    "display current local time": "显示当前本地时间",
    "time zone": "时区",
    "connect your orcid id": "关联 ORCID iD",
    "update profile": "更新资料",
    "profile picture": "头像",
    "contributions & activity": "贡献与动态",
    "make profile private and hide activity": "将资料设为私有并隐藏动态",
    "include private contributions on my profile": "在资料页显示私有贡献",
    "profile settings": "资料设置",
    "show achievements on my profile": "在资料页显示成就",
    "your achievements will be shown on your profile.": "你的成就将展示在资料页。",
    "github developer program": "GitHub 开发者计划",
    "join the github developer program": "加入 GitHub 开发者计划",
    "jobs profile": "求职资料",
    "available for hire": "可接受雇佣",
    "save jobs profile": "保存求职资料",
    "trending settings": "趋势设置",
    "preferred spoken language": "首选口语",
    "trending repositories": "热门仓库",
    "edit profile": "编辑资料",
    "@mention": "提及",
    "selected theme:": "已选主题：",
    "active": "当前",
    "contrast": "对比度",
    "increase contrast": "提高对比度",
    "light mode": "浅色模式",
    "dark mode": "深色模式",
    "theme preferences": "主题偏好",
    "theme mode": "主题模式",
    "github theme will match your system active settings": "GitHub 主题将跟随系统的当前设置",
    "emoji skin tone preference": "表情肤色偏好",
    "preferred default emoji skin tone": "首选默认表情肤色",
    "neutral": "中性",
    "light skin tone": "浅肤色",
    "medium-light skin tone": "中浅肤色",
    "medium skin tone": "中肤色",
    "medium-dark skin tone": "中深肤色",
    "dark skin tone": "深肤色",
    "tab size preference": "制表符宽度偏好",
    "markdown editor font preference": "Markdown 编辑器字体偏好",
    "keyboard shortcuts": "键盘快捷键",
    "character keys": "字符键",
    "save keyboard shortcut preferences": "保存键盘快捷键偏好",
    "motion": "动效",
    "autoplay animated images": "自动播放动图",
    "select whether animated images should play automatically.": "选择动图是否自动播放。",
    "sync with system": "跟随系统",
    "adopts your system preference for reduced motion": "采用系统「减少动效」偏好",
    "automatically plays animated images": "自动播放动图",
    "prevents animated images from playing automatically": "阻止动图自动播放",
    "save motion preferences": "保存动效偏好",
    "content": "内容",
    "link underlines": "链接下划线",
    "hide link underlines": "隐藏链接下划线",
    "show link underlines": "显示链接下划线",
    "save content preferences": "保存内容偏好",
    "show hovercards": "显示悬停卡片",
    "save hovercard preferences": "保存悬停卡片偏好",
    "editor settings": "编辑器设置",
    "url paste behavior": "URL 粘贴行为",
    "formatted link": "格式化链接",
    "plain text": "纯文本",
    "save editor settings": "保存编辑器设置",
    "assistive technology hints": "辅助技术提示",
    "enable screen reader hint": "启用屏幕阅读器提示",
    "disable screen reader hint": "禁用屏幕阅读器提示",
    "save assistive technology hint preferences": "保存辅助技术提示偏好",
    "change username": "更改用户名",
    "unintended side effects": "意外副作用",
    "link patreon account": "关联 Patreon 账号",
    "connect with patreon": "连接 Patreon",
    "export account data": "导出账号数据",
    "successor settings": "继任者设置",
    "designated below": "在下方指定",
    "learn more about account successors.": "了解账号继任者。",
    "search by username, full name, or email address": "按用户名、全名或邮箱地址搜索",
    "add successor": "添加继任者",
    "you have not designated a successor.": "你尚未指定继任者。",
    "delete account": "删除账号",
    "delete your account": "删除你的账号",
    'block or report user': '屏蔽或举报用户',
    'block or report': '屏蔽或举报',
    'contributions in the last year': '去年的贡献',
    'contribution settings': '贡献设置',
    'achievements': '成就',
    'highlights': '亮点',
    'pro': 'Pro',
    'organizations i belong to': '我所属的组织',
    'stars i have given': '我给出的星标',

    // ---------- 月份 / 星期（贡献图坐标轴，也是日历控件） ----------
    'january': '1月', 'february': '2月', 'march': '3月', 'april': '4月',
    'may': '5月', 'june': '6月', 'july': '7月', 'august': '8月',
    'september': '9月', 'october': '10月', 'november': '11月', 'december': '12月',
    'jan': '1月', 'feb': '2月', 'mar': '3月', 'apr': '4月', 'jun': '6月',
    'jul': '7月', 'aug': '8月', 'sep': '9月', 'sept': '9月', 'oct': '10月',
    'nov': '11月', 'dec': '12月',
    'sunday': '周日', 'monday': '周一', 'tuesday': '周二', 'wednesday': '周三',
    'thursday': '周四', 'friday': '周五', 'saturday': '周六',
    'sun': '周日', 'mon': '周一', 'tue': '周二', 'wed': '周三',
    'thu': '周四', 'fri': '周五', 'sat': '周六',
    // 下拉按钮的文案常被拆成「标签 + 冒号 + 值」三段，逐段翻才不会剩英文
    'sort by:': '排序：',
    'sort by': '排序',
    'filter:': '筛选：',
    'label:': '标签：',
    'latest activity': '最近活动',
    'help wanted': '急需帮助',
    'good first issue': '新手友好',
    'answer': '答案',
    'answered': '已解答',
    'unanswered': '未解答',
    'sticky': '置顶',
    'locked': '已锁定',

    // ---------- 仓库设置页（/settings）----------
    "collaborators": "协作者",
    "rulesets": "规则集",
    "runners": "运行器",
    "policies": "策略",
    "policy insights": "策略洞察",
    "webhooks": "Webhook",
    "code review": "代码审查",
    "internet access": "互联网访问",
    "mcp servers": "MCP 服务器",
    "dreaming": "Dreaming",
    "dreaming preview": "Dreaming 预览",
    "planning": "规划",
    "agent suggestions for issues": "议题的 Agent 建议",
    "deploy keys": "部署密钥",
    "secrets and variables": "机密与变量",
    "agents": "Agents",
    "template repository": "模板仓库",
    "template repositories let users generate new repositories with the same directory structure and files.": "模板仓库让别人可以用相同的目录结构和文件生成新仓库。",
    "learn more about template repositories": "了解模板仓库的更多信息",
    "default branch": "默认分支",
    "the default branch is considered the \"base\" branch in your repository, against which all pull requests and code commits are automatically made, unless you specify a different branch.": "默认分支是仓库的「基础」分支，所有拉取请求和代码提交默认都针对它，除非你指定其他分支。",
    "rename this branch": "重命名此分支",
    "rename branch": "重命名分支",
    "uh oh!": "出错了！",
    "there was an error while loading. please reload this page.": "加载时出错，请重新加载此页面。",
    "please reload this page": "请重新加载此页面",
    "enable release immutability": "启用发行版不可变性",
    "disallow assets and tags from being modified once a release is published.": "发行版发布后，禁止修改其资产与标签。",
    "wikis": "Wiki",
    "wikis host documentation for your repository.": "Wiki 用于托管仓库文档。",
    "upgrade or make this repository public to enable wikis": "升级或将仓库设为公开以启用 Wiki",
    "github wikis is a simple way to let others contribute content. any github user can create and edit pages to use for documentation, examples, support, or anything you wish.": "GitHub Wiki 让别人能轻松贡献内容：任何 GitHub 账号都可以创建和编辑页面，用作文档、示例、支持说明，或者你想用的任何用途。",
    "learn more about wikis": "了解 Wiki 的更多信息",
    "issues integrate lightweight task tracking into your repository. keep projects on track with issue labels and milestones, and reference them in commit messages.": "议题把轻量级任务跟踪带进仓库：用议题标签和里程碑让项目不跑偏，还能在提交信息里引用它们。",
    "issue permissions": "议题权限",
    "creation allowed by:": "创建权限：",
    "all users": "所有账号",
    "anyone can create an issue": "任何人都可以创建议题",
    "collaborators only": "仅协作者",
    "only collaborators can create issues": "只有协作者可以创建议题",
    "if restricted, issues will still be readable by everyone who can see this repository.": "即使做了限制，能看到此仓库的人仍然可以阅读议题。",
    "get organized with issue templates": "用议题模板理清流程",
    "give contributors issue templates that help you cut through the noise and help them push your project forward.": "给贡献者提供议题模板，帮他们过滤噪音、把项目往前推。",
    "set up templates": "设置模板",
    "sponsorships": "赞助",
    "sponsorships help your community know how to financially support this repository.": "赞助让社区知道如何资助这个仓库。",
    "display a \"sponsor\" button": "显示「赞助」按钮",
    "add links to github sponsors or third-party methods your repository accepts for financial contributions to your project.": "添加 GitHub 赞助或第三方赞助方式的链接，说明本仓库接受哪些资助渠道。",
    "set up sponsor button": "设置赞助按钮",
    "discussions is the space for your community to have conversations, ask questions and post answers without opening issues.": "讨论区让社区在不开议题的情况下交流、提问和答题。",
    "get started with discussions": "开始使用讨论",
    "engage your community by having discussions right in your repository, where your community already lives": "把讨论放在仓库里 —— 社区本来就在这里，参与度自然更高。",
    "pull requests allow others to suggest changes to your repository.": "拉取请求让别人可以建议对仓库做修改。",
    "pull request permissions": "拉取请求权限",
    "anyone can create a pull request": "任何人都可以创建拉取请求",
    "only collaborators can create prs": "只有协作者可以创建 PR",
    "if restricted, pull requests will still be readable by everyone who can see this repository.": "即使做了限制，能看到此仓库的人仍然可以阅读拉取请求。",
    "you must select at least one option": "至少要选择一项",
    "you must select squashing or rebasing option. this is because linear history is required on at least one protected branch.": "必须选择压缩合并或变基合并其中一项：至少有一个受保护分支要求线性历史。",
    "allow merge commits": "允许合并提交",
    "add all commits from the head branch to the base branch with a merge commit.": "用一个合并提交，把头分支的所有提交并入基础分支。",
    "default commit message": "默认提交信息",
    "presented when merging a pull request with merge.": "以合并方式合并拉取请求时显示。",
    "default message": "默认信息",
    "pull request title": "拉取请求标题",
    "pull request title and description": "拉取请求标题和描述",
    "pull request title and commit details": "拉取请求标题和提交详情",
    "allow squash merging": "允许压缩合并",
    "combine all commits from the head branch into a single commit in the base branch.": "把头分支的所有提交压成基础分支里的单个提交。",
    "presented when merging a pull request with squash.": "以压缩方式合并拉取请求时显示。",
    "allow rebase merging": "允许变基合并",
    "add all commits from the head branch onto the base branch individually.": "把头分支的提交逐个叠加到基础分支上。",
    "control how and when users are prompted to update their branches if there are new changes available in the base branch.": "控制基础分支有新改动时，何时、以何种方式提示更新分支。",
    "always suggest updating pull request branches": "始终建议更新拉取请求分支",
    "whenever there are new changes available in the base branch, present an \"update branch\" option in the pull request.": "基础分支一有新改动，就在拉取请求里给出「更新分支」选项。",
    "you can allow setting pull requests to merge automatically once all required reviews and status checks have passed.": "可以允许拉取请求在所需审查和状态检查全部通过后自动合并。",
    "allow auto-merge": "允许自动合并",
    "waits for merge requirements to be met and then merges automatically. why is this option disabled?": "等合并条件满足后自动合并。为什么此选项被禁用？",
    "why is this option disabled?": "为什么此选项被禁用？",
    "after pull requests are merged, you can have head branches deleted automatically.": "拉取请求合并后，可以自动删除头分支。",
    "automatically delete head branches": "自动删除头分支",
    "deleted branches will still be able to be restored.": "被删除的分支仍然可以恢复。",
    "require contributors to sign off on web-based commits": "要求贡献者在网页提交上签名",
    "developer certificate of origin (dco)": "开发者原创声明（DCO）",
    "learn more about signing off on commits": "了解提交签名的更多信息",
    "allow comments on individual commits": "允许对单个提交发表评论",
    "when creating source code archives, you can choose to include files stored using git lfs in the archive.": "创建源代码归档时，可以选择把用 Git LFS 存储的文件一并打包。",
    "include git lfs objects in archives": "在归档中包含 Git LFS 对象",
    "git lfs usage in archives is billed at the same rate as usage with the client.": "归档中的 Git LFS 用量按与客户端相同的费率计费。",
    "after merging a pull request, linked issues can be closed automatically.": "拉取请求合并后，可以自动关闭关联的议题。",
    "auto-close issues with merged linked pull requests": "合并关联拉取请求时自动关闭议题",
    "whenever linked pull requests have merged, auto-close the issue.": "关联的拉取请求一旦合并，就自动关闭该议题。",
    "change visibility": "更改可见性",
    "change to public": "改为公开",
    "make this repository public": "将此仓库设为公开",
    "i want to make this repository public": "我想将此仓库设为公开",
    "this repository is currently private.": "此仓库当前为私有。",
    "disable branch protection rules enforcement and apis": "禁用分支保护规则执行与 API",
    "disable branch protection rules": "禁用分支保护规则",
    "this will hide the branch protection settings and disable branch protection rules for this repository.": "这会隐藏分支保护设置，并禁用此仓库的分支保护规则。",
    "disabling branch protection rules allows you to enforce branch and tag protections exclusively with repository rules.": "禁用分支保护规则后，分支与标签保护将完全由仓库规则接管。",
    "this action will disable:": "此操作将禁用：",
    "branch protection rule enforcement": "分支保护规则执行",
    "branch protection rule apis": "分支保护规则 API",
    "transfer this repository to another user or to an organization where you have the ability to create repositories.": "把此仓库转让给别的账号，或转让给你有建仓权限的组织。",
    "transfer": "转让",
    "mark this repository as archived and read-only.": "把此仓库标记为归档并设为只读。",
    "archive this repository": "归档此仓库",
    "all scheduled workflows will stop running.": "所有定时工作流都将停止运行。",
    "before you archive, please consider:": "归档前请先考虑：",
    "updating any repository settings": "更新仓库设置",
    "closing all open issues and pull requests": "关闭所有开放的议题和拉取请求",
    "making a note in your readme": "在 README 里写一条说明",
    "i understand the consequences, archive this repository": "我了解后果，归档此仓库",
    "delete this repository": "删除此仓库",
    "i want to delete this repository": "我想删除此仓库",
    "once you delete a repository, there is no going back. please be certain.": "仓库一旦删除就无法恢复，请务必确认。",
    "rename": "重命名",
    "archive repository": "归档仓库",
    "change repository visibility": "更改仓库可见性",
    "transfer ownership": "转让所有权",
    "set up discussions": "设置讨论",
    "when merging pull requests, you can allow any combination of merge commits, squashing, or rebasing. at least one option must be enabled. if you have linear history requirement enabled on any protected branch, you must enable squashing or rebasing.": "合并拉取请求时，可以任意组合使用合并提交、压缩合并或变基合并，至少要启用其中一种。如果任何受保护分支启用了线性历史要求，就必须启用压缩合并或变基合并。",
    "projects on github are created at the repository owner's level (organization or user) and can be linked to a repository's projects tab. projects are suitable for cross-repository development efforts such as feature work, complex product roadmaps or even issue triage.": "GitHub 上的项目创建在仓库所有者（组织或账号）这一层，可以关联到仓库的项目页签。项目适合跨仓库的开发工作，比如特性开发、复杂的产品路线图，甚至议题分类。",
    "will be disabled as part of this action": "将在此操作中被禁用",
    "please type": "请输入",
    "to confirm.": "以确认。",
  };

  // 相对时间：GitHub 的 "Updated 1 hour ago" 是拼出来的，词典装不下
  const REL = [
    [/^just now$/i, '刚刚'],
    [/^today$/i, '今天'],
    [/^yesterday$/i, '昨天'],
    [/^last week$/i, '上周'],
    [/^last month$/i, '上个月'],
    [/^last year$/i, '去年'],
    [/^(\d+)\s+second(?:s)? ago$/i, (m) => `${m[1]} 秒前`],
    [/^(\d+)\s+minute(?:s)? ago$/i, (m) => `${m[1]} 分钟前`],
    [/^(\d+)\s+hour(?:s)? ago$/i, (m) => `${m[1]} 小时前`],
    [/^(\d+)\s+day(?:s)? ago$/i, (m) => `${m[1]} 天前`],
    [/^(\d+)\s+week(?:s)? ago$/i, (m) => `${m[1]} 周前`],
    [/^(\d+)\s+month(?:s)? ago$/i, (m) => `${m[1]} 个月前`],
    [/^(\d+)\s+year(?:s)? ago$/i, (m) => `${m[1]} 年前`]
  ];

  function relTime(text) {
    const t = String(text || '').trim();
    for (const [re, rep] of REL) {
      const m = t.match(re);
      if (!m) continue;
      return typeof rep === 'function' ? rep(m) : rep;
    }
    return null;
  }

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  // 议题/PR 的状态与类型取值
  const TYPE_WORDS = {
    unconfirmed: '未确认',
    bug: '缺陷',
    'bug report': '缺陷报告',
    enhancement: '功能增强',
    feature: '新功能',
    documentation: '文档',
    'help wanted': '急需帮助',
    'good first issue': '新手友好',
    duplicate: '重复',
    'wontfix': '不予修复',
    invalid: '无效',
    question: '问题',
    open: '开放',
    closed: '已关闭',
    draft: '草稿',
    merged: '已合并',
    'needs triage': '待分类',
    confirmed: '已确认',
    'in progress': '处理中'
  };

  // 下拉框里的取值（Sort by / Filter 后面那截）
  const VALUE_WORDS = {
    'latest activity': '最近活动',
    newest: '最新',
    oldest: '最早',
    'most commented': '评论最多',
    'most reactions': '回应最多',
    open: '开放',
    closed: '已关闭',
    'most starred': '星标最多',
    'recently updated': '最近更新'
  };

  // 带数字 / 带可变部分的短语，用规则处理
  const UI_RULES = [
    // "Updated 1 hour ago" / "Updated yesterday"
    [/^updated\s+(.+)$/i, (m) => (relTime(m[1]) || m[1]) + '更新'],
    // "Forked from nuuhara/xsystem4"
    [/^forked from\s+(.+)$/i, (m) => `派生自 ${m[1]}`],
    // "Sort by: Latest activity" / "Filter: Open"
    [/^sort by:\s*(.+)$/i, (m) => `排序：${VALUE_WORDS[m[1].toLowerCase()] || m[1]}`],
    [/^filter:\s*(.+)$/i, (m) => `筛选：${VALUE_WORDS[m[1].toLowerCase()] || m[1]}`],
    // "24 open" / "14 closed"
    [/^(\d+)\s+open$/i, (m) => `${m[1]} 个开放`],
    [/^(\d+)\s+closed$/i, (m) => `${m[1]} 个已关闭`],
    // "1 issue needs help"
    [/^(\d+)\s+issues? need(?:s)? help$/i, (m) => `${m[1]} 个议题需要协助`],
    // "GPL-3.0 license" / "GPL-3.0, License licenses found"
    [/^(.+),\s*license licenses found$/i, (m) => `发现许可证：${m[1]}`],
    [/^(.+)\s+license$/i, (m) => `${m[1]} 许可证`],
    // 计数
    [/^(\d+)\s+releases?$/i, (m) => `${m[1]} 个发行版`],
    [/^(\d+)\s+packages?$/i, (m) => `${m[1]} 个软件包`],
    [/^(\d+)\s+repositories?$/i, (m) => `${m[1]} 个仓库`],
    [/^(\d+)\s+projects?$/i, (m) => `${m[1]} 个项目`],
    [/^(\d+)\s+members?$/i, (m) => `${m[1]} 位成员`],
    [/^(\d+)\s+people$/i, (m) => `${m[1]} 人`],
    [/^([\d.,]+\s*[kKmM]?)\s+stars?$/i, (m) => `${m[1]} 星标`],
    [/^([\d.,]+\s*[kKmM]?)\s+watching$/i, (m) => `${m[1]} 关注`],
    [/^([\d.,]+\s*[kKmM]?)\s+forks?$/i, (m) => `${m[1]} 派生`],
    [/^([\d.,]+\s*[kKmM]?)\s+contributors?$/i, (m) => `${m[1]} 贡献者`],
    [/^([\d.,]+\s*[kKmM]?)\s+commits?$/i, (m) => `${m[1]} 次提交`],
    [/^([\d.,]+\s*[kKmM]?)\s+branches?$/i, (m) => `${m[1]} 个分支`],
    [/^([\d.,]+\s*[kKmM]?)\s+tags?$/i, (m) => `${m[1]} 个标签`],
    [/^\+\s*([\d.,]+\s*[kKmM]?)\s+contributors?$/i, (m) => `+ ${m[1]} 贡献者`],
    // 日期：Oct 26, 2026 → 2026年10月26日
    [/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/, (m) => {
      const i = MONTHS.indexOf(m[1].toLowerCase());
      return i < 0 ? null : `${m[3]}年${i + 1}月${m[2]}日`;
    }],
    // 括号包起来的提示：(1 issue needs help)
    [/^\((\d+)\s+issues? need(?:s)? help\)$/i, (m) => `（${m[1]} 个议题需要协助）`],
    // 分页提示：Showing 10 of 20 repositories
    [/^showing\s+(\d+)\s+of\s+(\d+)\s+(repositories|packages|packages?)$/i, (m) => `显示 ${m[2]} 个中的 ${m[1]} 个`],
    // 「Updated」单独成节点时（后面紧跟 <relative-time> 组件）
    [/^updated$/i, () => '更新于'],
    // 状态/类型徽标："Status: Unconfirmed" / "Type: Bug"（是整块文本，不是一个词）
    [/^(status|type)\s*:\s*(.+)$/i, (m) => {
      const label = m[1].toLowerCase() === 'status' ? '状态' : '类型';
      const val = TYPE_WORDS[m[2].toLowerCase()] || m[2];
      return `${label}：${val}`;
    }],
    // "opened on Oct 31, 2026" / "closed on ..."
    [/^(opened|closed|merged|created|updated)\s+on\s+([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/i, (m) => {
      const i = MONTHS.indexOf(m[2].toLowerCase());
      if (i < 0) return null;
      const verb = { opened: '创建于', closed: '关闭于', merged: '合并于', created: '创建于', updated: '更新于' }[
        m[1].toLowerCase()
      ];
      return `${verb} ${m[4]}年${i + 1}月${m[3]}日`;
    }],
    // 分组方式：Group by: Date
    [/^group by\s*:\s*(.+)$/i, (m) => `分组：${m[1].toLowerCase() === 'date' ? '日期' : m[1]}`],
    // 「aetherkiri doesn’t have any public repositories yet.」——组织名是变量
    [/^(.+?)\s+doesn[’']?t have any (?:public )?repositories yet\.?$/i, (m) => `${m[1]} 暂无公开仓库。`],
    [/^(.+?)\s+hasn[’']?t created any (?:public )?repositories yet\.?$/i, (m) => `${m[1]} 尚未创建公开仓库。`],
    // 分页：1-1 of 1 → 第 1-1 条，共 1 条
    [/^(\d+)\s*-\s*(\d+)\s+of\s+(\d+)$/, (m) => `第 ${m[1]}-${m[2]} 条，共 ${m[3]} 条`],
    // 贡献统计：2 contributions in the last year → 去年 2 次贡献
    [/^(\d+)\s+contributions?\s+in\s+the\s+last\s+year$/i, (m) => `去年 ${m[1]} 次贡献`],
    // 某人暂无动态：xxx has no activity yet for this period.
    [/^(.+?)\s+has\s+no\s+activity\s+yet\s+for\s+this\s+period\.?$/i, (m) => `${m[1]} 在此期间暂无动态。`],
    [/^(.+?)\s+has\s+no\s+recent\s+activity\.?$/i, (m) => `${m[1]} 近期暂无动态。`],
    // fork 分支状态：20h behind / 3 days ahead / 1 commit behind
    // 实际文本常带前导符号（"- 20h behind"），要允许前缀，否则匹配不上
    [/^[-–—·]?\s*(\d+\s*[a-z]+)\s+behind$/i, (m) => `落后 ${m[1]}`],
    [/^[-–—·]?\s*(\d+\s*[a-z]+)\s+ahead$/i, (m) => `领先 ${m[1]}`],
    [/^(\d+)\s+commits?\s+behind$/i, (m) => `落后 ${m[1]} 个提交`],
    [/^(\d+)\s+commits?\s+ahead$/i, (m) => `领先 ${m[1]} 个提交`],
    // 贡献动态：Created 2 commits in 1 repository
    [/^created\s+(\d+)\s+commits?\s+in\s+(\d+)\s+reposit(?:ory|ories)$/i,
      (m) => `在 ${m[2]} 个仓库中创建了 ${m[1]} 个提交`],
    // 贡献图里的日期标签（无年份）：Nov 1 → 11月1日
    [/^([A-Za-z]{3})\s+(\d{1,2})$/, (m) => {
      const i = MONTHS.indexOf(m[1].toLowerCase());
      return i < 0 ? null : `${i + 1}月${m[2]}日`;
    }],
    // 用量：$0 used / $12.00 included
    [/^(.+?)\s+used\s*\/\s*(.+?)\s+included$/i, (m) => `已用 ${m[1]} / 包含 ${m[2]}`],
    // 已选择 N 个仓库
    [/^selected\s+(\d+)\s+repositories?\.?$/i, (m) => `已选择 ${m[1]} 个仓库。`],
    // 软件包：No recoverable packages were found for xxx.
    [/^no recoverable packages were found for\s+(.+?)\.?$/i, (m) => `未找到 ${m[1]} 可恢复的软件包。`],
    // 占位符：Link to social profile 1
    [/^link to social profile\s*(\d+)?$/i, (m) => (m[1] ? `社交主页链接 ${m[1]}` : '社交主页链接')],
    // 私有贡献可见性：Only people who can see owner/repo can see this contribution
    [/^only people who can see\s+(.+?)\s+can see this contribution$/i,
      (m) => `只有能看到 ${m[1]} 的人才能看到这条贡献`],
    // 关注数：49 followers · 1 following
    [/^(\d+)\s+followers?$/i, (m) => `${m[1]} 关注者`],
    [/^(\d+)\s+following$/i, (m) => `${m[1]} 正在关注`],
    // 字符计数：0 / 350 characters
    [/^(\d+)\s*\/\s*(\d+)\s+characters$/i, (m) => `${m[1]} / ${m[2]} 字符`],
    // 下拉按钮：Updated: Last month
    [/^updated:\s*(.+)$/i, (m) => `更新于：${relTime(m[1]) || m[1]}`],
    // 日期前缀：on Nov 1, 2026 → 于 2026年11月1日
    [/^on\s+([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/i, (m) => {
      const i = MONTHS.indexOf(m[1].toLowerCase());
      return i < 0 ? null : `于 ${m[3]}年${i + 1}月${m[2]}日`;
    }],
    // ---------- 仓库设置页：仓库名/数字是变量，只能走规则 ----------
    [/^settings:\s*(\S+\/\S+)$/i, (m) => `设置：${m[1]}`],
    [/^make\s+(\S+\/\S+)\s+public$/i, (m) => `将 ${m[1]} 设为公开`],
    [/^delete\s+(\S+\/\S+)$/i, (m) => `删除 ${m[1]}`],
    [/^please type\s+(\S+\/\S+)\s+to confirm\.?$/i, (m) => `请输入 ${m[1]} 以确认。`],
    [/^(\d+)\s+stars?\s+(\d+)\s+watchers?$/i, (m) => `${m[1]} 星标 ${m[2]} 关注`],
    [/^(\d+)\s+branch protection rules?\s+will be disabled as part of this action$/i,
      (m) => `此操作将禁用 ${m[1]} 条分支保护规则`],
    [/^switch repository\s*\(alt shift r\)$/i, () => '切换仓库（Alt+Shift+R）'],
    // 「0 branch protection rules」在 <strong> 里，数字留在原位
    [/^(\d+)\s+branch protection rules?$/i, (m) => `${m[1]} 条分支保护规则`]

  ];

  /** 词典 → 规则 → 相对时间，统一入口。
   *  文本节点和 input 占位符共用这一套，避免两处逻辑漂移。 */
  function lookup(raw) {
    const t = String(raw || '').trim();
    if (!t) return null;
    const hit = UI_DICT[normKey(t)];
    if (hit) return hit;
    const rel = relTime(t);
    if (rel) return rel;
    for (const [re, rep] of UI_RULES) {
      const m = t.match(re);
      if (!m) continue;
      const out = typeof rep === 'function' ? rep(m) : t.replace(re, rep);
      if (out) return out; // 规则内部可能返回 null（例如月份不识别），跳过继续试
    }
    return null;
  }

  // 这些区域里的文本一律不碰（代码本身就是内容）
  const SKIP_SEL = [
    'pre',
    'code',
    'script',
    'style',
    'noscript',
    'textarea',
    'input',
    'svg',
    'kbd',
    'samp',
    '[contenteditable="true"]',
    // 搜索框里的查询语法（is:issue state:open）绝对不能翻，否则一提交就搜不到东西。
    // 注意：**不能**用 [role="search"] —— 它会把整块搜索区域里的 label、button
    // 一起排掉（"Add Successor"、"Search by username…" 就是这么漏掉的）。
    // 查询语法本身是 input 的 value 属性，TreeWalker 遍历文本节点根本碰不到，
    // 再加上 input / combobox / aria-autocomplete 三层已经足够。
    '[role="combobox"]',
    '[aria-autocomplete]',
    '[class*="query-builder"]',
    'input[type="text"][name*="q"]',
    '[data-xt-skip]',
    '.xt-translation'
  ].join(',');

  // 界面文案的作用域：导航 / 顶栏 / 各类菜单弹层 / 页签
  const UI_SCOPE_SEL = [
    // main 覆盖仓库页签、右侧 About 栏、分支/标签栏这类「页面框架」区域。
    // 只做整段精确匹配 + 数字规则，所以正文不会被误伤（代码块还有 SKIP_SEL 兜着）。
    'main',
    'nav',
    'header',
    // 页脚在登录后是精简版（Terms / Privacy / Status / Docs…），词条已备好
    'footer',
    // 个人主页左侧栏：GitHub 用的是 div 布局，不是 <aside>。
    // Follow 按钮挂在 span.user-following-container ← span.d-table-cell ← .vcard-* 里，
    // 只加 aside 抓不到（实测 aside 内按钮数为 0）。
    'aside',
    '[class*="vcard"]',
    '.user-following-container',
    '[class*="profile-header"]',
    // 注意：不要把 a.btn / button 加进作用域。
    // Follow 按钮是 GitHub 的 js-form-toggle-target 动态组件，
    // 直接替换它的文本会让组件在重新渲染时把按钮清空（实测变成空白按钮），
    // 比留英文更糟。按钮文案交给它们自己的容器命中即可。
    '[role="navigation"]',
    '[role="menu"]',
    '[role="dialog"]',
    '[role="tablist"]',
    '[popover]',
    'details',
    '[class*="AppHeader"]',
    '[class*="HeaderMenu"]',
    '[class*="prc-ActionList"]',
    '[class*="dropdown"]',
    '[class*="menu"]'
  ].join(',');

  // 阅读内容
  const MD_SEL = '[class*="SharedMarkdownContent"], .markdown-body, [data-testid="readme"]';
  const DESC_SEL = [
    '[class*="description__"]',
    '[data-testid="repository-description"]',
    'p.f4.my-3',
    // 组织页 / 个人主页的置顶仓库卡片
    'p.pinned-item-desc',
    '[class*="pinned-item-desc"]',
    // 仓库列表（Repositories 页签）每行的简介
    'p.tmp-mb-3.color-fg-muted',
    'p.color-fg-muted.tmp-mb-3',
    // org / user 的 Repositories 页签：每行简介是 div，不是 p
    '.repos-list-description',
    '[class*="repos-list-description"]',
    // ★ 个人主页 Repositories 页签里，每个仓库的简介挂在
    //   <p itemprop="description"> 上（类名是 col-9 d-inline-block color-fg-muted，
    //   没有可依赖的哈希后缀）。itemprop 是语义属性，换版也不会变，最稳。
    '[itemprop="description"]'
  ].join(',');

  // 归一化：GitHub 有些文案用的是弯引号（who’s），和词典里的 straight quote 对不上，
  // 直接导致整句匹配失败。这里统一成 ASCII 单/双引号，再去空白、转小写。
  const normKey = (s) =>
    String(s || '')
      .replace(/[\u2018\u2019\u02bc]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      // 零宽字符：GitHub 有些文案（尤其带图标的价格/按钮）会混进 ZWSP / BOM，
      // trim() 去不掉，导致整段匹配永远失败 —— "per month" 就是这么漏的。
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  /* ---------------------- ① 界面文案：原位替换 ---------------------- */

  function replaceInTextNode(node) {
    const raw = node.nodeValue;
    if (!raw || !raw.trim()) return false;

    const zh = lookup(raw);
    if (!zh || zh === raw.trim()) return false;

    const parent = node.parentElement;
    if (!parent) return false;
    if (parent.closest(SKIP_SEL)) return false;

    // 保留原有的前后空白，避免把布局里的空格吃掉
    const lead = raw.match(/^\s*/)[0];
    const trail = raw.match(/\s*$/)[0];
    node.nodeValue = lead + zh + trail;
    parent.dataset.xtUi = '1';
    if (!parent.dataset.xtUiOrig) parent.dataset.xtUiOrig = raw.trim();
    return true;
  }

  /**
   * 相对时间元素（relative-time）。
   * ---------------------------------------------------------------------
   * GitHub 列表里的「4 months ago」「last week」不是普通文本：
   * 它是 <relative-time datetime="...">，文字由组件自己渲染（可能在 shadow DOM 里），
   * TreeWalker 根本走不到，所以前面几版这些时间一直没翻。
   * 这里按 datetime 自己算，再写回（有 shadowRoot 就写 shadowRoot）。
   */
  function formatRelative(iso) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return null;
    const diff = Date.now() - t;
    if (diff < 0) return null;
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时前`;
    const day = Math.floor(hr / 24);
    if (day === 1) return '昨天';
    if (day < 7) return `${day} 天前`;
    const wk = Math.floor(day / 7);
    if (day < 30) return `${wk} 周前`;
    const mo = Math.floor(day / 30);
    if (mo < 12) return `${mo} 个月前`;
    return `${Math.floor(mo / 12)} 年前`;
  }

  function translateRelativeTime(root = document) {
    if (!core.settings.enabled || !core.settings.github?.enabled) return 0;
    if (!core.settings.github?.menu) return 0;
    let n = 0;
    for (const el of root.querySelectorAll?.('relative-time, time-ago') || []) {
      const iso = el.getAttribute('datetime');
      const zh = formatRelative(iso);
      if (!zh) continue;
      if (el.dataset.xtRel === zh) continue;
      try {
        if (el.shadowRoot) el.shadowRoot.textContent = zh;
        else el.textContent = zh;
        el.dataset.xtRel = zh;
        n++;
      } catch {
        /* 闭包 shadowRoot 写不进去，跳过 */
      }
    }
    return n;
  }

  /**
   * 输入框占位符。
   * 「Find a repository…」「Go to file」「Type / to search」这些看着像普通文案，
   * 其实是 input 的 placeholder 属性 —— 不在文本节点里，TreeWalker 走不到，
   * 只能单独按属性处理。
   */
  function translatePlaceholders(root = document) {
    if (!core.settings.enabled || !core.settings.github?.enabled) return 0;
    if (!core.settings.github?.menu) return 0;
    let n = 0;
    for (const el of root.querySelectorAll?.('input[placeholder], textarea[placeholder]') || []) {
      const ph = el.getAttribute('placeholder');
      if (!ph) continue;
      if (el.dataset.xtPhOrig) continue;
      const zh = lookup(ph);
      if (!zh || zh === ph) continue;
      el.dataset.xtPhOrig = ph;
      el.setAttribute('placeholder', zh);
      n++;
    }
    return n;
  }

  /**
   * 按钮文案（<input type="submit" value="...">）。
   * ---------------------------------------------------------------------
   * 这类按钮的文字在 value 属性里，页面上看得见，但 DOM 里没有文本节点 ——
   * TreeWalker 走的全是文本节点，永远碰不到；SKIP_SEL 里又把 input 整体跳过了。
   * 设置页那个绿色的「Set up discussions」就是这么一直漏的（实测 DOM：
   * <input type="submit" class="btn btn-primary" value="Set up discussions">）。
   * 和占位符一样，走属性通道。
   */
  function translateInputValues(root = document) {
    if (!core.settings.enabled || !core.settings.github?.enabled) return 0;
    if (!core.settings.github?.menu) return 0;
    let n = 0;
    const sel = 'input[type="submit"], input[type="button"], input[type="reset"]';
    for (const el of root.querySelectorAll?.(sel) || []) {
      const raw = el.getAttribute('value');
      if (!raw || !raw.trim()) continue;
      if (el.dataset.xtValOrig) continue; // 已换过，且原文备份在，不再重复处理
      const zh = lookup(raw);
      if (!zh || zh === raw.trim()) continue;
      el.dataset.xtValOrig = raw;
      el.setAttribute('value', zh);
      n++;
    }
    return n;
  }

  function scanUi(root = document) {
    if (!core.settings.enabled || !core.settings.github?.enabled) return 0;
    if (!core.settings.github?.menu) return 0;

    let n = translatePlaceholders(root) + translateRelativeTime(root) + translateInputValues(root);
    const scopes = new Set();
    if (root.nodeType === 1 && root.matches?.(UI_SCOPE_SEL)) scopes.add(root);
    for (const s of root.querySelectorAll?.(UI_SCOPE_SEL) || []) scopes.add(s);

    for (const scope of scopes) {
      // 每个作用域单独开一个 TreeWalker，天然不会越界
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const p = node.parentElement;
          if (!p || p.closest(SKIP_SEL)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      while (walker.nextNode()) {
        if (replaceInTextNode(walker.currentNode)) n++;
      }
    }
    return n;
  }

  function restoreUi() {
    for (const el of document.querySelectorAll('[data-xt-ui="1"]')) {
      const orig = el.dataset.xtUiOrig;
      if (!orig) continue;
      // 只还原「父元素里只有一个文本节点」的简单情况，复杂结构交给刷新
      const tn = [...el.childNodes].find((c) => c.nodeType === 3 && c.nodeValue.trim());
      if (tn) tn.nodeValue = orig;
      delete el.dataset.xtUi;
    }
    // input 按钮的文案存在 value 属性里，单独还原
    for (const el of document.querySelectorAll('input[data-xt-val-orig]')) {
      const orig = el.dataset.xtValOrig;
      if (orig) el.setAttribute('value', orig);
      delete el.dataset.xtValOrig;
    }
  }

  /* ---------------------- ② 阅读内容：模型翻译 ---------------------- */

  function renderBilingual(host, translated, _source, lang) {
    // 标题里的译文要单独压字号（h1 里嵌 div 会继承 2em 字体），按标签带上类
    const tag = String(host?.tagName || '').toLowerCase();
    const extra = /^h[1-4]$/.test(tag) ? ` xt-${tag}` : '';
    return core.render(host, translated, '', 'xt-gh-md' + extra, lang);
  }

  // README 里这些块级元素逐段翻：整块翻会破坏表格和列表布局
  const MD_BLOCK_SEL = 'p, li, h1, h2, h3, h4, h5, blockquote, td, figcaption';

  function handleMarkdown() {
    if (!core.settings.enabled || !core.settings.github?.enabled) return;
    if (!core.settings.github?.readme) return;

    for (const root of document.querySelectorAll(MD_SEL)) {
      if (!root.isConnected) continue;
      for (const el of root.querySelectorAll(MD_BLOCK_SEL)) {
        // 纯代码 / 纯图片 / 空段不翻
        if (el.querySelector('pre, img, svg')) continue;
        // 用 sourceText 而不是 textContent：段落本身是译文宿主，
        // 直接读 textContent 会把上一轮译文算进源文，重扫几次就叠成双份。
        const text = core.sourceText(el);
        if (text.length < 2) continue;
        // 含大量非文本内容（比如徽标行）跳过
        if (el.querySelectorAll('img').length && text.length < 12) continue;
        core.queue(el, text, renderBilingual);
      }
    }
  }

  function handleDescription() {
    if (!core.settings.enabled || !core.settings.github?.enabled) return;
    if (!core.settings.github?.readme) return;
    for (const el of document.querySelectorAll(DESC_SEL)) {
      const text = core.sourceText(el);
      if (text.length < 4) continue;
      core.queue(el, text, renderBilingual);
    }
  }

  /**
   * 纯文本 README：仓库里没有 .md 文件时，GitHub 把 README 塞进 <pre> 原样显示。
   * 这种情况既不能当 markdown 逐段翻（里面没有 p/li），也不能直接塞进 <pre>（会破坏等宽排版），
   * 所以按空行切块 → 逐块翻译 → 统一追加在 <pre> 之后。
   * 实际例子：torvalds/linux 的 README 就是纯文本。
   */
  const plainDone = new WeakSet();

  async function handlePlainReadme() {
    if (!core.settings.enabled || !core.settings.github?.enabled || !core.settings.github?.readme) return;
    for (const root of document.querySelectorAll(MD_SEL)) {
      if (plainDone.has(root)) continue;
      if (root.querySelector(MD_BLOCK_SEL)) continue; // 正常 markdown，走 handleMarkdown
      const pre = root.querySelector(':scope > div.plain > pre, :scope > pre');
      if (!pre) continue;
      const text = (pre.textContent || '').trim();
      if (text.length < 40) continue;
      plainDone.add(root);

      // 按空行切块，每块控制在 1200 字符内（太长模型会截断）
      const chunks = [];
      let buf = '';
      for (const line of text.split('\n')) {
        if ((buf + '\n' + line).length > 1200 && buf.trim()) {
          chunks.push(buf.trim());
          buf = line;
        } else {
          buf = buf ? buf + '\n' + line : line;
        }
      }
      if (buf.trim()) chunks.push(buf.trim());
      const use = chunks.slice(0, 8); // 最多 8 块，约 1 万字符，够常规 README

      // 必须「翻一块、插一块」，用 cursor 串行推进。
      // 并发去翻的话，先返回的块会插在靠前位置，整段译文顺序就乱了。
      const anchor0 = root.querySelector(':scope > div.plain') || pre;
      (async () => {
        let cursor = anchor0;
        for (const c of use) {
          let rec = null;
          try {
            rec = await core.translateOne(c);
          } catch {
            rec = null;
          }
          if (!rec?.t) continue;
          const div = document.createElement('div');
          div.className = 'xt-translation xt-gh-md xt-gh-plain';
          div.setAttribute('dir', 'auto');
          div.textContent = rec.t;
          core.setLang(div, rec.l);
          core.stampEngine(div, rec.e);
          if (!cursor.isConnected) cursor = anchor0;
          cursor.insertAdjacentElement('afterend', div);
          cursor = div;
        }
      })();
    }
  }

  /**
   * 议题 / PR 列表的标题。
   * 结构：h3.heading__xxx > a.anchor__xxx > span 文本。
   * 这是「内容」不是「界面」，所以走模型翻；但不能插到 <a> 里（会把链接撑成两行），
   * 译文放到 h3 之后。
   */
  const ISSUE_TITLE_SEL = 'h3[class*="heading"] > a[class*="anchor"]';

  function renderIssueTitle(h3, translated, _source, lang) {
    if (!h3.isConnected) return null;
    let el = h3.nextElementSibling;
    if (!el || !el.classList?.contains('xt-translation')) {
      el = document.createElement('div');
      el.className = 'xt-translation xt-gh-issue';
      el.setAttribute('dir', 'auto');
      h3.insertAdjacentElement('afterend', el);
    }
    el.textContent = translated;
    core.setLang(el, lang);
    return el;
  }

  function handleIssueTitles() {
    if (!core.settings.enabled || !core.settings.github?.enabled) return;
    if (!core.settings.github?.issues) return;
    for (const a of document.querySelectorAll(ISSUE_TITLE_SEL)) {
      const h3 = a.closest('h3');
      if (!h3 || !h3.isConnected) continue;
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 6) continue;
      core.queue(a, text, (_h, t, src, lang) => renderIssueTitle(h3, t, src, lang));
    }
  }

  /**
   * 提交信息（仓库首页文件列表右侧的「最近提交信息」列，以及 /commits 列表）。
   * -----------------------------------------------------------------------
   * 这一列显示的是「最近一次提交的说明」，属于内容而不是界面文案，必须走模型
   * （本地词典不可能收录）。两个细节：
   *   ① 窄列会把长信息截成「…」，但 <a title="..."> 上存的是完整原文 ——
   *      截断版拿去翻译会翻出半句，所以优先读 title。
   *   ② 译文不塞进 <a> 里（会把链接撑成两行、还干扰点击），统一插在
   *      .react-directory-commit-message 之后，宽度随列自适应，最多两行。
   */
  const COMMIT_MSG_SEL = [
    '.react-directory-commit-message',
    // /commits 列表：div[class*="ListItemTitle"] > h4 > span > a
    '[class*="ListItemTitle"] > h4',
    // 旧版 / PR 提交列表
    '[class*="commit-title"]',
    '[data-testid="commit-message"]'
  ].join(',');

  function renderCommitMsg(host, translated, _source, lang) {
    if (!host.isConnected) return null;
    let el = host.nextElementSibling;
    if (!el || !el.classList?.contains('xt-gh-commit')) {
      el = document.createElement('div');
      el.className = 'xt-translation xt-gh-commit';
      el.setAttribute('dir', 'auto');
      host.insertAdjacentElement('afterend', el);
    }
    el.textContent = translated;
    el.title = translated; // 两行装不下时，悬停看全文
    core.setLang(el, lang);
    return el;
  }

  function handleCommitMessages() {
    if (!core.settings.enabled || !core.settings.github?.enabled) return;
    if (core.settings.github?.commits === false) return;

    for (const el of document.querySelectorAll(COMMIT_MSG_SEL)) {
      if (!el.isConnected) continue;
      // title 属性的两种用法都要照顾：
      //   文件列表里 title 是「完整标题」（列表显示被截成 …，必须用它）；
      //   /commits 列表里 title 是「标题 + 空行 + 提交正文」，正文几十行，
      //   整段拿去翻又慢又没意义 —— 所以只取第一行。
      const a = el.querySelector('a[title]') || el.querySelector('a');
      const raw = a?.getAttribute('title') || core.sourceText(el);
      const text = raw.split('\n')[0].replace(/\s+/g, ' ').trim();
      // 太短的（wip / init / bump）翻了也没信息量，反而不如原样
      if (text.length < 6) continue;
      core.queue(el, text, renderCommitMsg);
    }
  }

  let uiRescanTimer = null;
  function scheduleUiRescan() {
    if (uiRescanTimer) return;
    uiRescanTimer = setTimeout(() => {
      uiRescanTimer = null;
      if (core.settings.enabled && core.settings.github?.enabled) scanUi();
    }, 180);
  }

  function scanAll() {
    scanUi();
    handleDescription();
    handleMarkdown();
    handlePlainReadme();
    handleIssueTitles();
    handleCommitMessages();
  }

  function scanNodes(nodes) {
    if (!core.settings.enabled || !core.settings.github?.enabled) return;
    let needMd = false;
    let needCommit = false;
    for (const n of nodes) {
      if (n.nodeType !== 1) continue;
      // ★ React 重建一个 span/summary 时，新节点本身并不匹配作用域选择器
      //   （比如 Type/Language/Sort 就是 summary>span 被重建）。
      //   旧逻辑只在「新节点自己匹配」时扫，导致这类节点永远是英文。
      //   改成先找最近的 scope 祖先，再重扫那个 scope。
      const host = n.closest?.(UI_SCOPE_SEL);
      if (host) scanUi(host);
      else if (n.querySelector?.(UI_SCOPE_SEL)) scanUi(n);
      // 只有变更落在 Markdown / 简介区域时才重扫正文，
      // 否则每隔 150ms 把整个 README 遍历一遍纯属浪费
      if (!needMd && (n.closest?.(MD_SEL) || n.closest?.(DESC_SEL) || n.querySelector?.(MD_SEL))) {
        needMd = true;
      }
      if (!needCommit && (n.closest?.(COMMIT_MSG_SEL) || n.querySelector?.(COMMIT_MSG_SEL))) {
        needCommit = true;
      }
    }
    if (needMd) {
      handleDescription();
      handleMarkdown();
    }
    if (needCommit) handleCommitMessages();
  }

  /* ----------------------------- 启动 ----------------------------- */

  function boot() {
    if (!core.settings.enabled || !core.settings.github?.enabled) return;

    core.setContext?.('github');
    core.onIncremental(scanNodes);
    core.onRescan(scanAll);

    scanAll();
    setTimeout(scanAll, 800);
    setTimeout(scanAll, 2500);

    core.watchDom({ debounce: 150 });

    // ★ GitHub 设置页是 React 水合的：SSR 出来的英文先被我们替换成中文，
    //   随后 React 接管，又把英文写回同一个文本节点（characterData 变化）。
    //   core.watchDom 只盯 childList/attributes，抓不到原地改写，
    //   于是那批词条「加了却没生效」。这里补两层保险：
    //   ① characterData 监听 —— 文本被改回英文就立刻重扫
    //   ② 前 20 秒定时补扫 —— 兜住水合时机不确定的情况
    try {
      const uiMo = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type !== 'characterData') continue;
          const host = m.target?.parentElement;
          if (!host || !host.closest?.(UI_SCOPE_SEL)) continue;
          scheduleUiRescan();
          return;
        }
      });
      uiMo.observe(document.body, { characterData: true, subtree: true });
    } catch {
      /* 观察器不可用时，下面的定时补扫还能兜一半 */
    }
    let quickTicks = 0;
    const quickTimer = setInterval(() => {
      if (!core.settings.enabled || !core.settings.github?.enabled) return;
      scanUi();
      if (++quickTicks >= 12) clearInterval(quickTimer);
    }, 1800);

    // Turbo 局部导航（点链接换页）不会触发 load，但会触发这个事件
    document.addEventListener('turbo:load', () => setTimeout(scanAll, 300));
    document.addEventListener('turbo:render', () => setTimeout(scanAll, 300));
    document.addEventListener('pjax:end', () => setTimeout(scanAll, 300));
  }

  core.ready.then(boot);

  core.onSettings((s) => {
    if (s.enabled && s.github?.enabled) {
      if (!s.github?.menu) restoreUi();
      scanAll();
    } else {
      restoreUi();
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'XT_PAGE_STATS') {
      sendResponse({
        ok: true,
        site: 'github',
        stats: core.stats(),
        boxes: document.querySelectorAll('.xt-translation').length,
        ui: document.querySelectorAll('[data-xt-ui="1"]').length,
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

import { pick } from '../../core/language.ts';

const zh = {
  navLabel: '扩展',
  navGroup: '系统',
  introTitle: '扩展',
  introDesc: '从 npm 安装第三方 World、LLM Provider 和 bot 包。安装、卸载后需重启进程才能生效。',

  installedTitle: '已安装',
  refresh: '↻ 刷新',
  restartProcess: '重启进程',

  stateLoaded: '已加载',
  stateFailed: '加载失败',
  statePendingRestart: '待重启',
  stateRemoved: '已卸载,待重启',
  stateIdle: '已装,本部署未用',

  groupWorldDesc: '接进外部世界的一路,激活后出现在「World」里。',
  groupProviderDesc: '一种模型端点方言,在「语言模型」页里选用。',
  groupBotDesc: '一个 bot 代码包:Persona 与装配。部署的 deployment.json 里 bot 字段填包名即启用;一个进程只跑一个。',
  groupUnknownTitle: '未识别',
  groupUnknownDesc: 'package.json 里的 cortico 块缺席或不合契约,框架不知道该往哪挂。',

  restartConfirmTitle: '重启进程?',
  restartNoLoopTitle: '⚠ 没有启动器循环',
  restartConfirmBody: '按次序收尾并退出,启动器随即重新拉起。回来是暂停态,去控制台点「继续」上线。最长约半分钟。',
  restartNoLoopBody: '这个进程不是启动器起的:退出后不会自动回来,需要手动重新启动。仍要继续?',
  finishingToast: '正在按次序收尾…别关窗口。',
  stepIncomplete: '未完成',
  doneRestartSupervised: '已退出,等待启动器拉起',
  doneRestart: '已退出',
  resultDefault: '已收尾。',
  noReceipt: (msg: string) => `没拿到收尾回执(${msg});进程可能已经退出。`,

  uninstallTitle: (name: string) => `卸载「${name}」?`,
  uninstallBody: (name: string) => `从 extensions/ 里移除 ${name}。它在本进程里仍在运行,重启后消失。`,
  uninstalling: '正在卸载…',
  uninstalled: '已卸载',
  uninstallFailed: (msg: string) => `卸载失败: ${msg}`,
  uninstall: '卸载',

  installing: '正在安装…pnpm 在跑,可能要一分钟。',
  installed: '已安装',
  installFailed: (msg: string) => `安装失败: ${msg}`,
  installedRestartTitle: '已安装,现在重启进程加载它?',
  installedRestartNote: '重启会按次序收尾并由启动器重新拉起,回来是暂停态。',
  installedNoLoopNote: '⚠ 没有检测到启动器循环:重启等于关机,之后要手动启动。',

  panelLoaded: '自定义面板已加载',
  noteIdle: '这份部署的 deployment.json 没有引用它,没有加载。',
  noteConsoleMissing: '声明了浏览器端产物但文件不在:到扩展目录里 build 一次,再重启。',

  sumLoaded: (n: number) => `已加载 ${n}`,
  sumPending: (n: number) => `待重启 ${n}`,
  sumFailed: (n: number) => `加载失败 ${n}`,
  noExtensions: '还没装任何扩展',
  listLoadFailed: (msg: string) => `扩展清单加载失败: ${msg}`,
  loading: '加载中…',

  searchTitle: '从 npm 安装',
  searchDesc: '扩展在进程内运行,拥有与框架相同的文件与网络权限——安装前看一眼仓库与作者。',
  searchPlaceholder: '关键字;留空列出全部',
  search: '搜索',
  searchKeywordNote: (keyword: string) => `列出 npm 上带 ${keyword} 关键字的包。`,
  searching: '搜索中…',
  noHits: '没有匹配的包',
  hitCount: (n: number) => `${n} 个包`,
  searchFailed: (msg: string) => `搜索失败: ${msg}`,
  hitMeta: (version: string, downloads: number, publisher?: string) =>
    `${version} · 月下载 ${downloads}${publisher ? ` · ${publisher}` : ''}`,
  linkRepo: '仓库',
  linkHome: '主页',
  install: '安装',
  alreadyInstalled: '已安装',

  manualTitle: '手动安装',
  manualDesc: '包名(可带 @版本)或本机一个含 package.json 的目录。本机目录以链接方式装入,改源码后重启即生效——给自己写 World 的人用。',
  manualPlaceholder: '@scope/name@1.2.0 或 ../my-module',
  manualEmpty: '先填包名或目录',
};

const en: typeof zh = {
  navLabel: 'Extensions',
  navGroup: 'System',
  introTitle: 'Extensions',
  introDesc: 'Install third-party Worlds, LLM providers and bot packages from npm. '
    + 'Installations and removals take effect after restarting the process.',

  installedTitle: 'Installed',
  refresh: '↻ Refresh',
  restartProcess: 'Restart process',

  stateLoaded: 'Loaded',
  stateFailed: 'Load failed',
  statePendingRestart: 'Restart pending',
  stateRemoved: 'Uninstalled, restart pending',
  stateIdle: 'Installed, unused by this deployment',

  groupWorldDesc: 'A route into an outside world; once activated it shows up under "World".',
  groupProviderDesc: 'One model-endpoint dialect, selectable on the "Language model" page.',
  groupBotDesc: 'A bot code package: Persona and assembly. Put the package name in the deployment\'s '
    + 'deployment.json bot field to enable it; one process runs exactly one.',
  groupUnknownTitle: 'Unrecognised',
  groupUnknownDesc: 'The cortico block in package.json is missing or off contract, so the framework does not know where to mount it.',

  restartConfirmTitle: 'Restart the process?',
  restartNoLoopTitle: '⚠ No launcher loop',
  restartConfirmBody: 'Finishes in order and exits; the launcher relaunches right after. It comes back paused — '
    + 'press "Resume" in the console to go live. Takes up to about half a minute.',
  restartNoLoopBody: 'This process was not started by the launcher: it will not come back after exit and must be started manually. Continue anyway?',
  finishingToast: 'Shutting down in order… do not close the window.',
  stepIncomplete: 'incomplete',
  doneRestartSupervised: 'Exited; waiting for the launcher',
  doneRestart: 'Exited',
  resultDefault: 'Shutdown finished.',
  noReceipt: (msg: string) => `No shutdown receipt (${msg}); the process may already have exited.`,

  uninstallTitle: (name: string) => `Uninstall "${name}"?`,
  uninstallBody: (name: string) => `Removes ${name} from extensions/. It keeps running in this process and disappears after a restart.`,
  uninstalling: 'Uninstalling…',
  uninstalled: 'Uninstalled',
  uninstallFailed: (msg: string) => `Uninstall failed: ${msg}`,
  uninstall: 'Uninstall',

  installing: 'Installing… pnpm is running, this can take a minute.',
  installed: 'Installed',
  installFailed: (msg: string) => `Install failed: ${msg}`,
  installedRestartTitle: 'Installed. Restart the process now to load it?',
  installedRestartNote: 'Restarting finishes in order and the launcher relaunches; it comes back paused.',
  installedNoLoopNote: '⚠ No launcher loop detected: restarting equals shutting down, and you start it manually afterwards.',

  panelLoaded: 'Custom panel loaded',
  noteIdle: 'This deployment\'s deployment.json does not reference it, so it was not loaded.',
  noteConsoleMissing: 'It declares a browser-side bundle but the file is missing: build once in the extension directory, then restart.',

  sumLoaded: (n: number) => `${n} loaded`,
  sumPending: (n: number) => `${n} restart pending`,
  sumFailed: (n: number) => `${n} failed`,
  noExtensions: 'No extensions installed yet',
  listLoadFailed: (msg: string) => `Extension list failed to load: ${msg}`,
  loading: 'Loading…',

  searchTitle: 'Install from npm',
  searchDesc: 'Extensions run in-process with the same file and network access as the framework — look at the repository and the author before installing.',
  searchPlaceholder: 'Keyword; empty lists everything',
  search: 'Search',
  searchKeywordNote: (keyword: string) => `Lists npm packages carrying the ${keyword} keyword.`,
  searching: 'Searching…',
  noHits: 'No matching packages',
  hitCount: (n: number) => `${n} packages`,
  searchFailed: (msg: string) => `Search failed: ${msg}`,
  hitMeta: (version: string, downloads: number, publisher?: string) =>
    `${version} · ${downloads}/month${publisher ? ` · ${publisher}` : ''}`,
  linkRepo: 'Repository',
  linkHome: 'Homepage',
  install: 'Install',
  alreadyInstalled: 'Installed',

  manualTitle: 'Manual install',
  manualDesc: 'A package name (optionally @version) or a local directory containing a package.json. '
    + 'A local directory is linked in, so a source edit takes effect on the next restart — for people writing their own World.',
  manualPlaceholder: '@scope/name@1.2.0 or ../my-module',
  manualEmpty: 'Fill in a package name or directory first',
};

export const S = pick({ zh, en });

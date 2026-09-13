import { pick } from '../core/language.ts';

const zh = {
  protocolMismatch: (server: string, page: string) =>
    `控制台协议版本对不上:服务端 ${server}、本页 ${page}。`
    + '多半是浏览器缓存了旧的内核 bundle,强制刷新一次。',
  pageFailed: (pageId: string) => `「${pageId}」这一页没能打开`,
  noPage: (pageId: string) => `没有这个 provider:「${pageId}」`,
  noPageHint: '它可能未激活，或者名字写错了。',
  noPanels: (label: string) => `「${label}」没有声明任何面板。`,
  noSuchPanel: (label: string, wanted: string) => `「${label}」没有面板「${wanted}」`,
  provides: (list: string) => '它提供的是: ' + list,
  panelFailed: (title: string) => `面板「${title}」没能加载`,
  configEmpty: '(它声明的参数组这会儿没在 /api/config 里——多半是这次运行没装配)',
  configTitle: '参数',
  configDesc: '这一页的旋钮由这个 provider 自己声明（JSON Schema），控制台按声明通用渲染。'
    + '**改了就存**：一改动就写回 config.json。标「重启 World 生效」的在 World 总览页重启这个 World 即生效，其余立即。',
  assembly: '装配',
  notInstalled: '未安装',
  notActivated: '未激活',
  hidden: '已隐藏',
  reloadPrefix: '前缀待重载 · 点此重载',
  open: '打开',
  configTab: '参数',
  promptsTab: '提示词模板',
  reloadTitle: '重载 system 前缀？',
  reloadBody: '重读全部前缀源并替换当前 session 的 system 消息。会丢一次缓存前缀（下一轮要重新计费），不影响对话内容。',
  prefixReloaded: '前缀已重载',
  noBundle: (pageId: string) =>
    `「${pageId}」声明了面板，但没有它的面板产物。仓内的页跑一次 pnpm build:web；`
    + `extensions/ 下的包要在包自己的目录里 build 再重启。若它本来就不该有面板，去掉声明。`,
  badBundleUrl: (pageId: string) => `「${pageId}」的面板产物地址不合法，已拒绝加载`,
  bundleLoadFailed: (pageId: string, err: string) => `「${pageId}」的面板产物加载失败: ${err}`,
  badDefaultExport: (pageId: string) => `「${pageId}」的面板产物没有导出合法的 default —— 应为 { panels: { … } }`,
  none: '(无)',
  noSuchBundlePanel: (pageId: string, panelId: string, known: string) =>
    `「${pageId}」的面板产物里没有面板「${panelId}」。它提供的是: ${known}`,
  badPanelImpl: (pageId: string, panelId: string) =>
    `「${pageId}」的面板产物里，面板「${panelId}」不是合法实现 —— 缺 mount 方法`,
  noBuiltinPanel: (name: string, known: string) =>
    `内核没有内置面板「${name}」。它自带的是: ${known}`,
};

const en: typeof zh = {
  protocolMismatch: (server: string, page: string) =>
    `Console protocol version mismatch: server ${server}, this page ${page}.`
    + ' The browser most likely cached an old kernel bundle; force a refresh.',
  pageFailed: (pageId: string) => `Could not open "${pageId}"`,
  noPage: (pageId: string) => `No such provider: "${pageId}"`,
  noPageHint: 'It may not be activated, or the name is misspelled.',
  noPanels: (label: string) => `"${label}" declares no panels.`,
  noSuchPanel: (label: string, wanted: string) => `"${label}" has no panel "${wanted}"`,
  provides: (list: string) => 'It provides: ' + list,
  panelFailed: (title: string) => `Panel "${title}" failed to load`,
  configEmpty: '(The config groups it declares are not in /api/config right now — most likely not assembled in this run)',
  configTitle: 'Parameters',
  configDesc: 'The knobs on this page are declared by this provider (JSON Schema); the console renders them generically.'
    + ' **Changes save immediately**: every edit is written back to config.json. Items marked "takes effect after World restart" apply once you restart that World on the World overview page; the rest apply at once.',
  assembly: 'Assembly',
  notInstalled: 'not installed',
  notActivated: 'not activated',
  hidden: 'hidden',
  reloadPrefix: 'Prefix drifted · click to reload',
  open: 'Open',
  configTab: 'Parameters',
  promptsTab: 'Prompt templates',
  reloadTitle: 'Reload the system prefix?',
  reloadBody: 'Re-reads every prefix source and replaces the current session\'s system message. One cached prefix is lost (the next turn is billed anew); the conversation is unaffected.',
  prefixReloaded: 'Prefix reloaded',
  noBundle: (pageId: string) =>
    `"${pageId}" declares panels but its panel bundle is missing. For a page in this repo run pnpm build:web;`
    + ' for a page from a package under extensions/, build it in that package\'s own directory and restart.'
    + ' If it should not have panels, drop the declaration.',
  badBundleUrl: (pageId: string) => `Panel bundle URL of "${pageId}" is invalid; refused to load`,
  bundleLoadFailed: (pageId: string, err: string) => `Panel bundle of "${pageId}" failed to load: ${err}`,
  badDefaultExport: (pageId: string) => `Panel bundle of "${pageId}" has no valid default export — expected { panels: { … } }`,
  none: '(none)',
  noSuchBundlePanel: (pageId: string, panelId: string, known: string) =>
    `Panel bundle of "${pageId}" has no panel "${panelId}". It provides: ${known}`,
  badPanelImpl: (pageId: string, panelId: string) =>
    `In the panel bundle of "${pageId}", panel "${panelId}" is not a valid implementation — missing mount`,
  noBuiltinPanel: (name: string, known: string) =>
    `The kernel has no built-in panel "${name}". It provides: ${known}`,
};

export const S = pick({ zh, en });

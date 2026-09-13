import { pick } from '../../core/language.ts';

const zh = {
  navLabel: 'World 总览',
  introTitle: 'World',
  introDesc: '管理 World 装配、激活状态与 agent 可见性。',
  sheetTitle: '装配状态',
  sheetDesc: '每个 World 一张卡。控制台只知道"有一批 World、每个有三态和几个开关",'
    + '卡上的名字、徽标与说明全部来自 World 自己的声明——所以装上新 World,它会自己出现在这里。'
    + '右上角三颗图标依次是:对 agent 可见 / 重启 World / 停用 World。',
  reloadPrefixBtn: '↻ 重载系统前缀',
  prefixReloaded: '前缀已重载',
  prefixReloadFailed: (msg: string) => `前缀重载失败: ${msg}`,
  updated: '已更新',
  toggleFailed: (msg: string) => `切换失败: ${msg}`,
  reloadNowTitle: '现在重载 system 前缀?',
  reloadNowBody: (name: string, wantVisible: boolean) =>
    (wantVisible ? `「${name}」已对 agent 重新可见。` : `「${name}」已对 agent 隐藏。`)
    + '\n\n事件投递已经生效。但它的环境提示词与工具还留在当前 system 前缀里——'
    + '这两样同属每次请求的缓存前缀,要一起换。\n\n'
    + '⚠ 重载会丢一次 system 前缀缓存:下一次调用按未命中计费。当前 session 的既有消息全部保留。\n\n'
    + '选"取消"也没关系,下次 session 交接或重开时会自然跟上。',
  deactivateTitle: (name: string) => `停用「${name}」?`,
  deactivateBody: (id: string) =>
    'World 会立即停止(它托管的外部进程与连接一并收尾),并写回 config.json 的 '
    + `worlds.${id}.enabled=false。agent 的环境提示词与工具随即撤下;再次激活按当前配置重建。`,
  activated: '已激活',
  deactivated: '已停用',
  activateFailed: (msg: string) => `激活失败: ${msg}`,
  deactivateFailed: (msg: string) => `停用失败: ${msg}`,
  restartTitle: (name: string) => `重启「${name}」?`,
  restartBody: '停下当前实例、按定义重建、重新启动。构造时读走的参数(端口、地址、路径这类'
    + '标「重启 World 生效」的)由此生效;它托管的外部进程与连接会经历一次收尾与重连。',
  restarted: '已重启',
  restartFailed: (msg: string) => `重启失败: ${msg}`,
  lampAssembly: '装配',
  notInstalled: '未安装',
  notActive: '未激活',
  declaredByPersona: 'Persona定义',
  optionalAddon: '选配外挂',
  open: '打开',
  details: '→ 详情',
  toolsCount: (id: string, n: number) => `${id} · ${n} 个工具`,
  missingReasonDefault: '本地没有找到这个 World 的实现。',
  missingOptionalNote: '部署侧选配的 World,这次没装上。修好之后重启进程。',
  missingDeclaredNote: 'Persona声明了这个渠道,但当前部署没有它的实现。装上实现后重启进程。',
  activateWorld: '激活 World',
  inactiveNoteActivatable: '本地有实现,这次运行没装配。激活会写回 config.json 并立即挂载;参数可以先在详情页改好。',
  inactiveNoteManual: (id: string) => `本地有实现但没装配。要启用,把 config.json 里 worlds.${id}.enabled 改为 true 后重启。`,
  hideFromAgent: '对 agent 隐藏',
  showToAgent: '对 agent 显示',
  restartWorld: '重启 World',
  deactivateWorld: '停用 World',
  visibleToAgent: '对 agent 可见',
  hidden: '已隐藏',
  prefixPending: '前缀待重载',
  kvTools: '工具',
  kvNone: '（无）',
  kvWorkspace: '工作区',
  listSep: '、',
  driftNote: '事件投递已按新状态生效;环境提示词与工具要等一次前缀重载才跟上(会丢一次前缀缓存)。',
  sumVisible: (n: number) => `可见 ${n}`,
  sumHidden: (n: number) => `已隐藏 ${n}`,
  sumInactive: (n: number) => `未激活 ${n}`,
  sumMissing: (n: number) => `未安装 ${n}`,
  noWorlds: '没有任何 World',
  listLoadFailed: (msg: string) => `World 清单加载失败: ${msg}`,
  loading: '加载中…',
};

const en: typeof zh = {
  navLabel: 'Worlds',
  introTitle: 'Worlds',
  introDesc: 'Manage World assembly, activation and agent visibility.',
  sheetTitle: 'Assembly status',
  sheetDesc: 'One card per World. The console only knows there is a set of Worlds, each in one of three states with a few switches; '
    + 'the name, badges and notes on a card all come from the World\'s own declaration — so a newly installed World shows up here by itself. '
    + 'The three icons in the corner are: visible to agent / restart World / deactivate World.',
  reloadPrefixBtn: '↻ Reload system prefix',
  prefixReloaded: 'Prefix reloaded',
  prefixReloadFailed: (msg: string) => `Prefix reload failed: ${msg}`,
  updated: 'Updated',
  toggleFailed: (msg: string) => `Toggle failed: ${msg}`,
  reloadNowTitle: 'Reload the system prefix now?',
  reloadNowBody: (name: string, wantVisible: boolean) =>
    (wantVisible ? `"${name}" is visible to the agent again.` : `"${name}" is now hidden from the agent.`)
    + '\n\nEvent delivery has already switched. But its environment prompt and tools are still in the current system prefix — '
    + 'both belong to the cached prefix sent with every request and must change together.\n\n'
    + '⚠ Reloading drops the system prefix cache once: the next call is billed as a cache miss. All existing messages in the current session are kept.\n\n'
    + 'Cancelling is fine too; it catches up naturally at the next session handoff or restart.',
  deactivateTitle: (name: string) => `Deactivate "${name}"?`,
  deactivateBody: (id: string) =>
    'The World stops immediately (its managed external processes and connections are wound down), and '
    + `worlds.${id}.enabled=false is written back to config.json. The agent's environment prompt and tools are withdrawn right away; activating again rebuilds it from the current config.`,
  activated: 'Activated',
  deactivated: 'Deactivated',
  activateFailed: (msg: string) => `Activation failed: ${msg}`,
  deactivateFailed: (msg: string) => `Deactivation failed: ${msg}`,
  restartTitle: (name: string) => `Restart "${name}"?`,
  restartBody: 'Stops the current instance, rebuilds it from its definition and starts it again. Parameters read at construction (ports, addresses, paths — '
    + 'the ones marked "takes effect after World restart") take effect this way; its managed external processes and connections go through a shutdown and reconnect.',
  restarted: 'Restarted',
  restartFailed: (msg: string) => `Restart failed: ${msg}`,
  lampAssembly: 'assembly',
  notInstalled: 'Not installed',
  notActive: 'Inactive',
  declaredByPersona: 'Declared by Persona',
  optionalAddon: 'Optional add-on',
  open: 'Open',
  details: '→ Details',
  toolsCount: (id: string, n: number) => `${id} · ${n} tools`,
  missingReasonDefault: 'No implementation of this World was found locally.',
  missingOptionalNote: 'An optional World chosen on the deployment side; it did not load this time. Fix it and restart the process.',
  missingDeclaredNote: 'The Persona declares this channel, but the current deployment has no implementation of it. Install one and restart the process.',
  activateWorld: 'Activate World',
  inactiveNoteActivatable: 'Implemented locally but not assembled this run. Activating writes back to config.json and mounts it immediately; parameters can be adjusted on the details page first.',
  inactiveNoteManual: (id: string) => `Implemented locally but not assembled. To enable it, set worlds.${id}.enabled to true in config.json and restart.`,
  hideFromAgent: 'Hide from agent',
  showToAgent: 'Show to agent',
  restartWorld: 'Restart World',
  deactivateWorld: 'Deactivate World',
  visibleToAgent: 'Visible to agent',
  hidden: 'Hidden',
  prefixPending: 'Prefix reload pending',
  kvTools: 'Tools',
  kvNone: '(none)',
  kvWorkspace: 'Workspace',
  listSep: ', ',
  driftNote: 'Event delivery already follows the new state; the environment prompt and tools catch up after a prefix reload (which drops the prefix cache once).',
  sumVisible: (n: number) => `Visible ${n}`,
  sumHidden: (n: number) => `Hidden ${n}`,
  sumInactive: (n: number) => `Inactive ${n}`,
  sumMissing: (n: number) => `Not installed ${n}`,
  noWorlds: 'No worlds',
  listLoadFailed: (msg: string) => `Failed to load World list: ${msg}`,
  loading: 'Loading…',
};

export const S = pick({ zh, en });

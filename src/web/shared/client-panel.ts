/**
 * 控制台页浏览器扩展与控制台内核的契约，仅浏览器端 import，服务端不 import。此文件使用 DOM 类型，根 tsconfig 从初始文件表排除，由 tsconfig.web.json 检查。
 * 扩展通过 ConsolePanelContext 获取调用、根节点、取消、定时器、动画帧、存储、离开拦截及 UI。
 * 卸载依次 abort、dispose、清空 root；离开面板后轮询、RAF、observer、listener、挂起 fetch 与音频播放均停止。
 */

import type { ConsoleBadge } from './console-protocol.ts';
import type { ConfigValue } from '../../core/config-schema.ts';
import type { Language } from '../../core/language.ts';
import type { PathPickerOptions } from './path-picker.ts';

/** 可释放资源。`ResizeObserver` 这类原生对象用 `toDisposable` 包一下即可。 */
export interface Disposable {
  dispose(): void;
}

/** 把任意清理函数包成 `Disposable`。 */
export function toDisposable(cleanup: () => void): Disposable {
  let done = false;
  return {
    dispose() {
      if (done) return;
      done = true;
      cleanup();
    },
  };
}

// ---------------------------------------------------------------------------
// Panel Context
// ---------------------------------------------------------------------------

/**
 * 面板运行时上下文。**这是扩展与外界的唯一接口。**
 *
 * 身份、DOM 根、生命周期与自有数据面是稳定基线；通用框架能力可以增量扩充。
 * 接口不接受任何具体页的专用成员。
 */
export interface ConsolePanelContext {
  /** `world:chat` / `persona:demo` */
  readonly pageId: string;
  /** 本页内的局部 id，如 `gate` */
  readonly panelId: string;
  /**
   * 这个浏览器的界面语言(`zh` / `en`):部署默认,或操作员在设置里改过的那种。扩展自己
   * 决定要不要带第二套文案;没有这一语言的就给中文,宿主不翻译、不告警。
   */
  readonly language: Language;

  /**
   * 扩展的 DOM 根。**扩展只往这里面写**，不碰 `document.body`。
   * unmount 时由 host 清空。
   */
  readonly root: HTMLElement;

  /**
   * unmount 时 abort。传给 `addEventListener` 与 `fetch` 即可自动清理——
   * 这两个 API 原生认识 `AbortSignal`，所以 context 不再重复提供包装。
   */
  readonly signal: AbortSignal;

  /**
   * 调本面板的数据面方法（`ConsolePageContribution.invoke`）。
   * 走 POST，请求随 `signal` 取消；非 2xx 抛 `ConsoleInvokeError`。
   */
  invoke<T = unknown>(method: string, args?: unknown[]): Promise<T>;

  /** 同上，但按二进制取回（音频试听、图片这类）。 */
  invokeBinary(method: string, args?: unknown[]): Promise<Blob>;

  /** 面板卸载时发送小型清理 POST；该请求不随面板的 abort signal 取消。 */
  notifyOnUnmount?(method: string, args?: unknown[]): void;

  /** 打开服务端主机的本机文件/目录选择器。取消返回 null。 */
  pickPath(options: PathPickerOptions): Promise<string | null>;

  /** 按配置组写回已声明字段；校验、热更新与持久化均走框架配置面。 */
  setConfig(groupId: string, values: Record<string, ConfigValue>): Promise<string>;

  /**
   * 本面板的推送通道对应服务端 ConsolePageContribution.stream。连接中断后退避重连，unmount 同时终止连接与重连；已有推送的数据不另行轮询。
   */
  stream(handlers: ConsoleStreamHandlers): ConsoleStreamHandle;

  /** 轮询。返回的 `Disposable` 已登记，unmount 自动停；提前停就手动 `dispose()`。 */
  interval(fn: () => void, ms: number): Disposable;

  /**
   * 一次性延时（防抖、合流、"过一会儿再问一次"）。unmount 自动取消。
   *
   * 触发后**自己从账本里摘掉**，所以逐次击键的防抖可以放心地一直建——不会攒成
   * 一条无界增长的死记录。没有它的时候，扩展只能拿常驻 `interval` + 脏标顶替。
   */
  timeout(fn: () => void, ms: number): Disposable;

  /** RAF 循环。`fn` 返回 `false` 即自行结束；unmount 自动停。 */
  frame(fn: (dtMs: number) => void | false): Disposable;

  /**
   * 登记一个资源，unmount 时自动 `dispose()`。
   * `AudioContext`、`ObjectURL`、`ResizeObserver`、子进程连接都走这里。
   */
  own<T extends Disposable>(d: T): T;

  /**
   * 面板局部持久化（折叠状态、上次选中的标签这类）。
   * 键自动按 `page:panel` 命名空间隔离，两页用同一个键不会打架。
   * 无痕模式下静默降级为内存，不抛错。
   */
  readonly memo: ConsoleMemo;

  /**
   * 离开拦截。`fn` 返回一句话 = 拦下并让用户确认；返回 null = 放行。
   * 编辑器类面板（有未保存改动）用它。unmount 时自动解除。
   */
  guardLeave(fn: () => string | null): Disposable;

  /** UI 原语。 */
  readonly ui: ConsoleUi;

  /**
   * 重新读取 manifest 并更新 host 渲染的 badges、availability 与 prefixDrifted。保持面板挂载和表单状态；面板自身的数据由面板另行刷新。
   */
  refresh(): Promise<void>;
}

/** `invoke` 的失败。带上 HTTP 状态与服务端给的中文措辞。 */
export class ConsoleInvokeError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ConsoleInvokeError';
    this.status = status;
  }
}

export interface ConsoleStreamHandlers {
  /** 收到一帧。 */
  message(text: string): void;
  /** 连上了（含每次重连成功）。用来重置面板里的"连接中"状态。 */
  open?(): void;
  /** 断开了。`willRetry` 为 false 表示不再重连（面板已卸载）。 */
  close?(willRetry: boolean): void;
}

export interface ConsoleStreamHandle extends Disposable {
  /** 往回推一帧。连接未就绪时排队，连上后按序发出。 */
  send(text: string): void;
  readonly open: boolean;
}

export interface ConsoleMemo {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

// ---------------------------------------------------------------------------
// UI 原语
// ---------------------------------------------------------------------------

/**
 * 控制台 UI 原语仅包含跨页通用的能力，领域波形、预览和播放器由各扩展实现。原语返回真实 DOM 元素，复用统一样式，不接受 HTML 字符串或 JSON UI 描述。
 * ctx.ui 绑定面板 signal：abort 时关闭 toast、confirm 与 drawer，待决 confirm resolve 为 false 以允许调用方清理；abort 后 confirm 立即返回 false，toast/drawer 不显示。
 */
export interface ConsoleUi {
  /** `h('div', 'sheet', '文本')` */
  h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string | null,
    text?: string | null,
  ): HTMLElementTagNameMap[K];

  /** HTML 转义。拼 innerHTML 的场合用。 */
  esc(s: unknown): string;

  /** 档案卡（`div.sheet.tabbed`）。控制台的基本视觉单元。 */
  sheet(opts: ConsoleSheetOptions): ConsoleSheet;

  /**
   * 可折叠档案卡（`details.sheet.tabbed.fold`）。展开状态按 `id` 记在 `ctx.memo` 里，
   * 跨导航重建 DOM 后恢复。`note` 是折叠状态下唯一可见的字段。
   */
  foldSheet(id: string, opts: ConsoleSheetOptions & { defaultOpen?: boolean }): ConsoleSheet;

  /** 一行按钮/状态条（`.rowbar`）。塞一个 `h('span','grow')` 可把后面的推到右边。 */
  rowbar(): HTMLDivElement;

  /** 卡片内分区标题（`.sectionhead`）。用于区分同一卡片里的独立配置组。 */
  section(title: string, description?: string): HTMLDivElement;

  /** 卡片内动作脚栏（`.rowbar.actionbar`）。状态靠左，提交类动作靠右。 */
  actions(): HTMLDivElement;

  /** 按钮（`.btn` / `.btn.sm` / `.btn.primary` / `.btn.danger`）。 */
  button(label: string, opts?: {
    variant?: 'plain' | 'primary' | 'danger';
    size?: 'sm' | 'md';
    onClick?: (ev: MouseEvent) => void;
  }): HTMLButtonElement;

  /**
   * 复制按钮（就是一颗 `.btn`，只是点下去把一段文本送进剪贴板并弹一条 toast）。
   *
   * 三件事写在通用层，是因为它们每一处手写都会漏掉其中一件：
   *
   * 1. **文本允许惰性求值**。给函数就是点的时候才算——面板上那串值常常是活的
   *    （某个实时坐标、某次调用的最新回执），渲染时抓下来的快照到手就过期了。
   * 2. **降级**。`navigator.clipboard` 只在安全上下文里有；没有就退回
   *    `document.execCommand('copy')`。
   * 3. **失败要出声**。两条路都不通时弹 `bad` toast **并把文本摊进 `drawer`**
   *    让用户自己选取——静默失败的复制按钮比没有更糟：用户以为复制成功了，
   *    粘出来的是上一次的剪贴板内容。
   */
  copyButton(text: string | (() => string), opts?: ConsoleCopyOptions): HTMLButtonElement;

  /**
   * 药丸（`.pill` / `.pill.on` / `.pill.off`）。开关状态、"已连接/未连接"这类**二元
   * 状态标**用它；`plain` 是不着色的中性态。与 host 渲染在导航上的 `ConsoleBadge`
   * 同一套 tone，所以扩展把 badge 原样画进卡里时颜色是一致的。
   */
  pill(text: string, tone?: ConsoleBadge['tone']): HTMLSpanElement;

  /**
   * 筹码（`.chip` / `.chip.warnc` / `.chip.dreamc`）。等宽小字的**读数**用它
   * （"事件 128"、"缓存 1.5K"），与 `pill` 的分工是：pill 表状态，chip 表数字。
   * 要把数值加粗就往回填一个 `<b>`：`c.appendChild(ui.h('b', null, v))`（`.chip b` 已有样式）。
   */
  chip(text: string, tone?: ConsoleChipTone): HTMLSpanElement;

  /** 一行消息（保存结果、错误）。`bad` 走警示配色（`.msgline` / `.msgline.bad`）。 */
  msgline(text?: string, bad?: boolean): HTMLDivElement;

  /**
   * 空态（`.placeholder`）。"还没有数据"、"接口不可用"、"需要先开启 X" 都用它，
   * **别用 `msgline` 冒充空态**：那个是操作回执，居左小字，摆在一片空白里不像话。
   * 也可以直接当 `<td>` 的内容用（既有前端就是这么铺空表格的）。
   */
  placeholder(text: string): HTMLDivElement;

  /**
   * 单行输入（`input.field`）。`cls` 追加到 `field` 后面（常用 `mono`）。
   * 监听随面板 `signal` 自动摘，扩展不必自己收尾。
   */
  input(opts?: ConsoleInputOptions): HTMLInputElement;

  /** 下拉选择（`select.field`）。选项给字符串就是 value=label。 */
  select(opts?: ConsoleSelectOptions): HTMLSelectElement;

  /** 多行输入（`textarea.field`，可竖向拉伸）。 */
  textarea(opts?: ConsoleTextareaOptions): HTMLTextAreaElement;

  /**
   * 对话输入器。textarea、提交动作与快捷键共享一个交互边界；面板卸载时 React 根随
   * `signal` 销毁。适用于消息式输入，不替代普通表单的 `input` / `textarea`。
   */
  promptInput(opts: ConsolePromptInputOptions): ConsolePromptInput;

  /**
   * 可编辑勾选框，使用 label.check 包裹 input[type=checkbox]；只读状态使用 pill。
   * 返回句柄供读取 checked 和程序更新；setChecked 不触发代表用户操作的 onChange。
   */
  checkbox(label: string, opts?: ConsoleCheckboxOptions): ConsoleCheckbox;

  /**
   * 字段标签 + 控件（`label.fieldrow > span.fieldlabel` + 控件）。
   *
   * **为什么是包装函数而不是给 `ConsoleFieldOptions` 加 `label?`**：三个输入原语返回的是
   * 控件本身（`input` / `select` / `textarea`），一旦带上标签，返回值就得改成包装节点
   * ——那样调用方拿不到控件、读不了 `.value`；或者返回控件而把包装藏起来，那调用方
   * 又 append 不了。包装函数两头都不牺牲，而且能包非输入控件（`checkbox` 组、
   * `segmented`、一排按钮），标签这件事本来就不是输入框独有的。
   *
   * 用 `<label>` 而不是 `<div>`：控件嵌在 label 里，点标签即聚焦控件，不必配 `for`/`id`
   * （扩展也就不必发明一套全局唯一的 id）。
   */
  field(label: string, control: HTMLElement): HTMLLabelElement;

  /**
   * 分段选择器（`.segwrap > button.seg`，选中的那颗加 `.active`）。
   *
   * 与 `select` 的分工：挡位少（2–5 个）且值得一眼全看见时用 `segmented`，
   * 挡位多或会变长时用 `select`。与 `button` 的分工：一排 `variant: 'primary'` 的按钮
   * 能凑出同样的效果，但那是**把选中态编码进了配色**，切换时得自己逐颗重刷 class；
   * 这里 `setValue` 一句话搞定，且点已经选中的那颗不会白白回调一次。
   */
  segmented(
    items: readonly (string | { value: string; label?: string })[],
    opts?: ConsoleSegmentedOptions,
  ): ConsoleSegmented;

  /**
   * 数据表（`div.tablewrap > table.data`，表头 sticky）。
   * 返回的是**句柄**而不是干节点：表格几乎总要随流刷新，`clear()` / `addRow()`
   * 就是那条刷新路径，省得扩展自己拼 `innerHTML`（那正是注入与转义出事的地方）。
   */
  table(opts?: ConsoleTableOptions): ConsoleTable;

  /**
   * 键值两列表（`table.kvtable`：首列窄灰小字，次列等宽）。
   *
   * 与 `table` 的分工是**版式**而不是数据量：`table` 是数据表（有表头、可滚、每列同一种
   * 东西），`kv` 是**一件东西的属性清单**（"状态：已连接 / 端口：8848"），没有表头，
   * 左列是字段名。拿 `table()` 铺属性清单会得到一张没有表头的数据表——列宽平分、
   * 字段名跟值一样重，读起来找不着重点。
   *
   * 值给节点就直接放（`pill`、按钮、链接）。值格是等宽字体且只 `break-word`，
   * 要放带换行的大段正文，用 `table` 的 `.txt` 格。
   */
  kv(rows: readonly ConsoleKvRow[]): HTMLTableElement;

  /**
   * 滚动日志（`.logview` 里一串 `.logline`）。带上限、带**尾部粘滞**。
   *
   * 与 `table` 的分工是**时间轴 vs 记录集**：`table` 是一份可以整份重画的当前状态
   * （`clear()` + 重新 `addRow`），行与行之间没有先后可言；`log` 是只往末尾长的
   * 事件流，旧行只会被上限挤掉、不会被重画。拿 `table` 接流的写法迟早会退化成
   * "每来一帧整表重建"，那既刷掉了用户的选中，也把滚动位置弹回顶上。
   *
   * **尾部粘滞**是这个原语真正的理由：贴着底就跟着新行走，用户一往上翻就停住、
   * 翻回底部再恢复。每个接流的面板都会自己写一遍这段，也都会以同一种方式写错
   * （无条件 `scrollTop = scrollHeight`，于是用户永远读不完一段往上翻的历史）。
   * 判定本身导出为纯函数 `shouldStick`，因为它是这里唯一容易算错的一步。
   */
  log(opts?: ConsoleLogOptions): ConsoleLog;

  /** 概览读数（`.stat`，内含 `.k` 小标题与 `.v` 大数字；`accent` 上强调色）。 */
  stat(item: ConsoleStat): HTMLDivElement;

  /** 读数网格（`.statgrid`，自适应列宽）。把一组 `stat` 排进去。 */
  statgrid(items?: readonly ConsoleStat[]): HTMLDivElement;

  /**
   * 细占比条（`.progress` = `.progresshead` 读数行 + `.progresstrack > .progressfill`）。
   *
   * 与 `chip` 的分工：`chip` 印的是**一个数**（"事件 128"），`progress` 印的是
   * **这个数占多少**（"128 / 500"）。两者都表达不了对方——把占比写成一枚 chip，
   * 用户得先在脑子里做除法；把绝对数值画成条，条满了也不知道满的是多少。
   * 与 `stat` 的分工同理：`stat` 是一屏概览里的大数字，`progress` 贴着某件正在
   * 推进的事，通常就摆在触发它的那一行按钮下面。
   *
   * `format` 不给就印百分比；给了可以印成 `3 / 12` 这类分数读法。
   */
  progress(opts?: ConsoleProgressOptions): ConsoleProgress;

  /**
   * 瞬时提示（`.toast` / `.toast.bad`，屏幕下沿居中）。
   * 同一面板同时只留一条，后来的顶掉前面的。返回的 `Disposable` 可提前撤下；
   * 面板 unmount 时自动消失，不必登记。
   */
  toast(text: string, tone?: 'ok' | 'bad'): Disposable;

  /**
   * 模态确认（`.modal` 遮罩 + `.modalcard`）。`danger` 时按钮换成危险配色、
   * 文案换成"仍要继续"——确认键上写着后果，比通用的"确认"更难误按。
   *
   * **面板 unmount 时 resolve `false`**：调用方 `await` 之后的代码照常往下走，
   * 只是走的是"用户没答应"这一支。
   */
  confirm(opts: { title: string; body?: string; danger?: boolean }): Promise<boolean>;

  /**
   * 抽屉（`.modalcard`，Esc / 点遮罩 / 关闭键都能收）。
   *
   * 第二参给**字符串**就是老样子：铺进 `pre.mono`，看原始 JSON / 一段日志用。
   * 给**节点**则原样放进 `.modalbody`——一张放大的图、一份 `log`、一张 `table`
   * 都可以，抽屉不必知道里面是什么。
   *
   * 放宽入参而不是另开一个 `imageViewer` / `logViewer`：那些"看一眼大的"的需求
   * 彼此只差内容节点，各自发明一个原语等于把同一层浮层的生命周期与关闭语义
   * 复制三遍——而生命周期正是浮层唯一难的地方。
   */
  drawer(title: string, body: string | HTMLElement): Disposable;

  /**
   * 忙碌浮层（`.modal.busy` 遮罩 + `.modalcard`）。**不可关闭**：不听 Esc、不听点遮罩、
   * 没有关闭键，只能靠返回的 `Disposable` 撤下。
   *
   * 与 `drawer` 的分工正在于此。等重启这类场景要的是"这段时间别动"，而 `drawer`
   * 一按 Esc 就开了——用户以为操作取消了，其实进程照样在重启。反过来，看日志用 `busy`
   * 就成了绑架：那里本来就该随时能关。
   *
   * 同样受面板 `signal` 约束：面板卸载时自动撤，不会留一层永远盖着页面的遮罩。
   * abort 之后再调则静默不显示，仍给回一个可安全 `dispose()` 的空句柄。
   */
  busy(title: string, text?: string): Disposable;

  /**
   * 局部禁用一组控件，dispose() 恢复各自原本的 disabled 状态；整页阻塞使用 busy。
   * 同一控件只记录首次原值；dispose() 幂等。
   */
  disable(...els: readonly ConsoleDisablable[]): Disposable;

  readonly fmt: ConsoleFormat;
}

export interface ConsoleSheetOptions {
  title: string;
  /** 标题后的英文小注（`h3 > .en`） */
  en?: string;
  /** 卡片说明行（`.sh-desc`，标题下方一行灰字）。解释这张卡是干嘛的，不放读数。 */
  desc?: string;
}

export interface ConsoleSheet {
  /** 整张卡，扩展把它 append 到 `ctx.root` */
  el: HTMLElement;
  /** 内容区 */
  body: HTMLElement;
  /** 折叠态下显示的一行摘要（`sheet()` 也有，只是不折叠时不显示） */
  note: HTMLElement;
  /** 说明行（`.sh-desc`）。只有传了 `opts.desc` 才存在；给出来是为了之后改写它。 */
  desc: HTMLElement | null;
}

/**
 * `.chip` 的三种配色，对应既有样式表里的 `.chip` / `.chip.warnc` / `.chip.dreamc`。
 *
 * tone 按**角色**命名而不按用途命名：这是跨页通用的词表，一旦写进某个 bot
 * 的功能名（"这是给某某模式用的紫色"），别的页想用同一个配色就得先接受一个
 * 与它无关的概念。`accent` = 需要跳出来但不是警示的第三色。
 */
export type ConsoleChipTone = 'plain' | 'warn' | 'accent';

/**
 * `input.field` / `select.field` / `textarea.field` 共通的选项。
 *
 * 三个回调是**三个不同的时刻**，别当成同一件事的三种写法：
 *
 * | 回调       | 时刻                     | 典型用途                       |
 * | ---------- | ------------------------ | ------------------------------ |
 * | `onInput`  | 每一次击键               | 实时筛选、字数统计、边打边校验 |
 * | `onChange` | 失焦且值变过 / 选中项变了 | 改完就存（改号、改地址）       |
 * | `onCommit` | 按下 Enter               | 敲完直接提交，不必先点别处     |
 *
 * "改完就存"这类场景拿 `onInput` 提交等于**边打字边存**：`10086` 会先存出一个 `1`、
 * 再存一个 `10`……所以后两个不是锦上添花，是那类场景唯一正确的钩子。
 *
 * 三个回调的监听一律带面板 `signal`，扩展不必自己收尾。
 */
export interface ConsoleFieldOptions {
  value?: string;
  placeholder?: string;
  /** 追加到 `field` 之后的 class，如 `mono` */
  cls?: string;
  disabled?: boolean;
  /** 值变了。input/textarea 听 `input`，select 听 `change`。 */
  onInput?: (value: string) => void;
  /**
   * 敲完了：听 `change`（input/textarea 是失焦且值变过，select 是选中项变了）。
   *
   * 注意 select 上 `onInput` 与 `onChange` 是**同一个时刻**（下拉框没有"逐次击键"），
   * 两个都给就都会响；那儿只给一个即可。
   */
  onChange?: (value: string) => void;
  /**
   * 按下 Enter 提交。`textarea` 上要 **Ctrl/⌘+Enter**（裸 Enter 在那儿是换行）。
   *
   * 输入法组词中的那次回车（`isComposing`）不算——中文候选词一敲回车就提交，
   * 是这条钩子最容易踩的坑。
   *
   * 与 `onChange` 同时给的话，浏览器可能在 Enter 之后**再派发一次 `change`**
   * （值确实变过时）。两条钩子做同一件事时，让那个函数自己幂等（新旧值相等就返回）
   * ——这比在原语里猜"哪一次才算数"可靠。
   */
  onCommit?: (value: string) => void;
}

/** `checkbox` 的选项。 */
export interface ConsoleCheckboxOptions {
  checked?: boolean;
  disabled?: boolean;
  /** 悬停气泡（`title` 属性）。写"点一下会发生什么"，别重复标签本身。 */
  title?: string;
  /** 用户拨动时。**`setChecked` 不触发它。** */
  onChange?: (checked: boolean) => void;
}

export interface ConsoleCheckbox {
  /** `label.check`（含方框与标签文字），扩展把它 append 到卡里 */
  el: HTMLLabelElement;
  /** 里面那个 `input[type=checkbox]`。要设 `disabled`、要聚焦时用。 */
  input: HTMLInputElement;
  /** 当前是否勾选 */
  readonly checked: boolean;
  /** 程序化设值，不触发 `onChange` */
  setChecked(checked: boolean): void;
}

export interface ConsoleSegmentedOptions {
  /** 初始选中的 value。不给（或给了一个不在 items 里的值）就一颗都不亮。 */
  value?: string;
  /** `.segwrap.sm`：塞进 `rowbar` 与 `.btn.sm` 并排时用 */
  size?: 'sm' | 'md';
  /** 用户切换时。**点已经选中的那颗不触发**，`setValue` 也不触发。 */
  onSelect?: (value: string) => void;
}

export interface ConsoleSegmented {
  /** `.segwrap`，扩展把它 append 到卡里 */
  el: HTMLDivElement;
  /** 当前选中的 value */
  readonly value: string;
  /** 程序化切换选中态，不触发 `onSelect` */
  setValue(value: string): void;
}

/** `kv` 的一行。`k` 是字段名（左列窄灰），`v` 给节点就直接放。 */
export interface ConsoleKvRow {
  k: string;
  v: string | number | HTMLElement | null | undefined;
}

export interface ConsoleInputOptions extends ConsoleFieldOptions {
  /** 缺省 `text`。`search` 会带上浏览器的清除按钮。 */
  type?: 'text' | 'number' | 'password' | 'search' | 'date';
}

export interface ConsoleSelectOptions extends ConsoleFieldOptions {
  /** 给字符串等价于 `{ value: s, label: s }` */
  options?: readonly (string | { value: string; label?: string })[];
}

export interface ConsoleTextareaOptions extends ConsoleFieldOptions {
  rows?: number;
}

/**
 * 输入器交出的一张图:已按 `ConsolePromptImagesOptions` 归一化(长边缩到上限、超限的
 * 重编码),base64 不带 `data:` 前缀,直接可进 JSON 帧。
 */
export interface ConsoleImageAttachment {
  name: string;
  /** image/jpeg | image/png | image/webp | image/gif */
  mime: string;
  base64: string;
  /** 编码后的字节数 */
  bytes: number;
  width: number;
  height: number;
}

/**
 * 输入器的图片通道。给了就出现附图按钮、接收粘贴与拖放,输入框上方长出缩略图托盘;
 * 不给就是纯文本输入器。
 */
export interface ConsolePromptImagesOptions {
  /** 一条消息最多带几张,缺省 8。超出的拒收并就地提示。 */
  max?: number;
  /** 长边上限(像素),缺省 2048。超过的按比例缩小。 */
  maxEdge?: number;
  /** 单张编码后字节上限,缺省 6MB。超限的按 JPEG 重编码;仍超就拒收。 */
  maxBytes?: number;
}

export interface ConsolePromptInputOptions {
  label?: string;
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
  /** 发送键左侧的紧凑工具入口。节点所有权随 prompt input 一起结束。 */
  tools?: HTMLElement;
  /** 图片通道。不给 = 不收图,`onSubmit` 的第二参恒为空数组。 */
  images?: ConsolePromptImagesOptions;
  /**
   * 文本与图片至少一样非空才触发。
   * 返回 `false` 保留当前内容(文本与托盘都留)；其余返回值表示已接收并清空。
   */
  onSubmit(text: string, images: readonly ConsoleImageAttachment[]): boolean | void;
}

export interface ConsolePromptInput {
  el: HTMLDivElement;
  focus(): void;
  setDisabled(disabled: boolean): void;
}

export interface ConsoleTableOptions {
  /** 表头文字。不给就不渲染 `<thead>`。 */
  head?: readonly string[];
  /** 外框最高多少（如 `calc(100vh - 300px)`）。给了才滚，表头的 sticky 也才有意义。 */
  maxHeight?: string;
}

/**
 * 一格。给字符串/数字就是纯文本；给节点就直接放进去（塞 `pill`、按钮用）；
 * 给对象可以额外指定单元格 class（既有的 `mono` = 等宽不换行，`txt` = 保留换行）。
 */
export type ConsoleCell =
  | string
  | number
  | null
  | undefined
  | HTMLElement
  | { text?: string | number | null; el?: HTMLElement; cls?: string };

export interface ConsoleTable {
  /** 外框 `.tablewrap`，扩展把它 append 到卡里 */
  el: HTMLDivElement;
  /** `<tbody>`，想自己操作行时用 */
  body: HTMLTableSectionElement;
  /** 追加一行 */
  addRow(cells: readonly ConsoleCell[]): HTMLTableRowElement;
  /** 清空。带一句话就铺一行跨列的 `.placeholder` 空态。 */
  clear(empty?: string): void;
}

export interface ConsoleStat {
  /** 小标题（`.k`） */
  k: string;
  /** 大数字（`.v`）。给节点就直接放。 */
  v: string | number | HTMLElement;
  /** 数字后面的小字单位（`.v small`），如 `次` / `tok` */
  unit?: string;
  /** 上强调色（`.stat.accent`）。一屏里只该有一两个。 */
  accent?: boolean;
}

/**
 * 一行日志的配色，对应 `.logline` / `.logline.dim` / `.logline.warn` / `.logline.bad`。
 * 与 `ConsoleChipTone` 一样按**角色**命名：`dim` 是次要噪声（心跳、回执），
 * `warn` 是需要留意但没坏，`bad` 是真出事了。
 */
export type ConsoleLogTone = 'plain' | 'dim' | 'warn' | 'bad';

export interface ConsoleLogOptions {
  /** `conversation` 使用阅读型正文排版；缺省保留等宽日志排版。 */
  variant?: 'plain' | 'conversation';
  /**
   * 日志保留行数上限，超出时从头裁剪，避免长期运行时节点无界增长；缺省 400。
   */
  max?: number;
  /** 外框最高多少（缺省 `240px`）。给了才滚，粘滞也才有意义。 */
  maxHeight?: string;
  /** 一行都没有时铺的空态（`.placeholder`）。不给就留一个空框。 */
  empty?: string;
  /**
   * 距底多少像素之内仍算"贴着底"（缺省 24）。
   *
   * 不能取 0：浏览器报的 `scrollHeight` / `clientHeight` 带小数，滚到底时那三个数
   * 几乎从不严格相等，取 0 等于粘滞永远不成立。
   */
  stickThreshold?: number;
}

export interface ConsoleLog {
  /** `.logview`，扩展把它 append 到卡里 */
  el: HTMLDivElement;
  /** 追加一行，返回那一行的节点（想再往里塞 `chip` / 链接时用） */
  append(line: string, tone?: ConsoleLogTone): HTMLDivElement;
  /** 清空（回到空态） */
  clear(): void;
  /** 当前有几行 */
  readonly count: number;
  /** 此刻是否粘在底部。用来画一颗"回到底部"的按钮。 */
  readonly stuck: boolean;
  /** 滚到底并重新粘住（"回到底部"那颗按钮点下去做的事） */
  scrollToEnd(): void;
}

export interface ConsoleProgressOptions {
  /** 满值，缺省 1。给 0 或非有限数一律当 1（否则读数是 `NaN%`）。 */
  max?: number;
  /** 初值，缺省 0 */
  value?: number;
  /** 左侧小标题。不给就只有右侧读数。 */
  label?: string;
  /** 右侧读数怎么印。不给就是百分比；给了可以印成 `3 / 12`。 */
  format?: (value: number, max: number) => string;
  /** 条的配色，与 `ConsoleChipTone` 同一套词。 */
  tone?: ConsoleChipTone;
}

export interface ConsoleProgress {
  /** `.progress`，扩展把它 append 到卡里 */
  el: HTMLDivElement;
  readonly value: number;
  readonly max: number;
  /** 设值；顺带改满值（总量是边跑边知道的时候用） */
  setValue(value: number, max?: number): void;
  /** 改左侧小标题 */
  setLabel(text: string): void;
}

export interface ConsoleCopyOptions {
  /** 按钮上的字，缺省「复制」 */
  label?: string;
  /** 缺省 `sm`：这颗几乎总是跟在别的东西后面，不该抢主按钮的份量 */
  size?: 'sm' | 'md';
  variant?: 'plain' | 'primary';
  /** 成功那条 toast 的措辞，缺省「已复制」 */
  okText?: string;
}

/**
 * `disable` 收得下的东西：任何带 `disabled` 的控件。
 *
 * 按结构而不是按 `HTMLButtonElement | HTMLInputElement | …` 列举：那串联合每加一种
 * 控件就得改一次，而且把 `checkbox` 句柄里的 `input`、未来某个自带 `disabled` 的
 * 复合控件都挡在外面。允许 null / undefined 是为了让调用方直接写
 * `ui.disable(btn, maybeInput)` 而不必先过滤。
 */
export type ConsoleDisablable = { disabled: boolean } | null | undefined;

export interface ConsoleFormat {
  /** 12345 → `12.3k` */
  count(n: number | null | undefined): string;
  /** 1536 → `1.5K` */
  bytes(n: number | null | undefined): string;
  /** 0.42 → `42%` */
  percent(r: number | null | undefined): string;
  /** ISO 时间戳 → `18:56:48` */
  clock(ts: unknown): string;
  /** 金额，带货币符号 */
  money(n: number | null | undefined, currency?: string): string;
  /** 毫秒 → `1.2s` / `3m 04s` */
  duration(ms: number | null | undefined): string;
}

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

export interface ConsolePanel {
  /**
   * 渲染面板，返回的 Disposable 在 unmount 时释放；ctx.own、interval、frame 已登记的资源无需再次返回。抛错由 host 转成当前面板错误卡，不影响其他面板或其他页。
   */
  mount(ctx: ConsolePanelContext): void | Disposable | Promise<void | Disposable>;
}

/**
 * 一页的浏览器扩展。约定为 `console/client.ts` 的 **default export**。
 *
 * ```ts
 * import type { ConsoleClientBundle } from '../../web/shared/client-panel.ts';
 * const bundle: ConsoleClientBundle = {
 *   panels: {
 *     gate: { mount(ctx) { ctx.root.textContent = 'hello'; } },
 *   },
 * };
 * export default bundle;
 * ```
 *
 * 键是**局部 panel id**，与服务端 `ConsolePanelDecl.id` 对应。声明了但扩展里没有
 * 对应键 → host 渲染"扩展缺这个面板"的错误卡，而不是静默空白。
 */
export interface ConsoleClientBundle {
  panels: Record<string, ConsolePanel>;
}

/**
 * host 侧用来校验 `import()` 回来的东西确实是个扩展。
 *
 * 数组要排掉：`{panels: []}` 也满足 `typeof === 'object'`，放过去之后 host 会
 * 按 `panels[panelId]` 全部取空，报成"扩展缺这个面板"——那是条误导的诊断，
 * 真相是"这压根不是个扩展"。
 */
export function isConsoleClientBundle(v: unknown): v is ConsoleClientBundle {
  const panels = (v as ConsoleClientBundle | null)?.panels;
  return !!panels && typeof panels === 'object' && !Array.isArray(panels);
}

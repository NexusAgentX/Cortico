/**
 * 终端 World 的浏览器扩展 —— 只有一个面板:对话。
 *
 * 这个文件只做装配(把面板接到局部 id 上),面板本体在 `chat.ts`。形状照抄
 * `src/worlds/qq/console/client.ts`,只是这里没有第二个面板需要共享 helper。
 *
 * 与外界的依赖只有一条:`client-panel.ts` 里的**类型**。没有 import 控制台内部
 * 模块,没有 `fetch`,没有 `new WebSocket`,没有 `document.body`——收发一律走
 * `ctx.stream`,DOM 一律用 `ctx.ui` 的原语。
 *
 * 没有 `style.css`:这张界面全部由既有原语拼成(sheet / rowbar / pill / input /
 * button / log),一条自有样式都不需要。需要了再加,别为占位先建一个空文件。
 *
 * 语言:面板从 `ctx.language`(`ConsolePanelContext`)取控制台语言,文案表就在
 * `chat.ts` 顶部两张(`zh` / `en`)就地二选一——扩展不 import 框架的语言模块。
 */

import type { ConsoleClientBundle } from '../../../web/shared/client-panel.ts';
import { chatPanel } from './chat.ts';

const bundle: ConsoleClientBundle = {
  // 键是**局部** panel id,与服务端 `console().panels[].id` 一一对应。
  panels: {
    chat: chatPanel,
  },
};

export default bundle;

/**
 * 验收件的浏览器扩展。
 *
 * 它同时是**给 provider 作者看的最小范例**：一个扩展长什么样、`ctx` 上有什么、
 * 资源怎么登记。所以这里刻意把几类典型用法各演一遍，而不是只写一句 hello。
 *
 * 注意它**没有 import 任何控制台内部模块**——只 import 了 `client-panel.ts` 里的
 * 类型。provider 与 Web Core 之间就该只有这一条类型依赖。
 */

import type {
  ConsoleClientBundle,
  ConsolePanelContext,
} from '../../../web/shared/client-panel.ts';

const bundle: ConsoleClientBundle = {
  panels: {
    // 面板 id 是**局部**的,与服务端 `console().panels` 里声明的那个 id 逐字对应。
    hello: {
      mount(ctx: ConsolePanelContext) {
        const { ui } = ctx;
        const card = ui.sheet({ title: '握手', en: 'hello' });
        const bar = ui.rowbar();
        const msg = ui.msgline('还没握过手。');

        bar.appendChild(ui.button('ping', {
          variant: 'primary',
          size: 'sm',
          onClick: () => {
            void ctx.invoke<{ pings: number; at: string }>('ping')
              .then((r) => {
                msg.textContent = `第 ${r.pings} 次握手,服务端时间 ${ui.fmt.clock(r.at)}`;
                // 徽标由 host 画在页头上,扩展够不着——改了自己的状态就说一声。
                void ctx.refresh();
              })
              .catch((err: unknown) => {
                msg.textContent = String(err);
                msg.classList.add('bad');
              });
          },
        }));
        bar.appendChild(ui.h('span', 'grow'));
        card.body.append(bar, msg);

        // 登记一个资源,用来验收 unmount 之后确实停了。
        let ticks = 0;
        const beat = ui.msgline('');
        ctx.interval(() => {
          ticks++;
          beat.textContent = `面板已存活 ${ticks} 秒`;
        }, 1000);
        card.body.appendChild(beat);

        ctx.root.appendChild(card.el);
      },
    },

    echo: {
      mount(ctx: ConsolePanelContext) {
        const { ui } = ctx;
        const card = ui.sheet({ title: '回声', en: 'echo' });
        const field = ui.input({ placeholder: '随便写点什么' });
        const out = ui.msgline('');
        const bar = ui.rowbar();
        bar.append(field, ui.button('发送', {
          size: 'sm',
          onClick: () => {
            void ctx.invoke<{ echoed: unknown[] }>('echo', [field.value])
              .then((r) => { out.textContent = JSON.stringify(r.echoed); })
              .catch((err: unknown) => { out.textContent = String(err); });
          },
        }));
        card.body.append(bar, out);
        ctx.root.appendChild(card.el);
      },
    },
  },
};

export default bundle;

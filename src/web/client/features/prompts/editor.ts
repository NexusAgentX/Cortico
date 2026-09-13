/**
 * 整条前缀的编辑器：**一个文档**，不是一摞输入框。
 *
 * 为什么非得是一个文档:分成 N 个 textarea 之后,某一块写长了只会把自己撑出滚动条,
 * 下面的块纹丝不动——读起来就不是一条连续的前缀了。整体感这件事没法靠拼卡片凑出来。
 *
 * 于是块变成**文档上的行区间**:背景色是行装饰,标签与分割线由页面按 `blockGeometry()`
 * 在旁边另画一层。区间随编辑自动跟随(`changes.mapPos`),所以在任意一块里增删多少行,
 * 后面的块都跟着上下移动,而"这段文字属于哪份模板"始终算得清。
 *
 * 只读块(工具用法那种来自代码的段)用 `changeFilter` 挡住:它照常参与排版与滚动,
 * 但改不动——比把它挪出编辑器好,挪出去就又不是一整条了。
 */

import { EditorState, StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import {
  Decoration, EditorView, keymap, lineNumbers, type DecorationSet,
} from '@codemirror/view';
import { S } from './strings.ts';

/** 一块 = 一份可编辑模板(或一段只读文本)在文档里占的那一截。 */
export interface PrefixBlock {
  title: string;
  /** 可编辑源的 key;无 = 这一块来自代码,只读 */
  sourceKey?: string;
  /** 按来源分档,决定底色 */
  tone: 'persona' | 'world' | 'derived';
  /** 这一块此刻的文本 */
  text: string;
}

/** 块在文档里的位置。`from`/`to` 随编辑实时更新。 */
interface BlockRange {
  block: PrefixBlock;
  from: number;
  to: number;
}

/** 整份重排(重新载入时用)。 */
const setBlocks = StateEffect.define<BlockRange[]>();
/** 鼠标此刻停在第几块上(-1 = 不在任何块上)。纯装饰用,不影响文档。 */
const setHover = StateEffect.define<number>();

const hoverField = StateField.define<number>({
  create: () => -1,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHover)) return e.value;
    return value;
  },
});

/** 保存状态。`idle` = 这次打开还没动过,什么也不提示。 */
export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved';
const setSaveState = StateEffect.define<SaveState>();

const SAVE_LABEL: Record<SaveState, string> = {
  idle: '',
  dirty: S.saveHintDirty,
  saving: S.saving,
  saved: S.saved,
};

/**
 * 保存状态,外加它落在哪一行(`at` = 换状态那一刻的光标位置)。
 *
 * **文档一变就是 `dirty`**,不等页面来通知——提示的时效性不该押在上层的回调链上;
 * 页面只在保存前后覆盖成 `saving` / `saved`。
 */
const saveField = StateField.define<{ state: SaveState; at: number }>({
  create: () => ({ state: 'idle', at: 0 }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSaveState)) return { state: e.value, at: tr.state.selection.main.head };
    }
    if (tr.docChanged) return { state: 'dirty', at: tr.state.selection.main.head };
    return value;
  },
});

/**
 * 块区间。文档一变就把每个边界映射到新位置——**这是"改哪块"这件事的唯一真相**,
 * 不靠行数快照,也不靠重新扫文本。
 *
 * 两个 assoc 是反的,而且必须反:
 *  - `to` 用 `1`:在块**末尾**敲的字要被这块吃进去(否则边界停在插入点之前,
 *    切出来的文本纹丝不动——那正是"打了字却存不下去"的样子)。
 *  - `from` 用 `-1`:在块**开头**敲的字也归这块。若也用 `1`,起点会让到新内容
 *    之后,那几个字就掉进两块之间的缝里,谁也不认领。
 */
const blockField = StateField.define<BlockRange[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBlocks)) return e.value;
    if (!tr.docChanged) return value;
    return value.map((r) => ({
      block: r.block,
      from: tr.changes.mapPos(r.from, -1),
      to: tr.changes.mapPos(r.to, 1),
    }));
  },
});

/**
 * 每一行按所属块上底色;块首行额外一个 class 用来画上边界。
 *
 * 另外两种提示也在这里出:**鼠标停着的块**与**光标所在的块**。它们必须是行装饰
 * 而不是 CSS `:hover`——一块是很多行,CSS 只命中鼠标底下那一行,整块亮不起来。
 */
const blockDecorations = EditorView.decorations.compute(
  [blockField, hoverField, saveField, 'doc', 'selection'],
  (state) => {
    const ranges: Range<Decoration>[] = [];
    const blocks = state.field(blockField);
    const hovered = state.field(hoverField);
    const caret = state.selection.main.head;
    for (let i = 0; i < blocks.length; i++) {
      const r = blocks[i];
      const first = state.doc.lineAt(Math.min(r.from, state.doc.length)).number;
      const last = state.doc.lineAt(Math.max(r.from, Math.min(r.to, state.doc.length))).number;
      const active = r.block.sourceKey && caret >= r.from && caret <= r.to;
      for (let n = first; n <= last; n++) {
        const line = state.doc.line(n);
        const cls = `cm-block cm-block-${r.block.tone}`
          + (n === first ? ' cm-block-first' : '')
          + (r.block.sourceKey ? '' : ' cm-block-readonly')
          + (i === hovered ? ' cm-block-hover' : '')
          + (active ? ' cm-block-active' : '');
        // 块首行挂上序号:左侧标签与右栏靠它读**真实**位置(见 blockGeometry)
        ranges.push(Decoration.line(
          n === first ? { class: cls, attributes: { 'data-block': String(i) } } : { class: cls },
        ).range(line.from));
      }
    }
    /*
     * 行尾小字,落在**光标那一行**上。
     *
     * 它是那一行的一个属性(`data-save-hint`),字由 CSS 伪元素画。**不能改回
     * widget**:空行上 widget 是那一行仅有的内容,contentEditable 的原生退格删掉
     * 的就是它,于是光标停在空行上时那一下删不掉换行。伪元素同时保住了原来的
     * 性质——字选不中也复制不走,横跨编辑器内外的原生复制也带不上它。
     *
     * 「已保存」是个例外:它只在**存的时候那一行**待着,光标一走开就没了。
     * 让它跟着光标跑的话,那句话就从"这一下存上了"变成了一块跟着走的贴纸——
     * 人在别处改字时它还在旁边说"已保存",正好是最容易看错的时候。
     */
    const save = state.field(saveField);
    const line = state.doc.lineAt(Math.min(caret, state.doc.length));
    const pinned = save.state === 'saved'
      && state.doc.lineAt(Math.min(save.at, state.doc.length)).number !== line.number;
    const label = pinned ? '' : SAVE_LABEL[save.state];
    if (label) {
      ranges.push(Decoration.line({
        class: `cm-save-${save.state}`,
        attributes: { 'data-save-hint': label },
      }).range(line.from));
    }
    return Decoration.set(ranges, true) as DecorationSet;
  },
);

/** 鼠标移动时算出停在第几块上。只在结果变了时 dispatch,免得每帧一次事务。 */
const hoverTracker = EditorView.domEventHandlers({
  mousemove(event, view) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    const blocks = view.state.field(blockField);
    let idx = -1;
    if (pos != null) idx = blocks.findIndex((r) => pos >= r.from && pos <= r.to);
    if (idx !== view.state.field(hoverField)) view.dispatch({ effects: setHover.of(idx) });
    return false;
  },
  mouseleave(_event, view) {
    if (view.state.field(hoverField) !== -1) view.dispatch({ effects: setHover.of(-1) });
    return false;
  },
});

/*
 * 游标标签**不做成 gutter marker**。试过:gutter 元素的位置与内容行会越走越偏
 * (实测第三块起差到 268px),对不上"尖头指着分割线"这件事。
 * 改由页面在编辑器左侧画一层绝对定位的标签,坐标取 `blockGeometry()` ——
 * 和右栏同一套 `lineBlockAt` 读数,那套已经验过是逐块严丝合缝的。
 */

/** 落在只读块里的改动一律拦掉。 */
const readonlyGuard = EditorState.changeFilter.of((tr) => {
  const blocks = tr.startState.field(blockField, false);
  if (!blocks) return true;
  let ok = true;
  tr.changes.iterChangedRanges((fromA, toA) => {
    for (const r of blocks) {
      if (r.block.sourceKey) continue;
      // 只读块内部(不含两端边界)被碰到就否决整笔改动
      if (fromA < r.to && toA > r.from) ok = false;
    }
  });
  return ok;
});

export interface PrefixEditorOptions {
  parent: HTMLElement;
  /** 文档变化时报出每块的当前文本(已按区间切好)。只报可编辑块。 */
  onChange(changed: Array<{ sourceKey: string; text: string }>): void;
  /** Ctrl/Cmd+S。**不自动保存**,写盘只从这里发起。 */
  onSave?(): void;
  /** 几何变化(行数、滚动、尺寸)时通知,用来重排右栏。 */
  onGeometry?(): void;
}

export interface PrefixEditor {
  view: EditorView;
  /** 整份重载:重新拼文档、重设区间。 */
  setBlocks(blocks: PrefixBlock[]): void;
  /** 覆盖行尾提示的状态(保存前后各一次)。打字会自动回到 `dirty`。 */
  setSaveState(state: SaveState): void;
  /** 内容区顶边的视口坐标。左右两层据此换算到与正文同一条基线上。 */
  contentTop(): number;
  /** 某一块此刻在视口里的垂直位置(相对编辑器内容顶部),用来对齐左侧标签与右栏。 */
  blockGeometry(): Array<{
    sourceKey?: string;
    title: string;
    tone: PrefixBlock['tone'];
    top: number;
    height: number;
  }>;
  dispose(): void;
}

/** 块文本拼成一份文档:块之间**恰好一个换行**,那一格属于分隔本身。 */
function joinBlocks(blocks: PrefixBlock[]): { doc: string; ranges: BlockRange[] } {
  const ranges: BlockRange[] = [];
  let doc = '';
  for (const block of blocks) {
    const from = doc.length;
    doc += block.text;
    ranges.push({ block, from, to: doc.length });
    doc += '\n';
  }
  return { doc: doc.replace(/\n$/, ''), ranges };
}

export function createPrefixEditor(opts: PrefixEditorOptions): PrefixEditor {
  let last = new Map<string, string>();

  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        blockField,
        hoverField,
        saveField,
        blockDecorations,
        hoverTracker,
        lineNumbers(),
        readonlyGuard,
        keymap.of([{
          key: 'Mod-s',
          preventDefault: true,
          run: () => { opts.onSave?.(); return true; },
        }]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            const changed: Array<{ sourceKey: string; text: string }> = [];
            for (const r of u.state.field(blockField)) {
              const key = r.block.sourceKey;
              if (!key) continue;
              const text = u.state.doc.sliceString(
                Math.min(r.from, u.state.doc.length),
                Math.min(r.to, u.state.doc.length),
              );
              if (last.get(key) !== text) {
                last.set(key, text);
                changed.push({ sourceKey: key, text });
              }
            }
            if (changed.length) opts.onChange(changed);
          }
          if (u.docChanged || u.geometryChanged || u.viewportChanged) opts.onGeometry?.();
        }),
      ] as Extension[],
    }),
  });

  return {
    view,
    setBlocks(blocks) {
      const { doc, ranges } = joinBlocks(blocks);
      last = new Map(blocks.filter((b) => b.sourceKey).map((b) => [b.sourceKey!, b.text]));
      view.dispatch({
        // 载入不是"改动":`setSaveState` 与 `setBlocks` 同批发,把 docChanged
        // 顺带置上的 dirty 压回去,否则一进页面就挂着"按 Ctrl+S 保存"
        changes: { from: 0, to: view.state.doc.length, insert: doc },
        effects: [setBlocks.of(ranges), setSaveState.of('idle')],
      });
      opts.onGeometry?.();
    },
    setSaveState(state) {
      view.dispatch({ effects: setSaveState.of(state) });
    },
    contentTop: () => view.contentDOM.getBoundingClientRect().top,
    /**
     * 各块此刻的垂直位置。**优先量真实 DOM**:`lineBlockAt` 给的是 heightMap 读数,
     * 而视口外的行是**估算**高度——中文加自动折行之后估得很不准,实测到第三块就差
     * 近 300px,标签和右栏会整体飘走。块首行上挂了 `data-block`,量它最准;
     * 那一行没渲染出来时才退回估算。
     */
    blockGeometry() {
      const out: Array<{
        sourceKey?: string; title: string; tone: PrefixBlock['tone']; top: number; height: number;
      }> = [];
      const len = view.state.doc.length;
      const blocks = view.state.field(blockField);
      const base = view.contentDOM.getBoundingClientRect().top;
      const topOf = (i: number, pos: number): number => {
        const el = view.contentDOM.querySelector(`[data-block="${i}"]`);
        if (el) return el.getBoundingClientRect().top - base;
        return view.lineBlockAt(Math.min(pos, len)).top;
      };
      for (let i = 0; i < blocks.length; i++) {
        const r = blocks[i];
        const top = topOf(i, r.from);
        // 高度取到下一块的起点;最后一块吃到内容底部
        const next = i + 1 < blocks.length
          ? topOf(i + 1, blocks[i + 1].from)
          : view.contentDOM.getBoundingClientRect().height;
        out.push({
          sourceKey: r.block.sourceKey,
          title: r.block.title,
          tone: r.block.tone,
          top,
          height: Math.max(next - top, 0),
        });
      }
      return out;
    },
    dispose: () => view.destroy(),
  };
}

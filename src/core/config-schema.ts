/**
 * 可调配置项的**声明**方式。
 *
 * 类型住在 core 里,因为**声明的人**是 core / Persona / 各 World 三方,
 * 而控制台只是这份声明的消费者之一,不是它的定义者。
 *
 * World 与Persona各自声明一组 schema 化的配置项,控制台按 schema 通用渲染表单,
 * 不做前端代码扩展。meta-schema 直接用 JSON Schema——工具参数
 * (`ToolSchema.parameters`)已经在用它,自创词表早晚会长成一门小语言。
 *
 * 控制台不规定语言,只**说明自己认识哪个子集**:
 *   integer / number / boolean / string(含 enum / x-options) / 2 元数组(`prefixItems` 或
 *   `items` + minItems=maxItems=2)。其余一律降级成只读文本,永远不阻塞任何人。
 *
 * 标准 JSON Schema 没有位置放的六样东西走 `x-` 扩展:
 *   x-scale    显示换算(显示值 = 存储值 / scale;回传时乘回去)
 *   x-suffix   单位后缀
 *   x-hot      是否热生效(false = 前端标"重启生效")
 *   x-options  下拉的动态选项源(打开前向 `/api/config/options/:kind` 探测);
 *              存的仍是字符串,不把当时的设备表写成 enum,以免拔掉设备后写不回。
 *   x-path     本机文件/目录选择器；字符串仍是实际存储值。
 *   x-download 与该路径配套的浏览器下载链接。
 */
import type { CoreConfig } from './types.ts';
import { pick, type Language } from './language.ts';

export interface ConfigProperty {
  type: 'integer' | 'number' | 'boolean' | 'string' | 'array';
  title: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  enum?: string[];
  /** 2 元数组的元素声明 */
  items?: { type: 'integer' | 'number'; minimum?: number; maximum?: number };
  minItems?: number;
  maxItems?: number;
  /** 允许写 null(用于"留空＝关掉"这类项) */
  nullable?: boolean;
  'x-scale'?: number;
  'x-suffix'?: string;
  'x-hot'?: boolean;
  /** 动态下拉的选项源 id;控制台打开下拉前现探 */
  'x-options'?: string;
  /** 字符串路径的本机选择器。推荐目录只作部署提示与对话框起始位置。 */
  'x-path'?: {
    kind: 'file' | 'directory';
    extensions?: string[];
    recommendedDir?: string;
  };
  /** 由声明方提供的可信下载地址。 */
  'x-download'?: {
    href: string;
    label?: string;
  };
}

export interface ConfigGroupSchema {
  type: 'object';
  title: string;
  description?: string;
  /** 键是 cfg 中的点分路径。 */
  properties: Record<string, ConfigProperty>;
}

export interface ConfigGroup {
  /**
   * 稳定 id:这一组旋钮的实例身份,用于前端分组和提交寻址。
   * 框架将其视为所有者定义的不透明名称,允许使用具体Persona的名称。
   */
  id: string;
  /**
   * 参数组的所有者角色，不包含具体实现身份。
   * 不同Persona可使用不同 id，但 owner 均为 `persona`。
   */
  owner: 'core' | 'persona' | `world:${string}` | `provider:${string}`;
  /**
   * 画在**设置 → 运行参数**的最下面,不跟归属页走。
   *
   * 控制台的缺省规则是「认领了的组画在认领方自己那一页」;声明方可以用这一位
   * 明确放弃认领——组照常注册、owner 照旧(写入权不变),只是渲染位置落回设置页。
   * 适用于"操作员在系统设置里找得到才对"的那类旋钮(如上下文交接阈值)。
   */
  settingsPage?: boolean;
  schema: ConfigGroupSchema;
}

export type ConfigValue = number | boolean | string | null | [number, number];
export type ConfigValues = Record<string, ConfigValue>;


export function getByPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 就地写叶子:只替换叶子属性,沿途父对象身份保持(热改靠的就是这一点) */
export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.');
  const leaf = segs.pop()!;
  let cur: Record<string, unknown> = obj;
  for (const seg of segs) {
    const next = cur[seg];
    if (next == null || typeof next !== 'object') cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[leaf] = value;
}

/** 一组配置项的当前值(按 schema 的键从活配置里读) */
export function readGroupValues(cfg: CoreConfig, group: ConfigGroup, read?: (path:string)=>unknown): ConfigValues {
  const root = cfg as unknown as Record<string, unknown>;
  const out: ConfigValues = {};
  for (const [path, prop] of Object.entries(group.schema.properties)) {
    const raw = read ? read(path) : getByPath(root, path);
    if (prop.type === 'boolean') out[path] = raw === true;
    else if (prop.type === 'array') {
      const pair = Array.isArray(raw) ? raw : [0, 0];
      out[path] = [Number(pair[0]) || 0, Number(pair[1]) || 0];
    } else if (prop.type === 'string') out[path] = raw == null ? '' : String(raw);
    else if (raw == null) out[path] = prop.nullable ? null : 0;
    else out[path] = Number(raw);
  }
  return out;
}


/** 校验回执的措辞。`label` 是声明方给的 title,已经是当前语言。 */
const VALIDATION_TEXT = {
  zh: {
    notNumber: (label: string) => `${label} 必须是数值`,
    below: (label: string, min: number) => `${label} 不能小于 ${min}`,
    above: (label: string, max: number) => `${label} 不能大于 ${max}`,
    notInEnum: (label: string, options: string) => `${label} 只能是 ${options}`,
    needsPair: (label: string) => `${label} 需要两个数`,
    first: (label: string) => `${label} 第一项`,
    second: (label: string) => `${label} 第二项`,
    pairOrder: (label: string) => `${label} 的第一项不能大于第二项`,
    empty: (label: string) => `${label} 不能为空`,
  },
  en: {
    notNumber: (label: string) => `${label} must be a number`,
    below: (label: string, min: number) => `${label} cannot be less than ${min}`,
    above: (label: string, max: number) => `${label} cannot be greater than ${max}`,
    notInEnum: (label: string, options: string) => `${label} must be one of ${options}`,
    needsPair: (label: string) => `${label} needs two numbers`,
    first: (label: string) => `${label} (first)`,
    second: (label: string) => `${label} (second)`,
    pairOrder: (label: string) => `${label}: the first value cannot exceed the second`,
    empty: (label: string) => `${label} cannot be empty`,
  },
};
const validationText = (language: Language) => pick(language, VALIDATION_TEXT);
type ValidationText = ReturnType<typeof validationText>;

const numberIn = (
  raw: unknown,
  prop: ConfigProperty | NonNullable<ConfigProperty['items']>,
  label: string,
  integer: boolean,
  text: ValidationText,
): number | { error: string } => {
  let n = Number(raw);
  if (!Number.isFinite(n)) return { error: text.notNumber(label) };
  if (integer) n = Math.floor(n);
  if (prop.minimum != null && n < prop.minimum) return { error: text.below(label, prop.minimum) };
  if (prop.maximum != null && n > prop.maximum) return { error: text.above(label, prop.maximum) };
  return n;
};

/**
 * 按 schema 校验并规整前端提交的值。未声明的键不进入配置。
 * 回执措辞跟控制台语言走;缺省中文,调用方不必都知道语言。
 */
export function coerceGroupValues(
  group: ConfigGroup,
  body: Record<string, unknown>,
  language: Language = 'zh',
): { values: ConfigValues } | { error: string } {
  const text = validationText(language);
  const out: ConfigValues = {};
  for (const [path, prop] of Object.entries(group.schema.properties)) {
    if (!(path in body)) continue;
    const raw = body[path];
    const label = prop.title;

    if (prop.type === 'boolean') {
      out[path] = raw === true;
      continue;
    }
    if (prop.type === 'string') {
      const s = String(raw ?? '');
      if (prop.enum && !prop.enum.includes(s)) {
        return { error: text.notInEnum(label, prop.enum.join(' / ')) };
      }
      out[path] = s;
      continue;
    }
    if (prop.type === 'array') {
      if (!Array.isArray(raw) || raw.length !== 2) return { error: text.needsPair(label) };
      const spec = prop.items ?? { type: 'number' as const };
      const integer = spec.type === 'integer';
      const first = numberIn(raw[0], spec, text.first(label), integer, text);
      if (typeof first !== 'number') return first;
      const second = numberIn(raw[1], spec, text.second(label), integer, text);
      if (typeof second !== 'number') return second;
      if (first > second) return { error: text.pairOrder(label) };
      out[path] = [first, second];
      continue;
    }
    if (prop.type === 'integer' || prop.type === 'number') {
      if (raw === null) {
        // 必须在数值转换前处理 null;Number(null) 会将清空请求转换为 0。
        if (!prop.nullable) return { error: text.empty(label) };
        out[path] = null;
        continue;
      }
      const n = numberIn(raw, prop, label, prop.type === 'integer', text);
      if (typeof n !== 'number') return n;
      out[path] = n;
      continue;
    }
    // 声明用了控制台不认识的 type:和前端一样降级成只读,不参与写回,也不拦别人
  }
  return { values: out };
}

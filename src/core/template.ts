/**
 * 前缀模板渲染。**整个 system 前缀里的每一个字都来自模板文件**,代码只提供值——
 * 这条不变量靠机制保证:契约上没有任何返回前缀文本的方法(见 `World.envPromptVars`)。
 *
 * 语法只有三条,不会再多。一旦开了条件块的口子,接着就要循环、要比较、要转义规则,
 * 最后是在维护一个半吊子 Handlebars——而列表行格式的可调性换不来这些复杂度。
 *
 * 1. `{{name}}`            取值;值为空且没写缺省 = 展开成空串
 * 2. `{{name | 缺省文案}}`  值为空时用缺省文案(分支的**选择权归代码、措辞权归人**)
 * 3. 名字不在值表里         **原样保留** `{{name}}` 到输出里
 *
 * 第 3 条是有意的:静默吞成空串会让人以为改生效了;原样留着,在渲染预览里一眼看见
 * 自己写错了。与「IO 回报三原则」的"原样回报事实"是同一件事。
 */

/** `{{名字}}` 或 `{{名字 | 缺省文案}}`。名字限 `[\w.]`,缺省文案吃到 `}}` 为止。 */
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*(?:\|([^}]*))?\}\}/g;

/** 模板里出现过的占位符名(按出现序,去重)。编辑器用它标"已用/未使用"。 */
export function templateVarNames(template: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER)) {
    const name = m[1];
    if (!seen.has(name)) { seen.add(name); names.push(name); }
  }
  return names;
}

/**
 * 渲染模板，vars 中缺席的占位符原样保留，默认值与空串规则见文件头。
 */
export function renderTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (whole, name: string, fallback?: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return whole;
    const value = vars[name] ?? '';
    if (value !== '') return value;
    return fallback === undefined ? '' : fallback.trim();
  });
}

/** 模板里用了但没人报值的占位符。控制台据此给黄色警告(警告不阻止保存)。 */
export function unknownVarNames(
  template: string,
  declared: readonly string[],
): string[] {
  const known = new Set(declared);
  return templateVarNames(template).filter((name) => !known.has(name));
}

/** 顶层模板切出来的一段:`name` 是那个占位符,`text` 是它连同前面的字面文本。 */
export interface RenderedSection {
  name: string;
  text: string;
}

/**
 * 按占位符把模板切成段,同时给出完整渲染结果。
 *
 * **切法保证 `sections.map(s => s.text).join('') === text`**:每一段带上它前面那截
 * 字面文本(分隔线、空行),尾部剩余的归最后一段。所以段是"观察视图",拼回去逐字
 * 还原实际发出的前缀——不会出现"看到的分段"与"发出去的文本"对不上的情况。
 *
 * 模板里一个占位符都没有时,整份内容作为一段返回(name 为空串)。
 */
export function renderSections(
  template: string,
  vars: Readonly<Record<string, string>>,
): { text: string; sections: RenderedSection[] } {
  const sections: RenderedSection[] = [];
  let cursor = 0;
  for (const m of template.matchAll(PLACEHOLDER)) {
    const start = m.index ?? 0;
    sections.push({
      name: m[1],
      text: template.slice(cursor, start) + renderTemplate(m[0], vars),
    });
    cursor = start + m[0].length;
  }
  const tail = template.slice(cursor);
  if (sections.length === 0) return { text: tail, sections: [{ name: '', text: tail }] };
  if (tail) sections[sections.length - 1].text += tail;
  return { text: sections.map((s) => s.text).join(''), sections };
}

/**
 * 花名册:派生视图,拼装时机械抽取每个people/*.md的
 * 文件名+第一行,拼成"我认识的人"列表。没有第二处维护,不会漂移。
 *
 * 第一行惯例是花名册机制的功能性依赖:第一行=当前主要称呼+
 * 一句话概括,由工具说明点明,主agent追加观察不动第一行。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 一个人都没有时交空串:"还不认识任何人"该怎么说,归 MEMORY.md 的缺省文案。 */
export function buildRoster(memoryDir: string): string {
  const dir = join(memoryDir, 'people');
  if (!existsSync(dir)) return '';
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md')
      && !e.name.startsWith('.') && !e.name.includes('.tmp-'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  if (files.length === 0) return '';

  return files
    .map((f) => {
      let first = '';
      try {
        const text = readFileSync(join(dir, f), 'utf8');
        first = (text.split(/\r?\n/, 1)[0] ?? '').trim();
      } catch {
        first = '(档案读取失败)';
      }
      // 用"—"连接:档案第一行惯例本身就常以"称呼:"开头,冒号连接会双冒号
      return `- ${f.replace(/\.md$/i, '')} — ${first || '(档案第一行为空)'}`;
    })
    .join('\n');
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { GitWorkspaceMemory } from '../../bots/cormini/persona/memory.ts';
import { MemoTiers } from '../../bots/corti-soulmate/persona/memoTiers.ts';
import { tmpPersona, cleanup, touch, WORKSPACE_DIRS } from './helpers.ts';

/**
 * MemoTiers 现在只是三层的只读视图:层间搬运交给通用文件工具 + tools.ts 的
 * 容量守门。这里验证"某层有哪些文件"按 mtime 升序、archived 只计数、
 * 扩展名不参与判定。mtime 用 utimesSync 手动控制,保证时间序确定。
 */
describe('MemoTiers 只读视图', () => {
  let dir: string;
  let ws: GitWorkspaceMemory;
  let m: MemoTiers;
  let t: number;

  const put = (rel: string, body = 'x') => {
    ws.writeFileAtomic(rel, body);
    touch(join(dir, ...rel.split('/')), t++);
  };

  beforeEach(() => {
    dir = tmpPersona();
    ws = new GitWorkspaceMemory({ memoryDir: dir });
    ws.ensureDirs(WORKSPACE_DIRS);
    m = new MemoTiers(ws, { residentCap: 3, activeCap: 2 });
    t = 1_700_000_000;
  });
  afterEach(() => cleanup(dir));

  it('空工作区:三层都空', () => {
    expect(m.residentFiles()).toEqual([]);
    expect(m.activeFiles()).toEqual([]);
    expect(m.archivedCount()).toBe(0);
  });

  it('residentFiles/activeFiles 按 mtime 升序(最旧在前),archivedCount 计数', () => {
    put('memo/b.md'); // 先写(更旧)
    put('memo/a.md'); // 后写(更新)
    put('memo/active/y.md');
    put('memo/active/x.md');
    put('memo/archived/z1.md');
    put('memo/archived/z2.md');
    expect(m.residentFiles()).toEqual(['b.md', 'a.md']);
    expect(m.activeFiles()).toEqual(['y.md', 'x.md']);
    expect(m.archivedCount()).toBe(2);
  });

  it('无扩展名和非.md文件也计入，避免memo条目隐身', () => {
    put('memo/keep.md');
    put('memo/no-extension');
    put('memo/active/scratch.txt');
    put('memo/archived/legacy');
    expect(m.residentFiles()).toEqual(['keep.md', 'no-extension']);
    expect(m.activeFiles()).toEqual(['scratch.txt']);
    expect(m.archivedCount()).toBe(1);
  });
});

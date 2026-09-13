/**
 * 人格控制面声明局部 id 与标题；baseRevision 按文件内容 sha256 检查冲突，createOnly 拒绝撞名。
 * 控制台编辑、删除、改名提交到 persona 仓，署名 operator。权限矩阵逐格执行 checkAccess 得出。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { personaConsoleDecl, PERSONA_PANELS } from '../../bots/corti-soulmate/persona/consoleSurface.ts';
import type {
  MemoryState, WorkspaceFile, WorkspaceNode, WorkspaceWriteResult,
} from '../../bots/corti-soulmate/persona/consoleSurface.ts';
import { MemoTiers } from '../../bots/corti-soulmate/persona/memoTiers.ts';
import type { PersonaRole } from '../../bots/corti-soulmate/persona/permissions.ts';
import { GitWorkspaceMemory } from '../../bots/cormini/persona/memory.ts';
import type { WorkspaceGit } from '../../bots/cormini/persona/workspaceGit.ts';
import type { PersonaConsoleDecl } from '../../src/core/types.ts';
import { cleanup, tmpPersona, WORKSPACE_DIRS } from './helpers.ts';

const gitAvailable = new GitWorkspaceMemory({ memoryDir: process.cwd() }).git.available();

let dir: string;
let decl: PersonaConsoleDecl;
let git: WorkspaceGit;

const call = <T>(panel: string, method: string, args: unknown[] = []): Promise<T> =>
  decl.invoke!(panel, method, args) as Promise<T>;

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

beforeEach(() => {
  dir = tmpPersona();
  const memory = new GitWorkspaceMemory({ memoryDir: dir, warn: () => { /* 测试里不往控制台喊 */ } });
  memory.ensureDirs(WORKSPACE_DIRS);
  writeFileSync(join(dir, 'note', 'a.md'), '第一版\n', 'utf8');
  writeFileSync(join(dir, 'memo', 'today.md'), '今天\n', 'utf8');
  mkdirSync(join(dir, 'memo', 'active'), { recursive: true });
  writeFileSync(join(dir, 'memo', 'active', 'later.md'), '回头看\n', 'utf8');
  git = memory.git;
  git.init();
  decl = personaConsoleDecl({
    memory,
    memo: new MemoTiers(memory, { residentCap: 5, activeCap: 9 }),
    emergences: () => ['[surfaced from association] 一缕'],
  });
});

afterEach(() => cleanup(dir));

// ---------------------------------------------------------------------------

describe('Persona的面板声明', () => {
  it('三个面板都是局部 id + 真标题,不带 bot 名前缀', () => {
    expect(PERSONA_PANELS.map((p) => p.id)).toEqual(['workspace', 'memory', 'history']);
    expect(PERSONA_PANELS.map((p) => p.title)).toEqual(['工作区', 'Memory 分层', '版本历史']);
    for (const p of PERSONA_PANELS) expect(p.description).toBeTruthy();
    expect(decl.panels).toEqual(PERSONA_PANELS);
  });

  it('不认识的面板与方法各报各的,措辞写给人看', async () => {
    await expect(call('nope', 'state')).rejects.toThrow('未知面板');
    await expect(call('memory', 'nope')).rejects.toThrow('未知面板方法');
  });
});

describe('工作区:目录树与读取', () => {
  it('树是递归的,目录在前、同类按名排;隐藏文件与原子写临时文件不进树', async () => {
    writeFileSync(join(dir, '.secret'), 'x', 'utf8');
    writeFileSync(join(dir, 'note', 'b.md.tmp-abc'), 'x', 'utf8');
    const { nodes } = await call<{ nodes: WorkspaceNode[] }>('workspace', 'tree');
    expect(nodes.map((n) => n.name)).not.toContain('.secret');
    // 目录整段排在文件前面(顶层只有 ensureDirs 建的那几个目录)
    const kinds = nodes.map((n) => n.type);
    expect(kinds.lastIndexOf('dir')).toBeLessThan(
      kinds.indexOf('file') === -1 ? Number.MAX_SAFE_INTEGER : kinds.indexOf('file'),
    );
    const note = nodes.find((n) => n.name === 'note');
    expect(note?.type).toBe('dir');
    // 子层同样是"目录在前、同类按名排",且临时文件没进来
    expect(note?.children?.map((c) => c.name)).toEqual(['library', 'playbook', 'a.md']);
  });

  it('read 回内容与 revision(= 内容的 sha256),目录/不存在各报各的', async () => {
    const f = await call<WorkspaceFile>('workspace', 'read', ['note/a.md']);
    expect(f.content).toBe('第一版\n');
    expect(f.revision).toBe(sha('第一版\n'));
    expect(f.size).toBeGreaterThan(0);
    await expect(call('workspace', 'read', ['note'])).rejects.toThrow('是目录');
    await expect(call('workspace', 'read', ['note/ghost.md'])).rejects.toThrow('文件不存在');
  });

  it('二进制文件拒绝预览(措辞照抄旧的 /api/file)', async () => {
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([1, 0, 2]));
    await expect(call('workspace', 'read', ['blob.bin'])).rejects.toThrow('二进制文件');
  });

  it('路径逃逸被工作区层拦下', async () => {
    await expect(call('workspace', 'read', ['../outside.md'])).rejects.toThrow('不允许离开');
  });
});

describe('工作区:保存的冲突检测(旧 409 的语义)', () => {
  it('底本对得上就写入,并回新的 revision', async () => {
    const before = await call<WorkspaceFile>('workspace', 'read', ['note/a.md']);
    const out = await call<WorkspaceWriteResult>(
      'workspace', 'write', ['note/a.md', '第二版\n', before.revision],
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.revision).toBe(sha('第二版\n'));
    expect(readFileSync(join(dir, 'note', 'a.md'), 'utf8')).toBe('第二版\n');
  });

  it('底本对不上:拒绝写入,回原话与当前 revision(不覆盖别处的改动)', async () => {
    const stale = sha('别的版本\n');
    const out = await call<WorkspaceWriteResult>(
      'workspace', 'write', ['note/a.md', '我的版本\n', stale],
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.conflict).toBe(true);
    expect(out.error).toBe('文件已在别处被修改，请重新载入后再保存');
    expect(out.currentRevision).toBe(sha('第一版\n'));
    // 关键:文件没被动过
    expect(readFileSync(join(dir, 'note', 'a.md'), 'utf8')).toBe('第一版\n');
  });

  it('底本文件已被移动或删除:同样拒绝', async () => {
    const out = await call<WorkspaceWriteResult>(
      'workspace', 'write', ['note/ghost.md', 'x', sha('x')],
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('文件已被移动或删除');
  });

  it('createOnly 撞上同名文件就拒绝,不覆盖', async () => {
    const out = await call<WorkspaceWriteResult>(
      'workspace', 'write', ['note/a.md', '新的', null, true],
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('同名文件已经存在');
    expect(readFileSync(join(dir, 'note', 'a.md'), 'utf8')).toBe('第一版\n');
  });

  it('不给底本 = 不核对(新建走这条路)', async () => {
    const out = await call<WorkspaceWriteResult>('workspace', 'write', ['note/new.md', '内容', null]);
    expect(out.ok).toBe(true);
    expect(readFileSync(join(dir, 'note', 'new.md'), 'utf8')).toBe('内容');
  });

  it('超过 1MB / 含 NUL 的正文拒绝保存', async () => {
    await expect(
      call('workspace', 'write', ['note/big.md', 'x'.repeat(1024 * 1024 + 1), null]),
    ).rejects.toThrow('文件超过1MB');
    await expect(
      call('workspace', 'write', ['note/nul.md', 'a\0b', null]),
    ).rejects.toThrow('NUL');
  });

  it('删除与改名同样核对底本,措辞各自成句', async () => {
    const stale = sha('别的\n');
    const del = await call<WorkspaceWriteResult>('workspace', 'remove', ['note/a.md', stale]);
    expect(del.ok).toBe(false);
    if (!del.ok) expect(del.error).toBe('文件已在别处被修改，请重新载入后再删除');

    const ren = await call<WorkspaceWriteResult>('workspace', 'rename', ['note/a.md', 'note/b.md', stale]);
    expect(ren.ok).toBe(false);
    if (!ren.ok) expect(ren.error).toBe('文件已在别处被修改，请重新载入后再改名');
  });
});

describe.skipIf(!gitAvailable)('工作区:写路径带提交', () => {
  it('编辑立即提交,署名 operator,回执带短 hash', async () => {
    const before = await call<WorkspaceFile>('workspace', 'read', ['note/a.md']);
    const out = await call<WorkspaceWriteResult>(
      'workspace', 'write', ['note/a.md', '第二版\n', before.revision],
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result).toMatch(/已保存并提交\(/);
    const last = git.log({ limit: 1 })[0];
    expect(last.author).toBe('operator');
    expect(last.message).toBe('控制台编辑 note/a.md');
  });

  it('某个文件的历史 / diff / 旧版本全文都取得到', async () => {
    const before = await call<WorkspaceFile>('workspace', 'read', ['note/a.md']);
    await call('workspace', 'write', ['note/a.md', '第二版\n', before.revision]);
    const { commits } = await call<{ commits: Array<{ fullHash: string }> }>(
      'workspace', 'history', ['note/a.md'],
    );
    expect(commits.length).toBeGreaterThanOrEqual(1);
    const d = await call<{ diff: string }>('workspace', 'diff', [commits[0].fullHash, 'note/a.md']);
    expect(d.diff).toContain('第二版');
    const at = await call<{ content: string }>('workspace', 'at', [commits[0].fullHash, 'note/a.md']);
    expect(at.content).toBe('第二版\n');
  });
});

describe.skipIf(!gitAvailable)('版本历史面板', () => {
  it('整仓流水 + 介质状态一次问齐;路径过滤只看那一支', async () => {
    const st = await call<{ status: { repo: boolean }; commits: unknown[]; path: string }>(
      'history', 'state', [],
    );
    expect(st.status.repo).toBe(true);
    expect(st.commits.length).toBeGreaterThanOrEqual(1);
    expect(st.path).toBe('');

    const before = await call<WorkspaceFile>('workspace', 'read', ['memo/today.md']);
    await call('workspace', 'write', ['memo/today.md', '改过\n', before.revision]);
    const filtered = await call<{ commits: Array<{ message: string }>; path: string }>(
      'history', 'state', ['memo/today.md'],
    );
    expect(filtered.path).toBe('memo/today.md');
    expect(filtered.commits.every((c) => !c.message.startsWith('控制台编辑 note/'))).toBe(true);
  });
});

describe('Memory 面板', () => {
  it('五层都在,memo 三级读数取自真目录', async () => {
    const st = await call<MemoryState>('memory', 'state');
    expect(st.tiers.map((t) => t.id)).toEqual([
      'MEMORY 0', 'MEMORY 1', 'MEMORY 2', 'MEMORY 3', 'MEMORY 4',
    ]);
    expect(st.memo.resident).toEqual(['today.md']);
    expect(st.memo.active).toEqual(['later.md']);
    expect(st.memo.residentCap).toBe(5);
    expect(st.memo.activeCap).toBe(9);
    // MEMORY 3 的读数来自Persona持有的浮现
    expect(st.tiers[3].live).toContain('1');
  });

  it('权限矩阵逐格现算:主意识对 people/ 只能追加、external/ 全权,梦全区可写', async () => {
    const st = await call<MemoryState>('memory', 'state');
    expect(st.matrix.roles).toEqual(['main', 'dream']);
    const at = (zone: string, role: PersonaRole) => {
      const row = st.matrix.rows.find((r) => r.zone === zone)!;
      return row.cells[st.matrix.roles.indexOf(role)];
    };
    // 读一律放行,所以每一格都含 read
    for (const row of st.matrix.rows) {
      for (const cell of row.cells) expect(cell.allowed).toContain('read');
    }
    expect(at('note', 'main').allowed).toEqual(['read', 'write', 'append', 'rename']);
    expect(at('people', 'main').allowed).toEqual(['read', 'append']);
    expect(at('external', 'main').allowed).toEqual(['read', 'write', 'append', 'rename', 'delete']);
    expect(at('worldview', 'dream').allowed).toEqual(['read', 'write', 'append', 'rename', 'delete']);
    // 拒绝理由就是 agent 会收到的那句原话
    expect(at('worldview', 'main').denied[0].reason).toContain('dream');
  });

  it('宪法归梦修订:梦可改内容,不能改名删除;主意识只读', async () => {
    const st = await call<MemoryState>('memory', 'state');
    const row = st.matrix.rows.find((r) => r.zone === 'constitution')!;
    expect(row.cells[st.matrix.roles.indexOf('dream')].allowed).toEqual(['read', 'write', 'append']);
    expect(row.cells[st.matrix.roles.indexOf('main')].allowed).toEqual(['read']);
  });
});

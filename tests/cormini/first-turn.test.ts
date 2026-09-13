/**
 * Cormini 的首轮对话(风格锚)接入:三份源文件 → firstTurn() 内容,
 * promptDocs 自报(设置页「首轮对话」经 /api/prompts 读写的就是它们)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cormini, FIRST_TURN_FILES } from '../../bots/cormini/persona/persona.ts';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cormini-firstturn-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Cormini 首轮对话', () => {
  it('读 firstTurnDir 的三份文件,返回一轮内容', () => {
    const ftDir = join(dir, 'ft');
    mkdirSync(ftDir, { recursive: true });
    writeFileSync(join(ftDir, FIRST_TURN_FILES.user), '早呀\n', 'utf8');
    writeFileSync(join(ftDir, FIRST_TURN_FILES.thinking), '轻快地回\n', 'utf8');
    writeFileSync(join(ftDir, FIRST_TURN_FILES.reply), '早——\n', 'utf8');
    const p = new Cormini({ memoryDir: join(dir, 'ws1'), firstTurnDir: ftDir });
    expect(p.firstTurn()).toEqual([{ user: '早呀', thinking: '轻快地回', reply: '早——' }]);
  });

  it('thinking 文件为空时该轮不带 thinking 字段;文件缺失当空串', () => {
    const ftDir = join(dir, 'ft2');
    mkdirSync(ftDir, { recursive: true });
    writeFileSync(join(ftDir, FIRST_TURN_FILES.user), 'u', 'utf8');
    writeFileSync(join(ftDir, FIRST_TURN_FILES.reply), 'r', 'utf8');
    const p = new Cormini({ memoryDir: join(dir, 'ws2'), firstTurnDir: ftDir });
    const rounds = p.firstTurn();
    expect(rounds).toEqual([{ user: 'u', reply: 'r' }]);
    expect('thinking' in rounds[0]).toBe(false);
  });

  it('promptDocs 自报三份 firstTurn.* 源,路径指向 firstTurnDir', () => {
    const ftDir = join(dir, 'ft3');
    mkdirSync(ftDir, { recursive: true });
    const p = new Cormini({ memoryDir: join(dir, 'ws3'), firstTurnDir: ftDir });
    const docs = p.console().promptDocs ?? [];
    const keys = docs.map((d) => d.key);
    expect(keys).toContain('firstTurn.user');
    expect(keys).toContain('firstTurn.thinking');
    expect(keys).toContain('firstTurn.reply');
    const userDoc = docs.find((d) => d.key === 'firstTurn.user')!;
    expect(userDoc.path).toBe(join(ftDir, FIRST_TURN_FILES.user));
    // 不是前缀段也不是环境提示词:不标 role,不进前缀装配
    expect(userDoc.role).toBeUndefined();
  });

  it('不传 firstTurnDir = 没有首轮对话:不注入、不自报源', () => {
    const p = new Cormini({ memoryDir: join(dir, 'ws4') });
    expect(p.firstTurn()).toEqual([]);
    expect((p.console().promptDocs ?? []).some((d) => d.key.startsWith('firstTurn.'))).toBe(false);
  });

  it('目录给了但文件还没写:一轮空内容(=不注入),源照常自报好让控制台能创建它们', () => {
    const ftDir = join(dir, 'ft5');
    const p = new Cormini({ memoryDir: join(dir, 'ws5'), firstTurnDir: ftDir });
    expect(existsSync(ftDir)).toBe(false);
    expect(p.firstTurn()).toEqual([{ user: '', reply: '' }]);
    const docs = (p.console().promptDocs ?? []).filter((d) => d.key.startsWith('firstTurn.'));
    expect(docs).toHaveLength(3);
    for (const d of docs) expect(d.path.startsWith(ftDir)).toBe(true);
  });

});

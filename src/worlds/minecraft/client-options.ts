/**
 * Minecraft 启动前写入客户端所需的设置。
 *
 * 这些键没有命令行开关且只在启动时读取:
 *  - `pauseOnLostFocus` 禁止失焦后打开暂停菜单;
 *  - `onboardAccessibility` 跳过首次启动引导;
 *  - `soundCategory_master` 保证直播游戏音频非静音;
 *  - `chatVisibility` 保证人打得开聊天框(见 applyChatVisible);
 *  - SpectatorPlus 的 `openScreens` 关掉同步屏幕(见 applySpectatorPlusConfig)。
 *
 * 一个游戏目录只有一份 options.txt,游戏退出时还会按内存里的值整份重写:两份客户端
 * 共用一个目录就共用一套设置,谁最后启动谁说了算。要各自成套只能各给一个 gameDir。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from '../../core/types.ts';

/**
 * 合并 options.txt 时保留行序与未覆盖键,缺失键追加到末尾。
 * 值允许包含冒号,解析时只分割第一个冒号。
 */
export function mergeOptions(prev: string, overrides: Record<string, string>): string {
  const remaining = new Map(Object.entries(overrides));
  const lines = prev.split(/\r?\n/).map((line) => {
    const at = line.indexOf(':');
    if (at <= 0) return line;
    const key = line.slice(0, at);
    if (!remaining.has(key)) return line;
    const value = remaining.get(key)!;
    remaining.delete(key);
    return `${key}:${value}`;
  });
  // 末尾空行(文件通常以换行结尾)之前补齐缺的键
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of remaining) lines.push(`${key}:${value}`);
  return `${lines.join('\n')}\n`;
}

/** 写回 <gameDir>/options.txt;文件不存在就只写给出的这几行(其余由游戏补默认值) */
function writeOptions(gameDir: string, overrides: Record<string, string>, note: string, log: Logger): void {
  const file = join(gameDir, 'options.txt');
  try {
    const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const next = mergeOptions(prev, overrides);
    if (next === prev) return;
    writeFileSync(file, next, 'utf8');
    log.info(`已调整 ${file}:${note}`);
  } catch (err) {
    log.warn(`options.txt 调整失败(不影响启动): ${(err as Error).message}`);
  }
}

/** 无人值守的观察者摄像机要按住的那几项。 */
export function applyLaunchOptions(gameDir: string, log: Logger): void {
  writeOptions(
    gameDir,
    { pauseOnLostFocus: 'false', onboardAccessibility: 'false', soundCategory_master: '1.0' },
    '失焦不弹暂停菜单,跳过首启引导屏,主音量拉满',
    log,
  );
}

/**
 * 把 `chatVisibility` 掰回 FULL。HIDDEN(值 2)不只是不显示聊天:客户端连聊天框
 * 与命令行都打不开,人进了服 T 和 / 都按不动。摄像机为了画面干净关掉聊天是舞台
 * 设置,与人共用一个游戏目录时那份设置就落到人头上,所以每次启动都写一遍。
 */
export function applyChatVisible(gameDir: string, log: Logger): void {
  writeOptions(gameDir, { chatVisibility: '0' }, '聊天框与命令行可用', log);
}

/**
 * SpectatorPlus 客户端配置里必须按住的键。
 *
 * `openScreens`(World 里叫 Open Synced Screens)把被附身者当下打开的界面同步到
 * 摄像机屏幕上——bot 开箱子/合成/装炉,直播画面上就真开出那张 GUI。这正是容器
 * 操作的演出通路(配上 show 节拍才像人;瞬时操作只会闪一下)。开关由
 * `client.syncGui` 决定,必须每次启动都写:World 退出时会整份重写这个文件。
 */
export function mergeSpectatorPlusConfig(prev: string, overrides: Record<string, boolean>): string {
  let obj: Record<string, unknown> = {};
  if (prev.trim()) {
    const parsed: unknown = JSON.parse(prev);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      obj = parsed as Record<string, unknown>;
    }
  }
  for (const [k, v] of Object.entries(overrides)) obj[k] = v;
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/**
 * 写回 <gameDir>/config/spectatorplus/client.json。与 options.txt 同一个道理:
 * World 只在启动时读一次,退出时还会整份重写,所以必须赶在进程起来之前写。
 * 文件不存在就只写这一个键,其余由 World 补默认值。
 */
export function applySpectatorPlusConfig(gameDir: string, log: Logger, openScreens: boolean): void {
  const file = join(gameDir, 'config', 'spectatorplus', 'client.json');
  try {
    const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const next = mergeSpectatorPlusConfig(prev, { openScreens });
    if (next === prev) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, next, 'utf8');
    log.info(`已调整 ${file}:${openScreens
      ? 'bot 开箱子/合成/熔炉时把界面同步到摄像机画面上(GUI 演出)'
      : 'bot 开箱子/熔炉时不把界面同步到摄像机画面上'}`);
  } catch (err) {
    log.warn(`SpectatorPlus 配置调整失败(不影响启动): ${(err as Error).message}`);
  }
}

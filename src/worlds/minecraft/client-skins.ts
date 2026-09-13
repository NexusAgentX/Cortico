/**
 * 皮肤:离线服务器的玩家档案里没有材质,皮肤只能在客户端一侧解决。
 *
 * CustomSkinLoader(客户端 mod,服务端不装)按被渲染玩家的**账号名**去
 * `<gameDir>/CustomSkinLoader/LocalSkin/skins/<账号名>.png` 读图,与服务器、
 * Mojang 都无关。于是"给她和玩家各选一张皮肤"落到文件上就是:把选中的 PNG
 * 按账号名铺进每一份客户端的游戏目录。铺进摄像机那份决定直播画面里她长什么样,
 * 铺进玩家那份决定人自己看到的——两份客户端各渲染各的,所以两个名字的皮肤在
 * 两份目录里都要有。
 *
 * 选皮肤走文件选择器,选中的字节由 World 在这份部署的 `data/` 里按角色名留底。
 * 留底用于重铺:游戏目录或账号名可能在两次启动之间改变,而那时选图的人不在。
 * 它属这份部署,不属那几份游戏目录——换一台机器重装客户端,皮肤跟着部署走。
 *
 * 皮肤是 classic 还是 slim 不在这里判:配置项写 `model: "auto"`,CustomSkinLoader
 * 逐张按材质自己认。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from '../../core/types.ts';

/** 皮肤按账号名读取,两份客户端各渲染各的,所以两个角色在两份目录里都要铺 */
export type SkinRole = 'bot' | 'player';

/** 一个角色当下选着的那张皮肤 */
export interface SkinInfo {
  /** 材质尺寸;64x64 是现行格式,64x32 是 1.8 之前的老皮肤(没有第二层与左臂左腿) */
  width: number;
  height: number;
  bytes: number;
  /** 选中的时刻(ISO) */
  at: string;
}

/** CustomSkinLoader 在游戏目录下的自留地 */
const CSL_DIR = 'CustomSkinLoader';
const CSL_CONFIG = 'CustomSkinLoader.json';
const LOCAL_SKIN_PATTERN = 'LocalSkin/skins/{USERNAME}.png';

/** 本地皮肤那条 loader 的完整声明;`Legacy` 是 CustomSkinLoader 里"按 URL 模板取图"的那类 */
const LOCAL_SKIN_ENTRY = {
  name: 'LocalSkin',
  type: 'Legacy',
  checkPNG: false,
  skin: LOCAL_SKIN_PATTERN,
  model: 'auto',
  cape: 'LocalSkin/capes/{USERNAME}.png',
  elytra: 'LocalSkin/elytras/{USERNAME}.png',
};

/**
 * PNG 头解出宽高;不是 PNG 或截断了给 null。
 * 皮肤材质的尺寸是判据(64x64 / 64x32),而这两个数就写在 IHDR 的头 8 字节里。
 */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  for (let i = 0; i < SIG.length; i++) if (bytes[i] !== SIG[i]) return null;
  const u32 = (at: number): number =>
    ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  return { width: u32(16), height: u32(20) };
}

/** 能不能当皮肤用:PNG,且是 64x64(现行)或 64x32(1.8 之前) */
export function checkSkinBytes(bytes: Uint8Array): { width: number; height: number } | { error: string } {
  const size = pngSize(bytes);
  if (!size) return { error: '不是 PNG 图片' };
  const { width, height } = size;
  const ok = width === 64 && (height === 64 || height === 32);
  if (!ok) return { error: `皮肤材质得是 64x64(或 1.8 之前的 64x32),这张是 ${width}x${height}` };
  return size;
}

/** World 给某个角色留的那份底;与同目录的 `minecraft-*.json` 几本账同一套命名 */
function storedSkinPath(storeDir: string, role: SkinRole): string {
  return join(storeDir, `minecraft-skin-${role}.png`);
}

export function readStoredSkin(storeDir: string, role: SkinRole): Buffer | null {
  if (!storeDir) return null;
  const path = storedSkinPath(storeDir, role);
  return existsSync(path) ? readFileSync(path) : null;
}

export function storedSkinInfo(storeDir: string, role: SkinRole): SkinInfo | null {
  const bytes = readStoredSkin(storeDir, role);
  if (!bytes) return null;
  const size = pngSize(bytes);
  if (!size) return null;
  const stat = statSync(storedSkinPath(storeDir, role));
  return { ...size, bytes: bytes.length, at: stat.mtime.toISOString() };
}

/** 收下选中的那张;尺寸不合格就报错,不落盘 */
export function setStoredSkin(storeDir: string, role: SkinRole, bytes: Uint8Array): SkinInfo | { error: string } {
  if (!storeDir) return { error: '没有留底的地方:这份部署没有 data/ 目录' };
  const checked = checkSkinBytes(bytes);
  if ('error' in checked) return checked;
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(storedSkinPath(storeDir, role), bytes);
  return { ...checked, bytes: bytes.length, at: new Date().toISOString() };
}

/** 撤下留底,并把刚撤下的字节交回去——调用方拿它认出各游戏目录里哪份是本 World 铺的 */
export function clearStoredSkin(storeDir: string, role: SkinRole): Buffer | null {
  const prev = readStoredSkin(storeDir, role);
  if (prev) rmSync(storedSkinPath(storeDir, role));
  return prev;
}

/**
 * 合并 `CustomSkinLoader.json`:保证本地皮肤那条 loader 在,且排在最前。
 *
 * 排最前是必需的:默认清单里 Mojang 那几条在前,而离线账号的名字在正版那边
 * 可能真有主,轮不到本地文件就已经取到别人的皮肤了(取不到也要先等一次网络)。
 * 其余条目原样保留——这份文件也可能是人自己配过的。
 */
export function mergeSkinLoaderConfig(prev: string): string {
  let obj: Record<string, unknown> = {};
  if (prev.trim()) {
    const parsed: unknown = JSON.parse(prev);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
  }
  const list = Array.isArray(obj.loadlist) ? [...(obj.loadlist as unknown[])] : [];
  const isLocal = (item: unknown): boolean => {
    if (!item || typeof item !== 'object') return false;
    const skin = (item as Record<string, unknown>).skin;
    return typeof skin === 'string' && skin === LOCAL_SKIN_PATTERN;
  };
  const found = list.find(isLocal);
  const rest = list.filter((item) => !isLocal(item));
  obj.loadlist = [found ?? LOCAL_SKIN_ENTRY, ...rest];
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/** mod 装了没:装不了 mod 的游戏目录里,皮肤文件铺得再对也不会被读 */
export function hasSkinMod(gameDir: string): boolean {
  const mods = join(gameDir, 'mods');
  if (!gameDir || !existsSync(mods)) return false;
  return readdirSync(mods).some((f) => /^customskinloader.*\.jar$/i.test(f));
}

/** 某个账号的皮肤在这份游戏目录里落在哪 */
export function installedSkinPath(gameDir: string, username: string): string {
  return join(gameDir, CSL_DIR, 'LocalSkin', 'skins', `${username}.png`);
}

/** 该账号当下铺着的就是这份字节 */
export function installedMatches(gameDir: string, username: string, bytes: Buffer | null): boolean {
  if (!gameDir || !username || !bytes) return false;
  const path = installedSkinPath(gameDir, username);
  return existsSync(path) && readFileSync(path).equals(bytes);
}

/**
 * 把选中的皮肤铺进一份游戏目录:按账号名放 PNG,并保证 loader 配置里有本地那条。
 *
 * 每次启动客户端之前都跑一遍(与 options.txt 同一个道理:游戏只在启动时读,
 * 而游戏目录、账号名都可能在两次启动之间改过)。没选皮肤的角色不在名单里,
 * 于是那份游戏目录里也不会平白多出 CustomSkinLoader 的配置。
 */
export function applySkins(
  gameDir: string,
  entries: Array<{ username: string; bytes: Buffer }>,
  log: Logger,
): void {
  const wanted = entries.filter((e) => e.username && e.bytes.length > 0);
  if (!gameDir || wanted.length === 0) return;
  const done: string[] = [];
  try {
    for (const { username, bytes } of wanted) {
      const dst = installedSkinPath(gameDir, username);
      if (existsSync(dst) && readFileSync(dst).equals(bytes)) continue;
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, bytes);
      done.push(username);
    }
    const configFile = join(gameDir, CSL_DIR, CSL_CONFIG);
    const prev = existsSync(configFile) ? readFileSync(configFile, 'utf8') : '';
    const next = mergeSkinLoaderConfig(prev);
    if (next !== prev) {
      mkdirSync(join(gameDir, CSL_DIR), { recursive: true });
      writeFileSync(configFile, next, 'utf8');
    }
    if (done.length > 0) log.info(`已铺皮肤到 ${gameDir}:${done.join('、')}`);
    if (!hasSkinMod(gameDir)) {
      log.warn(`${join(gameDir, 'mods')} 里没有 CustomSkinLoader,皮肤铺了也不会被读`);
    }
  } catch (err) {
    log.warn(`皮肤铺设失败(不影响启动): ${(err as Error).message}`);
  }
}

/**
 * 撤走某个账号已铺的皮肤,但只撤内容与 `expect` 一致的那份——认不回来的是人自己
 * 放进去的文件,不动它。
 */
export function removeInstalledSkin(gameDir: string, username: string, expect: Buffer | null): boolean {
  if (!installedMatches(gameDir, username, expect)) return false;
  rmSync(installedSkinPath(gameDir, username));
  return true;
}

/**
 * `save_blob` 工具 —— 她把看见过的一份二进制留进自己记忆的那只手。
 *
 * 字节住在哪、句柄长什么样归记忆层(`memory.ts` 的 `WorkspaceBlobStore`);
 * 这里只有工具定义:schema、准入、回执措辞。
 */
import type { BlobStore, CoreApi, ToolDef } from 'cortico/core/types.ts';

/**
 * `save_blob(handle, path)`:把她看见过的一份二进制(`log:` 句柄)存进自己的记忆,回 `mem:` 句柄。
 * 哪些值得留是她的判断;工具只搬字节。回执以 `[saved]` 起头,变体据此决定要不要提交版本。
 */
export function saveBlobTool(deps: {
  blobs: BlobStore;
  core: () => CoreApi | null;
  /** 写准入(同Persona的 writeGuard):返回理由就拒绝 */
  guard?: (path: string, role: string) => string | null;
}): ToolDef {
  return {
    name: 'save_blob',
    description: 'Keep a binary you have seen (a log: handle from a [blob ...] line) in your workspace. '
      + 'Give the path to store it under (blobs/ is where such files live, e.g. blobs/stickers/cat.jpg); '
      + 'the receipt returns a mem: handle you can hand to tools later and note down. '
      + 'Log attachments can be cleared; what you save here stays with your memory.',
    tags: ['write'],
    parameters: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'The log: handle (a unique prefix of 8+ hex digits is enough).' },
        path: { type: 'string', description: 'Where to keep it, relative to your workspace, with an extension.' },
      },
      required: ['handle', 'path'],
    },
    handler: async (args, ctx) => {
      const handle = String(args.handle ?? '').trim();
      const path = String(args.path ?? '').trim();
      if (!handle) return '[save failed] handle 不能为空';
      if (!path) return '[save failed] path 不能为空';
      const denied = deps.guard?.(path, ctx.role) ?? null;
      if (denied) return `[save failed] ${denied}`;
      const core = deps.core();
      const got = core?.blob(handle) ?? null;
      if (!got) return `[save failed] 没有 ${handle} 这份二进制;句柄来自你看到过的 [blob ...] 行`;
      try {
        const saved = deps.blobs.put(path, got.bytes, got.mime);
        return `[saved] ${saved} ${got.mime} ${got.bytes.byteLength} 字节`;
      } catch (e) {
        return `[save failed] ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
}

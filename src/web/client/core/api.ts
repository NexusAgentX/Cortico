/**
 * Typed API Client —— 浏览器端与服务端之间的**唯一**网络出口。
 *
 * 控制台内核与所有页扩展的每一次 HTTP 都必须经过这里。扩展**不该自己
 * `fetch`**：自有数据走 `ctx.invoke`，路径选择与配置写回走 `ctx.pickPath` /
 * `ctx.setConfig`。绕开这些入口会让路由拼法、错误形状、取消语义各写各的，
 * `ConsolePanelContext.signal` 的生命周期保证也随之作废（挂起的请求不会随
 * unmount 停下）。扩展要的能力由 `ctx.invoke / invokeBinary` 提供，
 * 那两样就是本文件的薄封装。
 *
 * 两条约定钉在这里，别的地方不必再重复：
 *
 * 1. **错误归一化。** 服务端的错误一律是 `{ error: string }`（见 `server.ts`）。
 *    非 2xx 时取 `error` 当消息，取不到就退回 `HTTP <status>`；JSON 解析失败也
 *    带上响应片段。统统抛 `ConsoleInvokeError`，调用方只需 catch 一种错。
 * 2. **abort 是例外，原样抛。** `signal` 触发的中止抛原生的
 *    `DOMException/AbortError`，**不**包成 `ConsoleInvokeError`——调用方靠它区分
 *    "面板卸载了，请求被取消"和"请求真失败了，该显示错误卡"。包了就分不出来，
 *    于是每次切换面板都会闪一张假错误。
 *
 * 路径一律由 `panelRoute()` 拼（page id 含冒号，必须 encodeURIComponent），
 * 本文件不手写路由字符串。
 */

import {
  CONSOLE_MANIFEST_ROUTE,
  panelRoute,
  type ConsoleManifest,
} from '../../shared/console-protocol.ts';
import { ConsoleInvokeError } from '../../shared/client-panel.ts';
import type { ConfigValue } from '../../../core/config-schema.ts';
import {
  PATH_PICKER_ROUTE,
  type PathPickerOptions,
  type PathPickerResponse,
} from '../../shared/path-picker.ts';
import { pick } from './language.ts';

const zh = {
  httpStatus: (status: number, snippet: string) => `HTTP ${status}：${snippet}`,
  notJson: (status: number, snippet: string) => `响应不是合法 JSON（HTTP ${status}）：${snippet}`,
};
const en: typeof zh = {
  httpStatus: (status: number, snippet: string) => `HTTP ${status}: ${snippet}`,
  notJson: (status: number, snippet: string) => `Response is not valid JSON (HTTP ${status}): ${snippet}`,
};
const S = pick({ zh, en });

/** 所有请求都接受一个取消信号；面板一律传 `ctx.signal`。 */
export interface RequestOptions {
  signal?: AbortSignal;
  keepalive?: boolean;
}

/** 错误消息里附带的响应片段长度。够定位，又不至于把整页 HTML 灌进 toast。 */
const SNIPPET_MAX = 200;

function snippet(text: string): string {
  const s = text.trim();
  return s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX)}…` : s;
}

/**
 * 是不是 abort。用 `name` 判而不是 `instanceof DOMException`：Node 与浏览器给的
 * 构造器不是同一个，跨 realm 的 `instanceof` 也不可靠，而 `AbortError` 这个名字
 * 是规范定死的。
 */
function isAbortError(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

/** 把任意异常收敛成 `ConsoleInvokeError`；abort 与已经归一化过的原样放行。 */
function normalizeError(err: unknown, status: number): never {
  if (isAbortError(err)) throw err;
  if (err instanceof ConsoleInvokeError) throw err;
  throw new ConsoleInvokeError(String(err), status);
}

async function send(path: string, init: RequestInit, opts?: RequestOptions): Promise<Response> {
  try {
    return await fetch(path, {
      ...init,
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(opts?.keepalive ? { keepalive: true } : {}),
    });
  } catch (err) {
    // fetch reject = 网络层没走到 HTTP，没有状态码可言，记 0。
    normalizeError(err, 0);
  }
}

/** 读响应体文本；abort 会在这一步而不是 fetch 那一步抛出，所以同样要放行。 */
async function readText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    normalizeError(err, res.status);
  }
}

/** 非 2xx 的统一出口：优先服务端措辞，其次 `HTTP <status>`（带响应片段）。 */
async function throwHttpError(res: Response): Promise<never> {
  const text = await readText(res);
  let message = `HTTP ${res.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: unknown } | null;
    const err = parsed?.error;
    if (typeof err === 'string' && err !== '') message = err;
  } catch {
    // 不是 JSON（网关的 HTML 错误页、代理的纯文本）：把片段带上，否则只剩一个
    // 光秃秃的状态码，排查时无从下手。
    if (text.trim() !== '') message = S.httpStatus(res.status, snippet(text));
  }
  throw new ConsoleInvokeError(message, res.status);
}

/**
 * 2xx 的响应体 → JSON。
 *
 * 204 与空 body 返回 `null`（不是所有接口都有返回值），别让 `JSON.parse('')` 炸；
 * 真的解析不动则归一化成 `ConsoleInvokeError`，消息里带响应片段。
 */
async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) await throwHttpError(res);
  if (res.status === 204) return null as T;
  const text = await readText(res);
  if (text.trim() === '') return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ConsoleInvokeError(S.notJson(res.status, snippet(text)), res.status);
  }
}

async function readBlob(res: Response): Promise<Blob> {
  if (!res.ok) await throwHttpError(res);
  try {
    return await res.blob();
  } catch (err) {
    normalizeError(err, res.status);
  }
}

// ---------------------------------------------------------------------------
// 通用动词
// ---------------------------------------------------------------------------

export async function get<T>(path: string, opts?: RequestOptions): Promise<T> {
  return readJson<T>(await send(path, { method: 'GET' }, opts));
}

/**
 * `post` 只负责序列化传进来的 body —— `{ args }` 这个形状是 panel RPC 的约定，
 * 由 `invokePanel` 负责，不在这里硬编码。
 */
export async function post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  };
  return readJson<T>(await send(path, init, opts));
}

/** 二进制写入。头像裁剪这类浏览器已生成的文件不再绕成体积更大的 base64 JSON。 */
export async function postBlob<T>(
  path: string,
  body: Blob,
  opts?: RequestOptions,
): Promise<T> {
  return readJson<T>(await send(path, {
    method: 'POST',
    headers: { 'Content-Type': body.type || 'application/octet-stream' },
    body,
  }, opts));
}

/** 打开运行 WebApp 的主机上的本机路径选择器。 */
export async function pickPath(options: PathPickerOptions, opts?: RequestOptions): Promise<string | null> {
  const response = await post<PathPickerResponse>(PATH_PICKER_ROUTE, options, opts);
  return response.path;
}

/** 控制台页面板写配置的窄入口；服务端仍按组 schema 校验。 */
export async function setConfig(
  groupId: string,
  values: Record<string, ConfigValue>,
  opts?: RequestOptions,
): Promise<string> {
  const response = await post<{ result?: string }>('/api/config', { group: groupId, values }, opts);
  return response.result || groupId;
}

// ---------------------------------------------------------------------------
// Console 协议
// ---------------------------------------------------------------------------

export async function fetchManifest(opts?: RequestOptions): Promise<ConsoleManifest> {
  return get<ConsoleManifest>(CONSOLE_MANIFEST_ROUTE, opts);
}

/** 面板数据面调用。走 POST，body 形如 `{"args":[...]}`。 */
export async function invokePanel<T>(
  pageId: string,
  panelId: string,
  method: string,
  args?: unknown[],
  opts?: RequestOptions,
): Promise<T> {
  return post<T>(panelRoute(pageId, panelId, method), { args: args ?? [] }, opts);
}

/** 同上，但按二进制取回（音频试听、图片这类）。 */
export async function invokePanelBinary(
  pageId: string,
  panelId: string,
  method: string,
  args?: unknown[],
  opts?: RequestOptions,
): Promise<Blob> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args: args ?? [] }),
  };
  return readBlob(await send(panelRoute(pageId, panelId, method), init, opts));
}

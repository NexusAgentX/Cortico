import type { NativeChatMessage } from './native-types.ts';
import type { ToolSchema } from '../../core/types.ts';
export function dropPastThinking(messages: NativeChatMessage[]): NativeChatMessage[] {
  return messages.map((m) =>
    m.role === 'assistant' && m.reasoning_content && !m.firstTurn
      ? { ...m, reasoning_content: '' }
      : m,
  );
}

/** 线上不带 blobs 字段:句柄是 core 内部形态,分片渲染(若有)另行处理。 */
export function dropBlobsField(m: NativeChatMessage): NativeChatMessage {
  if (m.blobs === undefined) return m;
  const { blobs: _drop, ...rest } = m;
  return rest as NativeChatMessage;
}

export function dropFirstTurnMark(m: NativeChatMessage): NativeChatMessage {
  return { role: m.role, content: m.content,
    ...(m.reasoning_content !== undefined ? { reasoning_content: m.reasoning_content } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}), ...(m.parts ? { parts: m.parts } : {}) };
}

export interface CompatMediaOptions {
  enabled: () => boolean;
  read: (ref: string) => Buffer | null;
}

/** OpenAI function 格式的 tools 段(各 chat 方言共用)。 */
export function mapTools(tools?: ToolSchema[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * 把消息渲染成 OpenAI 兼容线上形态:剥掉内部 blobs 字段;reasoning_content 按方言取舍——
 * compat 剥掉(llama.cpp 不认识该字段),`keepReasoning` 的方言保留非空的(空值按
 * Option 语义省略字段,让无推理消息的渲染字节与剥除版逐字相同)。
 * media.enabled() 为真时,带附件的消息升格成 `[text, image_url...]` content
 * 分片(data URL);读不到字节的句柄静默跳过——content 里本来就有每份附件的文本形态。
 * 各 chat 方言共用这套消息渲染。
 */
export function renderMessagesWithMedia(
  messages: NativeChatMessage[],
  media?: CompatMediaOptions,
  opts?: { keepReasoning?: boolean },
): Array<Record<string, unknown>> {
  const renderMedia = media?.enabled() === true ? media : undefined;
  return messages.map((m) => {
    const refs = m.blobs;
    const { reasoning_content: _r, parts: _parts, ...rest } = dropFirstTurnMark(m);
    const base = { ...rest, content: m.parts ?? m.content } as Record<string, unknown>;
    if (opts?.keepReasoning && m.reasoning_content) base.reasoning_content = m.reasoning_content;
    if (!renderMedia || !refs?.length) return base;
    const parts: Array<Record<string, unknown>> = m.parts ? [...m.parts] : [{ type: 'text', text: m.content }];
    let attached = false;
    for (const r of refs) {
      const bytes = renderMedia.read(r.handle);
      if (!bytes) continue;
      attached = true;
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${r.mime};base64,${bytes.toString('base64')}` },
      });
    }
    return attached ? { ...base, content: parts } : base;
  });
}

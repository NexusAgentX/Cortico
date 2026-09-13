import type { ChatMessage } from './fixture-types.ts';
import type { LLMUsage } from '../../src/core/types.ts';
import { LLMError as TransportError } from '../../src/providers/transport/errors.ts';
export class LLMError extends TransportError { usage?: LLMUsage; failedAfterMs?: number; requestId?: string; }
export class LLMStreamAborted extends LLMError {
  /** 断流前已组装的部分消息(content/reasoning/已收到的tool_calls) */
  partial: ChatMessage;
  /** 这一发花掉的 token 走继承来的 `usage`(见 LLMError):失败流同样入账。 */
  constructor(message: string, status: number, body: string, partial: ChatMessage) {
    super(message, status, body);
    this.name = 'LLMStreamAborted';
    this.partial = partial;
  }
}

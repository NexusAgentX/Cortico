/** Native Responses over any OpenAI-compatible endpoint: bearer key, stateless replay, no vendor branching. */
import { isContextOverflow } from '../transport/errors.ts';
import type { Logger } from '../../core/types.ts';
import { nullLogger } from '../../core/util.ts';
import { createHash } from 'node:crypto';
import { BaseProvider } from '../base.ts';
import { generate } from '../transport/response-http.ts';
import { ResponseProtocolError } from '../../protocol/open-responses/stream.ts';
import { createResponse, type Request } from '../../protocol/open-responses/index.ts';
import { standardUsage, type GenerateOptions, type Generation } from '../../core/generation.ts';
import { NativeResponseAssembly, type ParsedResponse } from '../transport/response-assembly.ts';
import { responseMeters } from '../transport/response-meters.ts';
import { responsesInput, type ResponsesInputOptions } from '../transport/responses-input.ts';

type Item = Record<string, unknown>;

export interface ResponsesProviderOptions {
  baseUrl: string;
  apiKey?: string;
  /** Path appended to `baseUrl`; default `/responses`. */
  endpointPath?: string;
  extraHeaders?: Record<string, string>;
  /** Merged into every request body last, so vendor-specific fields (`service_tier`, ...) win. */
  extraBody?: Record<string, unknown>;
  media?: ResponsesInputOptions['media'];
  keepThinking?: () => boolean;
  log?: Logger;
}

/**
 * Send reasoning only when an effort is supplied; otherwise leave it to the endpoint.
 * Requests set store=false and request encrypted reasoning content for local stateless replay.
 * Endpoint extraBody fields are merged last.
 */
export function buildResponsesBody(
  request: Request,
  options: GenerateOptions,
  input: ResponsesInputOptions,
  extraBody: Record<string, unknown> = {},
): Record<string, unknown> {
  const replay = responsesInput(request, options, input);
  const body: Item = {
    ...request,
    input: replay.input,
    include: [...new Set([...(request.include ?? []), 'reasoning.encrypted_content'])],
    store: false,
    stream: Boolean(options.onEvent),
  };
  delete body.previous_response_id;
  if (replay.instructions !== undefined) body.instructions = replay.instructions;
  else delete body.instructions;
  if (!request.reasoning?.effort) delete body.reasoning;
  if (options.sessionId) body.prompt_cache_key = options.sessionId;
  return { ...body, ...extraBody };
}

export class ResponsesProvider extends BaseProvider {
  contextOverflow = isContextOverflow;
  accepts(mime: string): boolean { return this.opts.media?.enabled() === true && mime.startsWith('image/'); }
  private readonly opts: ResponsesProviderOptions;

  constructor(opts: ResponsesProviderOptions) {
    super();
    const url = new URL(opts.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('baseUrl must use HTTP or HTTPS');
    if (opts.endpointPath !== undefined && !opts.endpointPath.startsWith('/')) throw new Error('endpointPath must start with /');
    this.opts = { ...opts, baseUrl: opts.baseUrl.replace(/\/+$/, ''),
      extraHeaders: { ...opts.extraHeaders }, extraBody: structuredClone(opts.extraBody ?? {}) };
  }

  async respond(request: Request, options: GenerateOptions = {}): Promise<Generation> {
    const endpoint = `${this.opts.baseUrl}${this.opts.endpointPath ?? '/responses'}`;
    const domain = createHash('sha256').update(JSON.stringify([endpoint, this.headers()])).digest('hex');
    const origin = { instance: domain, module: 'openai-responses-compat', model: request.model ?? '', compatibilityDomain: domain };
    const opts = { ...options, origin };
    const log = this.opts.log ?? nullLogger();
    return generate(request, opts, origin, {
      url: endpoint,
      body: buildResponsesBody(request, opts, { media: this.opts.media, keepThinking: this.opts.keepThinking }, this.opts.extraBody),
      headers: () => this.headers(),
      assembly: () => new NativeResponseAssembly(),
      parse: raw => this.parseResponse(raw, request),
      log,
    });
  }

  protected headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...this.opts.extraHeaders };
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;
    return headers;
  }

  private parseResponse(raw: unknown, request: Request): ParsedResponse {
    const data = raw as Item;
    if (typeof data.id !== 'string' || typeof data.model !== 'string' || !Array.isArray(data.output)
      || !['completed', 'incomplete', 'failed'].includes(String(data.status))) throw new ResponseProtocolError('Invalid native Responses resource');
    const meters = responseMeters(data.usage as Record<string, unknown> | null);
    return {
      response: { ...createResponse(data.id, request), ...data, usage: standardUsage(meters) },
      meters,
      serviceTier: typeof data.service_tier === 'string' ? data.service_tier : null,
    };
  }
}

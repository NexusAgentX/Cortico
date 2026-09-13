import type {
  LLMProviderEntry,
  Logger,
  ReasoningTier,
  ServiceTier,
  ModelSpec,
  ConfigGroup,
} from '../core/types.ts';
import type { ConsolePageContribution } from '../web/shared/console-protocol.ts';
import type { Language } from '../core/language.ts';
import type { ProviderConsoleHost } from './console/types.ts';
import type { PriceDefinition, QuoteTime } from './pricebook.ts';
import type { Request } from '../protocol/open-responses/index.ts';
import type { ContextRecord } from '../protocol/open-responses/context.ts';
import type { GenerateOptions, Generation, GenerationError, ResponseClient } from '../core/generation.ts';

/** Providers expose standard Responses and own their native transport semantics. */
export abstract class BaseProvider implements ResponseClient {
  abstract respond(request: Request, options?: GenerateOptions): Promise<Generation>;
}

export interface ProviderHost {
  /**
   * 这个端点自己的部署数据目录(`<部署根>/providers/<端点名>/`)。
   * **内部结构解释权全归 provider 包**:token、缓存、模块自己的状态想怎么放就怎么放,
   * 框架只保证这一个目录是它的。目录按端点名分家,所以同一个 kind 的两个端点互不串味;
   * 反过来,同一个端点被几份部署共用时它们共享这里——OAuth 端点因此只要授权一次。
   */
  stateDir: string;
  repoRoot?: string;
  resource?<T>(key: string, create: () => T): T;
  currentEntry?(): LLMProviderEntry;
  /** 按名字取密钥:进程环境 > 这个端点的 `.env`。 */
  secret(name: string): string;
  /** 按句柄取回附件字节(渲染层把附件升格成内容分片时用);读不到 → null */
  readBlob(handle: string): Buffer | null;
  keepThinking(): boolean;
  log: Logger;
}

/**
 * 框架交给 `ProviderRegistry` 的那一份 host。按端点名分岔的两样(`stateDir` 与只读那个目录的
 * `secret`)由 registry 自己填——它才知道这次解析的是哪个端点。
 */
export type ProviderHostBase = Omit<ProviderHost, 'stateDir' | 'secret' | 'currentEntry' | 'resource'> & {
  /** 全局端点表的根;每个端点在它下面有自己一格。 */
  stateRoot: string;
};

export interface ProviderInstance {
  client: BaseProvider;
  /** Model ids the endpoint advertises (`GET /models`), with the context window when the catalog states one. */
  listModels?(): Promise<Array<{ id: string; contextWindow?: number }>>;
  /** Module-owned control object; interpreted by that module's console contribution. */
  control?: unknown;
  compatibilityKey?(): unknown;
  start?(): Promise<unknown>;
  stop?(): Promise<unknown>;
  /**
   * Context window the upstream reports for this model, in tokens. How it is detected
   * belongs to the module (a model catalog, a server properties endpoint, a launch
   * parameter); `undefined` until known. The core takes the minimum of this and the
   * profile's hand-filled `contextWindow`.
   */
  contextWindow?(model: string): number | undefined;
}

export interface ProviderModule {
  id: string;
  title: string;
  defaultBaseUrl?: string;
  /** Candidate endpoint URLs offered on the URL field. Candidates only: any URL is accepted. */
  baseUrlSuggestions?: readonly string[];
  /** Empty = open: `reasoningEffort` accepts any non-empty string; `effortSuggestions` supplies the candidates. */
  reasoningTiers: readonly ReasoningTier[];
  effortSuggestions?: readonly string[];
  serviceTiers: readonly ServiceTier[];
  temperatureNote?: string;
  /**
   * Console copies of the tier tables and temperature note in the console language.
   * Absent (or a field left out) = the tables above are shown as written.
   */
  localize?(language: Language): {
    reasoningTiers?: readonly ReasoningTier[];
    serviceTiers?: readonly ServiceTier[];
    temperatureNote?: string;
  };
  normalize?(entry: LLMProviderEntry): LLMProviderEntry;
  /** `language` is the console language for the thrown message; validation itself is fixed. */
  validateEntry?(entry: LLMProviderEntry, language: Language): void;
  validateModel?(entry: LLMProviderEntry, spec: ModelSpec): void;
  accepts?(entry: LLMProviderEntry, spec: ModelSpec, mime: string): boolean;
  config?(name: string, entry: LLMProviderEntry, language: Language): ConfigGroup[];
  console?(host: ProviderConsoleHost): Partial<ConsolePageContribution>;
  prices?(entry: LLMProviderEntry, request: Request, at: QuoteTime): readonly PriceDefinition[];
  /**
   * Local token estimate for records the upstream has not counted yet. Absent = the
   * core's character-ratio estimate. Only estimates: the exact count of everything
   * already sent comes from the upstream usage report.
   */
  estimateTokens?(records: readonly ContextRecord[], spec: ModelSpec): number;
  /** The upstream rejected a request because its input exceeded the model's context. */
  contextOverflow?(error: GenerationError): boolean;
  create(name: string, entry: LLMProviderEntry, host: ProviderHost): ProviderInstance;
}

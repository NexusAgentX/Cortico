# Cortico 的设计原则

Cortico 是通用的事件驱动 Agent 核心，支持持续运行、混合输入和实时输入。
应用可以用它构建任务型 Agent、交互式助手或其他自主系统。

Core 管理 Session、事件调度、模型调用、工具派发、容量和错误隔离。
Persona 定义上下文、行为策略、Session 结构及 Memory 操作。
Memory 是由 Persona 解释的持久状态，具体介质和组织方式由应用决定。
World 是外部环境的事件和工具边界。Bot 将组件装配为一个运行实例。
Provider 负责模型通信。

## 技术原则

1. **面向模型能力的进步。** 不把当前模型的局限固化为系统边界。
   为模型局限提供的措施应标明为 fallback，并能随模型能力提升而移除。
2. **最小先验干预。** 语义选择交给 Persona 和模型。
   硬编码流程用于机械事务，以及错误判断会产生不可恢复后果的边界。
3. **可验证的事实。** 事件、回执和运行约束描述基础设施能够确认的事实。
   需要向模型解释其含义时，由 Persona 提供语义内容。
4. **职责分离。** Core 不依赖具体应用或平台，不解释 Memory 内容。
   World 不直接调用 Persona 的实现，也不修改 Memory；交互通过事件、工具与宿主契约完成。
5. **调用方拥有装配。** 配置、凭证、数据目录、外部服务和进程生命周期由宿主应用提供。

# Design principles

Cortico is a general-purpose event-driven Agent core for persistent, mixed and real-time input.
Core owns mechanical runtime behavior. Persona owns context and behavioral policy. Memory is
caller-owned persistent state. World is an external environment boundary. Bot assembles the
components; Provider communicates with the model.

Design for improving models, keep semantic priors minimal, report verifiable facts, preserve
component boundaries, and let the caller own configuration and lifecycle. Model-limit
workarounds are explicit fallbacks. Core does not prescribe an application's purpose or identity.

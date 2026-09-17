<!-- Owner: src/core/core.ts, src/bot.ts -->
# Cortico

Cortico 是通用的事件驱动 Agent 核心，使用 Node.js 22+ 和 TypeScript。
它负责持续 Session、事件调度、工具执行和上下文交接。
调用方提供 Persona、World、一个 Provider 客户端、模型配置和数据目录。

## 组成

- **Core**：调度、Session、工具循环、容量控制、定时器和恢复。
- **Persona**：上下文内容、Session 声明、交接策略和 Memory 操作。
- **World**：环境描述、事件、工具和可选的输出流接收器。
- **Provider**：模型调用接口；自带 `openai-responses-compat` 实现。
- **Bot**：上述组件的程序化装配。

Memory 由外部 Persona 实现。仓库不提供内建 Persona、World、Web 控制台、
扩展包管理、部署管理或模型服务启动器。

## 开发与接入

```sh
pnpm install
pnpm test
pnpm run typecheck
```

源码采用 ESM TypeScript，宿主项目可使用 `tsx` 等运行方式。
[最小示例](examples/minimal.ts) 展示如何实现 Persona 和 World，并通过 `createBot()` 装配。
[英文 README](README.md) 包含连接模型端点的调用示例。

`start()` 启动 World 和事件循环；示例中的 `send()` 归档并排队事件，不等待模型完成。
调用方决定何时调用 `stop()`，并处理其返回的失败清单。
多个 `stop()` 调用共用一次停止操作；停止后用相同数据目录创建新的 Core 来恢复。
同一数据目录同时只能有一个 Core 写入，独占关系由调用方保证。

运行时可调用 `core.mount(world)`、`core.unmount(id)` 更新环境前缀和工具表。
主 Session 合并 Persona 声明与已挂载 World 的工具；其他 Session 使用自己的工具声明。
一个 Core 的所有 Session 使用同一个 Provider 客户端。

文件持久化保留 Session、事件、Core 状态、定时器、附件和运行日志。
Token 统计保留在内存及模型响应中；不提供计费或独立用量、工具调用、上下文副本流水。

详见[运行契约](docs/runtime.md)、[模型通信](docs/providers.md)和[设计原则](PHILOSOPHY.md)。

## 许可

MIT。Open Responses 协议资源保留[Apache-2.0 许可](src/protocol/open-responses/LICENSE)。

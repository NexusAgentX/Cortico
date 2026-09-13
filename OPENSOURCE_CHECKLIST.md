Cortico 开源前的Checklist：


Phase 0: 清理一些早就该但是拖着的事情
 - vtuber 到 live2d 模型的支持中去掉可缇现在用的不完整实现，仅保留一个Type-H1作为范例实现 
 - [x] 加入一个文档说明如何支持新的live2d —— cortico-world-vtuber 包的 src/models/LIVE2D-ADAPTATION.md，产物只有模型目录里的 cortico.profile.json
 - 前端优化，配置页很多东西应该放在前面的页面方便调整。整体排版和呈现可以优化
 - 前端优化特别是 World 总览界面要优化一下，现在看不懂
 - [x] World 的声明、装配、动态扩展这些都要完善一下，现在我自己也没理清楚 —— src/world.ts 的 WorldDefinition + WorldContext + 挂载表三方共用一张表；动态扩展走 src/extensions.ts 的 manifest
 - [x] World 装载/卸载这类装配层的生命周期事件Persona应该监视并投递为内部事件，现在没做 —— src/core/types.ts 的 WorldLifecycleEvent，src/bot.ts 扇出到 Persona 的 onWorldLifecycle
 - terminal 优化，上下文窗口，占比等视觉优化。支持发图。显示头像。
 - terminal 还有个问题是bot的气泡在左边，应该左右对换一下
 - [x] web端应该有个单独的开发文档，并且每个 World 应该有一个单独的用来对接web端的子目录 —— docs/console.md + src/web/README.md；每个 World 的 console/ 子目录
 - Provider: 支持OpenAI Compatible，移除违反ToS的Oauth类实现，规定内部原语（目前和Claude不兼容，要兼容），做模块化
    OpenAI Compatible 与模块化已落地（src/providers/ 按 kind 分目录）；grok 的 OAuth 实现已外移成 cortico-provider-grok 扩展包，不在本仓库里，但并未移除；内部原语与 Claude 的兼容未做
 - [x] 支持i18n —— src/core/language.ts，语言取自部署 config.json 的 language 键
 - [x] 支持统一的分级日志系统 —— 一场一目录 data/runs/<run>/，级别可热改，pnpm logq 查询


Phase 1: 正式进入准备阶段
 - 复制一份新的整个项目
 - 清理、移除保留内容（版权素材等），顺便清查Git记录确保版权保留内容不泄露
 - 清理可能泄露的个人信息和token等
 
Phase 2: 重整和优化
 - [x] 清理所有过时的文档，重做基础的顶层文档（哲学+设计），重新锚定各个功能层级的标准命名 —— PHILOSOPHY / AGENTS §2 词表 / README / docs/；旧文档退役到 deprecated/
 - [x] 根据顶层文档迁移当前的代码的命名体系，顺便统一内部命名风格 —— rename A–F：Core / Persona / Memory / World / Extension；asr 出库成 cortico-world-asr
 - [x] 同类子功能之间同步实现和命名风格（比如pvz和minecraft的托管进程sidecar） —— 只对齐命名与风格:AGENTS §2 的约定;Module 残名→World、一个 World 一个前缀、config.ts 固定、四份引擎子进程同名协议与称谓、Opts/Ctx/Port 后缀、CORTICO_* 环境变量、kebab 文件名、`<id>_<动词>` 工具名;bots/ 下驼峰文件与 BotDefinition.build→create 留待

Phase 3：贡献体系，可扩展性验证和验收
 - [x] 完成CONTRIBUTING.md和AGENTS.md用来作为准入控制
 - 设置PR审核AI
 - Cortico Creator (TINA Spec): 用于创作Cortico Persona / Cortico World / Provider支持等的TINA App
 - 提一个一句话许愿的PR观察是否通过
 - 用Cortico Creator实现一个新的IM接口
 - 通过session队列实现基于传统prompt-response循环 + SQL类/关系图谱类数据库记忆的QQ bot 实现，代号CortiAlpha 

Phase 4: AI垃圾清理
 - 清理所有AI coding slop的痕迹，包括：
    - 所有AI垃圾文本风格的注释，以AGENTS.md的约束为准
    - 清理过度防御性编程，清理没有意义的Mock测试
    - 在 Core 和 Persona 要求的标准接口中，清理所有的临时补丁类代码

Phase 5: 最终核验和评审
 - 敲定最终发布形式、每个部分的license
 - [x] 写README.md
 - 邀请几个人审核一下代码库

Phase 6: 正式开源
 
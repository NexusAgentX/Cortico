# 运行时与模型文件

Owner: `src/paths.ts`, `src/providers/llamacpp/runtime-store.ts`, `src/providers/llamacpp/options.ts`

一个模块需要的外部二进制(llama-server 这类)与模型权重都是机器事实,放在部署根下、与各部署
平级的两个目录里,几份部署共用。内建的 `llamacpp` provider 是这套约定的参考实现;别的模块和
扩展照同一套摆。

## 目录

```
<部署根>/
  runtimes/<运行时 id>/<版本>/…     可执行运行时,一个版本一个目录,可并存
  models/<owner>/…                  模型文件;owner 是 provider id 或 World id
```

`llamacpp` 用它们的方式:`runtimes/llama.cpp/<release tag>/<平台-后端-架构>/` 是解压后的官方
压缩包,目录里有 `cortico-runtime.json` 才算装好;`models/llamacpp/cache/` 是 llama-server 的
`LLAMA_CACHE`(拉取的模型落在这里),`models/llamacpp/local/` 是 `--models-dir`,手放的 GGUF
放这里(多模态或分片放子目录,mmproj 文件名以 `mmproj` 开头,这是 llama.cpp 自己的目录约定)。

## 运行时的四条约定

1. **钉版本。** 模块代码里写死一个上游 build tag 与各平台的资产名;配置可改 tag。目录名带
   tag,换版本是另一个目录。
2. **模块自己下载。** 压缩包下到 `<目录>.partial/`、解压、写标记,最后整个目录改名到位;中断只留
   一个下次会被清掉的半成品目录。上游给校验和就校,不给只校压缩包完整。
3. **不代装系统依赖。** CUDA 版只搭配上游的 cudart 包;驱动版本、运行库、应用控制策略这类只在
   失败时用人话报出。
4. **自备目录优先。** 配置里给了运行时目录就不下载:自编译、Linux CUDA、签过名的构建走这里。

## 模型文件的两条约定

1. **能让运行时下载的,交给运行时。** llama-server 的 router 模式自己实现了 HuggingFace 拉取
   (`POST /models`)、进度(`GET /models` 里的 `status`)与取消;Cortico 只是这几个端点的皮。
2. **不能的,模块自己下,位置仍是 `models/<owner>/`。** 面板上给出来源链接与固定 revision。

## Windows 智能应用控制

llama.cpp 的官方 Windows 二进制没有签名。全新安装的 Windows 11 默认带着 Smart App Control,
强制态下未签名的 exe 和 dll 一律不许运行,`spawn` 拿到的错误码是 `UNKNOWN`。它没有按应用放行,
自签证书也无效。`llamacpp` 在下载前读注册表
`HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy\VerifiedAndReputablePolicyState`(0 关、1 强制、
2 评估),为 1 时面板直接说明:关掉它(设置 → 隐私和安全性 → Windows 安全中心 → 应用和浏览器
控制;25H2 起关了还能再开),或填一份自己签过名的自备运行时目录。

## 上游发布形状(b10930,2026-09)

每个 build 一个 tag,资产名 `llama-<tag>-bin-<os>-<后端>-<架构>.{zip,tar.gz}`:Windows 有
`cuda-13.3` / `cuda-12.4` / `vulkan` / `cpu`(x64)与 `cuda-13.4` / `cpu`(arm64),CUDA 版另配
`cudart-llama-bin-win-cuda-<版本>-<架构>.zip`;Ubuntu 有 `vulkan` / `rocm-10.0` / `cpu`,没有
CUDA;macOS 是 `macos-<架构>`。zip 是平铺的,tar.gz 套一层 `llama-<tag>/`。

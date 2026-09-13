# Windows

Owner: `bin/cortico.mjs`, `start.bat`, `src/launcher.ts`

参考 bot 在 Windows 11 上开发与运行;框架本身不依赖 Windows,下面是平台分支所在。

## 启动

双击 `start.bat`。它只做两件 Windows 专属的事:切 UTF-8 代码页、退出后 `pause` 别关窗;
其余全在 `bin/cortico.mjs` 里,与 Linux 同一份代码(菜单的 ↑↓ / Enter / Esc 也是)。
别直接关窗:关窗只给进程约 5 秒,来不及存盘,完整关机从控制台点。

## 平台分支

| 位置 | 行为 |
|---|---|
| `src/launcher.ts` | 开浏览器用 `cmd /c start`;多监听一个 SIGBREAK(Ctrl+Break) |
| `src/extensions.ts` | corepack 是 `.cmd` 垫片,装扩展时经 shell 起、参数逐个加引号 |
| `src/web/path-picker.ts` | 本机路径选择器用 PowerShell 起 WinForms 对话框;没有 PowerShell 时报不可用 |
| `src/worlds/minecraft/` | 硬信号集 SIGHUP / SIGBREAK,收到即 `save-all` + `stop`;窗口探测与改标题走 `client-window.ps1`;便携 JDK 找 `bin/java.exe` |

## 已知的坑

- 系统开着 Smart App Control 时未签名的 exe 起不来,`spawn` 报 `UNKNOWN` 而不是 `ENOENT`。
- Minecraft 客户端要 Java 21;JDK 25 让 LWJGL 认不出 JNI 版本,随机 `0xC0000005`。
- 装了厂商 ASIO 驱动的机器上 RtAudio 自选后端会选到 ASIO 并崩溃;声卡类扩展钉死 WASAPI。
- 在 `extensions/` 下跑 pnpm 必须带 `--ignore-workspace`,否则根 lockfile 会多出一个 importer。

import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 临时目录钉成长名。Windows 上 TEMP 常是 8.3 短名(GitHub runner 就是
 * `C:\Users\RUNNER~1\AppData\Local\Temp`),而 `pathToFileURL` 会把里面的 `~`
 * 转义成 `%7E`——真 Node 的 import 会解回来,vite 的模块运行器按字面去找文件,
 * 于是所有「往临时目录里装个假包再 import」的测试在这种机器上全灭。
 * `realpathSync.native` 是唯一会把短名展开成长名的那个(纯 JS 版不会)。
 */
const longTmp = realpathSync.native(tmpdir());

export default defineConfig({
  // 与根 tsconfig 的 paths 同形:仓内 bot 包以 `cortico/<src 下路径>` import 框架。
  resolve: {
    alias: [{ find: /^cortico\//, replacement: fileURLToPath(new URL('./src/', import.meta.url)) }],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // 控制台语言是按进程读一次的系统事实;测试断言中文文案,与跑测试的机器区域无关。
    env: { CORTICO_LANGUAGE: 'zh', TEMP: longTmp, TMP: longTmp, TMPDIR: longTmp },
    testTimeout: 20000,
    pool: 'forks',
    maxWorkers: 2,
    minWorkers: 1,
  },
});

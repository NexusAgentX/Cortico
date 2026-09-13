import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 与根 tsconfig 的 paths 同形:仓内 bot 包以 `cortico/<src 下路径>` import 框架。
  resolve: {
    alias: [{ find: /^cortico\//, replacement: fileURLToPath(new URL('./src/', import.meta.url)) }],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // 控制台语言是按进程读一次的系统事实;测试断言中文文案,与跑测试的机器区域无关。
    env: { CORTICO_LANGUAGE: 'zh' },
    testTimeout: 20000,
    pool: 'forks',
    maxWorkers: 2,
    minWorkers: 1,
  },
});

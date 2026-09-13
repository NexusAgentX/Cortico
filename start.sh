#!/bin/sh
# 逻辑一份都不在这里:见 bin/cortico.mjs。这个壳只负责切到仓库根。
# 用 sh 而不是 bash:精简镜像里未必有 bash,而这里已经没有需要它的语法了。
cd "$(dirname "$0")" || exit 1
exec node bin/cortico.mjs "$@"

#!/usr/bin/env sh
# 非 Windows 平台的一键启动入口；Windows 用根目录的 启动.bat。
# 本脚本放在 install/ 下，与 Windows 启动入口分开，避免根目录混淆。
set -e
cd "$(dirname "$0")/.."
exec node tools/launch.mjs "$@"

#!/usr/bin/env sh
# 非 Windows 平台的一键启动入口；Windows 用 启动.bat。
set -e
cd "$(dirname "$0")"
exec node tools/launch.mjs "$@"

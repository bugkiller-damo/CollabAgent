#!/usr/bin/env bash
# sync-agent-notes.sh — 将各 agent workspace 的 notes 同步到 Git 仓库
# 用法: bash sync-agent-notes.sh

set -e

SLOCK_HOME="${SLOCK_HOME:-$HOME/.slock}"
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

# Agent ID → 仓库目录名 映射
declare -A AGENTS=(
    ["8d771866-bb5b-415f-b498-6dc42abf0fbf"]="slock-protocol"
    ["72a1fa03-8e87-48e5-860d-a7b81b62e840"]="slock-backend"
    ["b5f59bdf-ce4c-4938-84a8-162881f9e7a2"]="slock-daemon"
    ["88a522cd-3c55-45b9-8b09-339afcc2f1d5"]="slock-frontend"
    ["d2c974d8-a547-4b83-8d2d-94b90d85b530"]="lingyaoCindy"
)

echo "=== 同步 Agent Notes → Git 仓库 ==="

for agent_id in "${!AGENTS[@]}"; do
    agent_name="${AGENTS[$agent_id]}"
    src="$SLOCK_HOME/agents/$agent_id/notes"
    dst="$REPO_ROOT/agents/$agent_name/notes"

    if [ -d "$src" ]; then
        mkdir -p "$dst"
        cp "$src"/* "$dst/" 2>/dev/null || true
        echo "  ✅ $agent_name"
    else
        echo "  ⚠️  $agent_name (源目录不存在: $src)"
    fi
done

echo "=== 同步完成 ==="

# O20：同步后、入库前扫密钥/敏感内容（agent notes 里出现过 agent 把 token 背进
# MEMORY.md 的真实案例，见 2026-08-17 O11 验证记录）。命中即阻断并列出文件，
# 确认是死凭据/误报后用 SYNC_ALLOW_SECRETS=1 显式放行。
SECRET_RE='sk_(agent|machine)_[A-Za-z0-9]+|-----BEGIN [A-Z ]*PRIVATE KEY-----'
HITS=$(grep -rEl "$SECRET_RE" "$REPO_ROOT/agents" 2>/dev/null || true)
if [ -n "$HITS" ] && [ "${SYNC_ALLOW_SECRETS:-0}" != "1" ]; then
    echo ""
    echo "✗ 检测到 notes 里含密钥/私钥模式，已阻断后续 git 提交流程：" >&2
    echo "$HITS" | sed 's/^/  /' >&2
    echo "  请先清理后再提交；确认是死凭据/误报可用 SYNC_ALLOW_SECRETS=1 显式放行。" >&2
    exit 1
fi

echo "接下来: cd \"$REPO_ROOT\" && git add -A && git commit -m 'sync agent notes'"

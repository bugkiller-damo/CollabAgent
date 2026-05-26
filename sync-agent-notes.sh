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
echo "接下来: cd \"$REPO_ROOT\" && git add -A && git commit -m 'sync agent notes'"

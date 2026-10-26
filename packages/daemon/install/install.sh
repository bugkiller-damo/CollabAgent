#!/bin/sh
# install.sh —— slock daemon 一键装机（curl ... | sh / ./install.sh）
#
#   curl -fsSL https://<host>/dl/install.sh | sh
#   SLOCK_DIST_BASE=<url-or-dir> SLOCK_DIST_VERSION=<ver> ./install.sh
#
# 与 install.ps1 同流程：Node≥20 → version.json → tarball → sha256 →
# ~/.slock/runtime/<ver>/ → current symlink → ~/.slock/bin/slock shim →
# PATH 持久化到 shell profile → 指引。

set -eu

SLOCK_HOME="${SLOCK_HOME:-$HOME/.slock}"
RUNTIME_ROOT="$SLOCK_HOME/runtime"
BIN_DIR="$SLOCK_HOME/bin"
BASE="${SLOCK_DIST_BASE:-${1:-}}"
VERSION="${SLOCK_DIST_VERSION:-}"

fail() { printf '✗ %s\n' "$1" >&2; exit 1; }
ok() { printf '✓ %s\n' "$1"; }

# ---------- 1. Node ≥20 ----------
command -v node >/dev/null 2>&1 || fail "node not found — install Node.js >= 20 first: https://nodejs.org/"
NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
[ "$NODE_MAJOR" -ge 20 ] || fail "node $(node -v) found but >= 20 required"
ok "node $(node -v)"

# ---------- 2. 版本解析 ----------
[ -n "$BASE" ] || fail "no distribution base — pass SLOCK_DIST_BASE or first arg"
fetch() {  # fetch <rel-path> <dest>
  if [ -d "$BASE" ]; then cp "$BASE/$1" "$2";
  elif [ "${BASE#file://}" != "$BASE" ]; then cp "${BASE#file://}/$1" "$2";
  elif command -v curl >/dev/null 2>&1; then curl -fsSL "$BASE/$1" -o "$2";
  elif command -v wget >/dev/null 2>&1; then wget -q "$BASE/$1" -O "$2";
  else fail "need curl or wget to download from $BASE"; fi
}
if [ -z "$VERSION" ]; then
  VERSION=$(fetch_stdout=$(mktemp); fetch version.json "$fetch_stdout" && sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$fetch_stdout"; rm -f "$fetch_stdout")
fi
[ -n "$VERSION" ] || fail "cannot resolve version — set SLOCK_DIST_VERSION"
ok "version $VERSION (base: $BASE)"

# ---------- 3. 下载 + sha256 ----------
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
PKG="slock-daemon-$VERSION.tar.gz"
fetch "$PKG" "$TMP/$PKG"
fetch "$PKG.sha256" "$TMP/$PKG.sha256"
EXPECT=$(awk '{print $1}' "$TMP/$PKG.sha256" | tr 'A-F' 'a-f')
if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$TMP/$PKG" | awk '{print $1}');
elif command -v shasum >/dev/null 2>&1; then ACTUAL=$(shasum -a 256 "$TMP/$PKG" | awk '{print $1}');
else fail "need sha256sum or shasum"; fi
[ "$EXPECT" = "$ACTUAL" ] || fail "sha256 mismatch: expected $EXPECT, got $ACTUAL"
ok "sha256 verified"

# ---------- 4. 解压 + current symlink ----------
INSTALL_DIR="$RUNTIME_ROOT/$VERSION"
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar -xzf "$TMP/$PKG" -C "$INSTALL_DIR"
[ -f "$INSTALL_DIR/cli.cjs" ] || fail "archive missing cli.cjs — corrupt package?"
ln -sfn "$INSTALL_DIR" "$RUNTIME_ROOT/current"
ok "runtime installed -> $INSTALL_DIR"

# ---------- 5. shim ----------
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/slock" <<EOF
#!/bin/sh
export SLOCK_DAEMON_ROOT="$RUNTIME_ROOT/current"
exec node "$RUNTIME_ROOT/current/cli.cjs" "\$@"
EOF
chmod +x "$BIN_DIR/slock"
ok "shim -> $BIN_DIR/slock"

# ---------- 6. PATH 持久化（首个命中的 profile，追加去重） ----------
line='export PATH="$HOME/.slock/bin:$PATH"'
for prof in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
  [ -f "$prof" ] && break
done
prof="${prof:-$HOME/.profile}"
grep -qsF '.slock/bin' "$prof" || { printf '\n# slock daemon\n%s\n' "$line" >> "$prof"; ok "PATH += $BIN_DIR ($prof)"; }
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) PATH="$BIN_DIR:$PATH"; export PATH;; esac

cat <<EOF

slock installed. Next:

  slock computer setup /<server-name> --server-url http://<host>:<port> --api-key <sk_machine_...>
  slock computer start /<server-name> --detach      # 后台常驻（崩溃自拉起）
  slock computer install /<server-name>             # 可选：登录自启
  slock computer status / logs / stop /<server-name>

EOF

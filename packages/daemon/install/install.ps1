# install.ps1 —— slock daemon 一键装机（raft 式 `irm ... | iex`）
#
#   irm https://<host>/dl/install.ps1 | iex                    # server 托管
#   .\install.ps1 -Base D:\path\to\release                    # 本地目录自测
#   irm ... | iex  with  $env:SLOCK_DIST_BASE / SLOCK_DIST_VERSION 预设
#
# 流程：Node≥20 检查 → version.json 解析版本 → 下载/拷贝 tarball →
# sha256 校验 → 解压 ~/.slock/runtime/<ver>/ → current junction →
# ~/.slock/bin/ 三件 shim（内嵌 SLOCK_DAEMON_ROOT）→ 用户 PATH 持久化 → 指引。
# 失败一律显式报错退出，不静默装半成品。

[CmdletBinding()]
param(
  [string]$Base = $env:SLOCK_DIST_BASE,
  [string]$Version = $env:SLOCK_DIST_VERSION
)

$ErrorActionPreference = "Stop"

$SlockHome = Join-Path $env:USERPROFILE ".slock"
$RuntimeRoot = Join-Path $SlockHome "runtime"
$BinDir = Join-Path $SlockHome "bin"

function Fail([string]$msg) { Write-Host "✗ $msg" -ForegroundColor Red; exit 1 }

# ---------- 1. Node ≥20 ----------
$nodeVer = $null
try { $nodeVer = (node -v) -replace '^v', '' } catch {}
if (-not $nodeVer) { Fail "node not found in PATH — install Node.js >= 20 first: https://nodejs.org/" }
if ([int]($nodeVer.Split('.')[0]) -lt 20) { Fail "node $nodeVer found but >= 20 required — upgrade: https://nodejs.org/" }
Write-Host "✓ node $nodeVer" -ForegroundColor Green

# ---------- 2. 版本解析 ----------
function Fetch-Bytes([string]$urlOrPath, [string]$dest) {
  if (Test-Path $Base) { Copy-Item (Join-Path $Base ([IO.Path]::GetFileName($urlOrPath))) $dest -Force }
  elseif ($Base -match '^file://') { Copy-Item (Join-Path ($Base -replace '^file://', '') ([IO.Path]::GetFileName($urlOrPath))) $dest -Force }
  else { Invoke-WebRequest -Uri "$Base/$urlOrPath" -OutFile $dest -UseBasicParsing }
}
function Fetch-Text([string]$rel) {
  if (Test-Path $Base) { return Get-Content (Join-Path $Base $rel) -Raw }
  if ($Base -match '^file://') { return Get-Content (Join-Path ($Base -replace '^file://', '') $rel) -Raw }
  return (Invoke-WebRequest -Uri "$Base/$rel" -UseBasicParsing).Content
}
if (-not $Base) { Fail "no distribution base — pass -Base <url-or-dir> or set SLOCK_DIST_BASE" }
if (-not $Version) {
  try { $Version = (Fetch-Text "version.json" | ConvertFrom-Json).version } catch { Fail "cannot resolve version from $Base/version.json — pass -Version explicitly" }
}
Write-Host "✓ version $Version (base: $Base)" -ForegroundColor Green

# ---------- 3. 下载 + sha256 校验 ----------
$tmp = Join-Path $env:TEMP "slock-install-$Version"
New-Item -ItemType Directory -Force $tmp | Out-Null
$pkg = "slock-daemon-$Version.tar.gz"
Fetch-Bytes $pkg (Join-Path $tmp $pkg)
Fetch-Bytes "$pkg.sha256" (Join-Path $tmp "$pkg.sha256")
$expect = ((Get-Content (Join-Path $tmp "$pkg.sha256") -Raw) -split '\s+')[0].ToLower()
$actual = (Get-FileHash (Join-Path $tmp $pkg) -Algorithm SHA256).Hash.ToLower()
if ($expect -ne $actual) { Fail "sha256 mismatch: expected $expect, got $actual" }
Write-Host "✓ sha256 verified" -ForegroundColor Green

# ---------- 4. 解压到 runtime/<ver>/ + current junction ----------
$installDir = Join-Path $RuntimeRoot $Version
if (Test-Path $installDir) { Remove-Item -Recurse -Force $installDir }
New-Item -ItemType Directory -Force $installDir | Out-Null
tar -xzf (Join-Path $tmp $pkg) -C $installDir
if (-not (Test-Path (Join-Path $installDir "cli.cjs"))) { Fail "archive missing cli.cjs — corrupt package?" }
$current = Join-Path $RuntimeRoot "current"
if (Test-Path $current) { Remove-Item -Recurse -Force $current }
New-Item -ItemType Junction -Path $current -Target $installDir | Out-Null
Write-Host "✓ runtime installed -> $installDir" -ForegroundColor Green

# ---------- 5. shim 三件（SLOCK_DAEMON_ROOT 钉到 current，升级不换 shim） ----------
New-Item -ItemType Directory -Force $BinDir | Out-Null
$cliPath = Join-Path $current "cli.cjs"
# cmd shim
Set-Content (Join-Path $BinDir "slock.cmd") "@echo off`r`nset SLOCK_DAEMON_ROOT=$current`r`nnode `"$cliPath`" %*"
# powershell shim
Set-Content (Join-Path $BinDir "slock.ps1") "`$env:SLOCK_DAEMON_ROOT = `"$current`"`r`n& node `"$cliPath`" @args"
# git-bash/wsl sh shim
Set-Content (Join-Path $BinDir "slock") "#!/bin/sh`nexport SLOCK_DAEMON_ROOT=`"$($current -replace '\\','/')`"`nexec node `"$($cliPath -replace '\\','/')`" `"`$@`""
Write-Host "✓ shims -> $BinDir (slock.cmd / slock.ps1 / slock)" -ForegroundColor Green

# ---------- 6. PATH 持久化（用户级，去重幂等） ----------
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not ($userPath -split ';' | Where-Object { $_ -eq $BinDir })) {
  [Environment]::SetEnvironmentVariable("Path", ($userPath.TrimEnd(';') + ';' + $BinDir), "User")
  Write-Host "✓ PATH += $BinDir (user scope; new terminals inherit)" -ForegroundColor Green
} else {
  Write-Host "✓ PATH already contains $BinDir" -ForegroundColor Green
}
$env:Path += ";$BinDir"  # 本会话立即可用

# ---------- 7. 指引 ----------
Write-Host @"

slock installed. Next:

  slock computer setup /<server-name> --server-url http://<host>:<port> --api-key <sk_machine_...>
  slock computer start /<server-name> --detach      # 后台常驻（崩溃自拉起）
  slock computer install /<server-name>             # 可选：登录自启
  slock computer status / logs / stop /<server-name>

"@ -ForegroundColor Cyan

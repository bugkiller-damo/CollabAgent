# Daemon 全局安装与分发设计（raft-computer 式）

日期：2026-10-23
状态：方案评审稿（未动工）
关联：`slock computer` 命令组已落地（本文件 §2 盘点）；web 端 /computers 接入卡已出两步命令。

---

## 1. 目标形态

对齐 raft-computer 的装机体验：

```powershell
# ① 一次性安装（任意目录，管理员/普通 PowerShell 均可）
irm https://<host>/computer/install.ps1 | iex

# ② 登记本机到某 server（凭据落 ~/.slock/servers.json，0600）
slock computer setup /bugkillers-test-server --server-url <url> --api-key sk_machine_... [--machine <uuid>]

# ③ 日常启停（全局命令，任意 cwd）
slock computer start /bugkillers-test-server
slock computer restart /bugkillers-test-server
slock computer stop
```

验收语义：装完后**不依赖 repo 目录、不依赖 pnpm/tsx、任意 cwd 可执行**；新机器从「零」到「daemon 在线」只有两个动作（install + setup）。

## 2. 现状盘点（已有什么，缺什么）

已落地（2026-10-23 批次）：

- `slock computer` 命令组：`setup / start / restart / stop / list / remove`（`src/cli/computer.ts`）
- `computer-registry.ts`：`~/.slock/servers.json` 登记档案（机器级、0600、原子写）
- `start` = profile → env（`SLOCK_SERVER_URL/API_KEY/SERVER_NAME/MACHINE_ID/STATE_DIR`）→ spawn `src/supervisor.ts`，launcher pid 落 `<stateDir>/computer-launcher.pid`
- `daemonRoot` 解析链：`SLOCK_DAEMON_ROOT` > `import.meta.url` / `argv[1]` 向上找 `@collabagent/daemon` package.json > profile 存档
- web：`GET /api/computers` 与 `GET /:id` 内嵌占位命令（`--api-key <MACHINE_TOKEN>`），`POST /me/token` 出真实 setup/start 双命令
- server：`DAEMON_LAUNCH_CMD` 前缀配置化（默认 `pnpm --filter @collabagent/daemon computer --`）

**核心缺口一句话**：现在的 `slock computer` 只能在 repo 里经 `tsx`/`pnpm` 跑——**没有可分发产物**，且 daemon 内部有三处「运行时回读 src/ 源文件」的隐性依赖，bundle/安装形态下会断。

## 3. 缺口分析

### 3.1 P0 阻断项：产物化 + src 依赖解耦

| # | 缺口 | 现状 | 影响 |
|---|------|------|------|
| P0-1 | daemon 单文件产物缺失 | `tsc` dist 输出依赖完整 node_modules；dev 走 tsx | 目标机无法零依赖拉起 daemon |
| P0-2 | `supervisor.ts` 入口硬编码 `srcDir/index.ts` | supervisor spawn `npx tsx index.ts`、watch srcDir | bundle 布局下入口不存在 |
| P0-3 | `setup-slock-wrapper.ts` 运行时 esbuild `src/cli.ts` | 生成 `.slock/slock-cli.cjs` + slock.bat/sh | 安装形态无 cli.ts → agent 侧 `slock` 命令断 |
| P0-4 | `mcp-bundle.ts` 运行时 esbuild `mcp/slock-mcp-server.ts` | 随 agent spawn 打 MCP server bundle | 同上，MCP 工具链断 |
| P0-5 | `slock` bin 未注册 | bin 只有 `collabagent-daemon → dist/index.js` | 全局装也没有 `slock` 命令 |
| P0-6 | `node-pty` 硬依赖 | package.json dependencies；运行时已 lazy（`agent-manager-lazy`） | bundle 标 external 即可；`SLOCK_USE_PTY=1` 时缺失报错——冻结兜底路径，可接受 |
| P0-7 | `computer start` 入口探测不全 | 只认 `src/supervisor.ts` / `dist/index.js` | 需加 bundle 布局探测（`<root>/daemon.cjs`） |

### 3.2 P1：安装器 + 分发通道

- **install.ps1 / install.sh**：OS/arch 探测 → Node ≥20 检查 → 下载发行包 → 解压固定目录（建议 `~/.slock/runtime/`）→ shim 写 `~/.slock/bin` → PATH 持久化（Windows 用户 env / POSIX profile）→ 打印 setup 引导。
- **发行包托管**：当前为零。候选见 §5.3。
- **版本与完整性**：tarball 带版本号 + sha256；install 脚本校验。

### 3.3 P1.5：常驻形态（「守护进程」的另一半语义）

当前 `start` 是前台进程；真装机需要：

- `slock computer start --detach`（后台 + 日志文件 `<stateDir>/daemon.log`）
- `slock computer install`（注册登录自启：Windows Scheduled Task / launchd LaunchAgent / systemd --user）
- `slock computer status` / `logs`（pid + WS 连通性 + tail）

不做的后果：install 了但窗口一关 daemon 就死——「守护」只装了半个。

### 3.4 P2：体验对齐（非阻断）

- `--machine <uuid>` 与 web /computers 展示 machineUuid 的 parity（raft 流程：web 先给 uuid，装机时 bind；我们目前首连自动建行）
- `slock computer update / uninstall / doctor`
- install 前置体检：claude CLI、git、node 版本
- 单 exe 免 Node（pkg / Node SEA）——免 Node 前置，工作量最大

## 4. 详细设计

### 4.1 构建产物（P0-1/5/7）

`scripts/build-dist.mjs`（esbuild，仓库已有依赖）产出三个 cjs 到 `dist-bundle/`：

| 产物 | 入口 | 说明 |
|------|------|------|
| `daemon.cjs` | `src/index.ts` | daemon 本体（含 enforceSingleInstance）；`node-pty` external |
| `cli.cjs` | `src/cli.ts` | `slock` 命令全集；`node-pty` 不经此入口，但仍 external |
| `slock-mcp-server.cjs` | `src/mcp/slock-mcp-server.ts` | agent MCP server，供 mcp-bundle 回落复用 |

要点：

- `format: "cjs"`、`platform: "node"`、`target: "node20"`（现 cli bundle 用 node18，升到 20 与 engines 对齐）
- external 清单：`node-pty`（唯一 native 依赖）；其余 deps 全打进单文件
- **import.meta 处理**：cjs 下 `import.meta.url` 为空——`cli/computer.ts` 已 try/catch 兜底；`setup-slock-wrapper`/`mcp-bundle`/`load-env`/`ready-payload`/`supervisor` 的 `import.meta.url` 用法需逐一过一遍（见 §4.2）
- supervisor 不进产物：安装形态 `start` 直跑 `daemon.cjs`；watch 是 dev 专属。「崩溃重启」由 `computer start` 的 launcher 循环承担（见 §4.4）

`package.json` bin 增补：

```json
"bin": {
  "collabagent-daemon": "./dist-bundle/daemon.cjs",
  "slock": "./dist-bundle/cli.cjs"
}
```

### 4.2 src 依赖解耦（P0-2/3/4）

原则：**先找发行包内的预打产物，没有再回退运行时 esbuild**（开发态行为不变）。

| 文件 | 改造 |
|------|------|
| `setup-slock-wrapper.ts` | 预打 `cli.cjs` 探测顺序：`SLOCK_CLI_BUNDLE` env > `<daemonRoot>/cli.cjs`（发行布局）> 现有 `esbuild src/cli.ts`（开发）> `npx tsx` 兜底。探测到预打产物 = 复制/引用它，不再现场打包 |
| `mcp-bundle.ts` | 同上：`SLOCK_MCP_BUNDLE` env > `<daemonRoot>/slock-mcp-server.cjs` > 现有 esbuild 路径 > null |
| `cli/computer.ts` `computerStart` | 入口探测顺序改为：`<root>/daemon.cjs`（发行）> `src/supervisor.ts`（dev）> `dist/index.js`（tsc 构建）。发行形态 spawn `node daemon.cjs` + 外层 restart 循环（见 §4.4） |
| `load-env.ts` | `../.env` 相对 bundle 位置解析——发行目录无 .env 即 existsSync 跳过，无需改 |
| `ready-payload.ts` / `supervisor.ts` 的 import.meta | supervisor 不进产物（跳过）；ready-payload 确认其用法仅定位资源，bundle 下退化路径可接受（动工时核一遍） |
| `agent-runtime-manifest` / schema | `schemas/runtime-manifest.schema.json` 若运行期按文件路径读取 → 随发行包一并拷贝（`files` 白名单） |

### 4.3 过渡形态：npm 全局装（零基建，本周即可用）

```bash
npm i -g ./packages/daemon        # 或 pnpm i -g
slock computer setup /x --server-url ... --api-key ...
slock computer start /x
```

依赖项：P0-1（cli.cjs 产物）+ P0-5（bin）+ §4.2 的两处 bundle 回落。**不需要任何托管**——这是第一个里程碑。

限制：`npm i -g` 会装 dependencies（node-pty 在目标机要编译工具链）；可把 node-pty 挪 `optionalDependencies`（install 失败不阻塞，运行时本来 lazy）。

### 4.4 install 脚本 + 常驻（P1/P1.5）

`install.ps1`（Windows 主战场；`install.sh` 对称）流程：

1. 检查 `node -v ≥ 20`（缺 → 指引安装，不代装）
2. 下载 `slock-daemon-<ver>-<os>-<arch>.tar.gz` + `.sha256`，校验后解压到 `~/.slock/runtime/`（版本目录 `runtime/<ver>/` + `current` 链接）
3. 写 shim：`~/.slock/bin/slock`（sh）+ `slock.bat`（cmd）+ `slock.ps1`——内部 `node <current>/cli.cjs %*`
4. PATH 持久化：Windows `[Environment]::SetEnvironmentVariable("Path", ..., "User")`；POSIX 检测 profile（`.bashrc`/`.zshrc`）追加
5. `SLOCK_DAEMON_ROOT=<install dir>` 写入 shim（resolveDaemonRoot 的第一优先）
6. 输出后续指引：`slock computer setup /<server> --server-url ... --api-key ...`

常驻与自启（分两小步走，不绑 install）：

- `start --detach`：`spawn detached + stdio→<stateDir>/daemon.log + unref`；launcher.pid 已有；加 `status`/`logs` 子命令（pid 活性 + `tail` 语义）
- `install` 子命令：注册自启项——Windows `schtasks /create /tn "SlockDaemon" /sc onlogon /tr "node <cli.cjs> computer start <name> --detach"`；macOS `~/Library/LaunchAgents/`；Linux `systemd --user` unit。失败打印手工指引不硬错。

### 4.5 发行通道选型（§5.3 候选评估）

| 方案 | 成本 | 备注 |
|------|------|------|
| **A. GitHub Releases** | 低（CI 上传即可） | 需仓库 public 或 release 资源可匿名下载；私有仓库要 token，install 脚本复杂度+1 |
| **B. 自有 server 静态路由** | 中（server 加 `/dl/` 静态目录 + 版本清单 JSON） | 与产品同域，版本随 server 发布天然一致；`DAEMON_LAUNCH_CMD` 同源下发 |
| **C. 对象存储/CDN** | 中 | 已在部署形态里有 MinIO 先例（O4），但为 daemon 单独开桶略重 |
| **D. npm registry** | 低 | `npm i -g @collabagent/daemon`——§4.3 的直接延伸；私有包要 npm 组织/付费或 GitHub Packages token |

推荐顺序：**先 D（npm i -g 过渡）→ B（自有 server 托管，install 脚本随 server 版本走）**。B 的好处：`install.ps1` 可以从 `https://<你的slock>/dl/install.ps1` 下载，发行与部署同源、无需第三方账号。

### 4.6 machine 身份 parity（P2，顺手项）

web /computers 行已存 `machineUuid`（daemon ready upsert）。若要做 raft 式「web 先生成 uuid → 装机 `--machine` 绑定」：POST /me/token 或 computers 列表可顺带返回 `machineUuid` 建议值（新生成的 uuid 或现有行），setup 透传 `SLOCK_MACHINE_ID`。否则保持现状（daemon 首连自动建行）也自洽——只是 raft 命令里那个 uuid 参数暂时是「可选 pin」。

## 5. 分期与验收

| 期 | 范围 | 验收 |
|----|------|------|
| **S1 产物化** | §4.1 构建脚本 + §4.2 三处解耦 + bin 注册 + node-pty optional | `node dist-bundle/daemon.cjs --server-url ... --api-key ...` 在无 src 的目录起得来；agent slock/MCP 在 bundle 下可用 |
| **S2 npm 全局装** | §4.3 | 本机任意 cwd `slock computer setup/start` 全流程 |
| **S3 install + 常驻** | §4.4 | 干净 Windows 机 `irm ... \| iex` → setup → start --detach → 重启登录后仍在线 |
| **S4 发行通道** | §4.5-B 自有 server `/dl/` | 内网机器从自部署 server 拉包安装 |
| **S5 体验补齐** | §4.6 + update/uninstall/doctor + 前置体检 | — |

S1+S2 是「全局可用」的最小闭环；S3 之后才配叫「守护进程」。

## 6. 风险与开放问题

- **node-pty optional 化**后，`SLOCK_USE_PTY=1` 在未装 node-pty 的发行形态下报什么错——需要在 agent-manager-lazy 的 import 失败路径给出可读错误（现状可能是裸 MODULE_NOT_FOUND）
- **`slock` 命令名冲突**：daemon 装到 PATH 的 `slock` 与 agent PTY 内 `.slock/slock` wrapper 同名——PATH 顺序上 agent 环境把 `.slock` 前置，行为一致（都是同一 CLI），可接受；需文档化
- **多 server 同机**：registry 已支持多 profile，但一台机器同时只跑一个 daemon（pidfile/单实例语义）——`start /<a>` 时如在跑别的 server 应提示先 stop。当前 `start` 的 alreadyRunning 检查按 profile stateDir 分别算——多 profile 多 stateDir 时会允许并存（设计如此还是有洞，动工时定死）
- **install 脚本签名**：Windows SmartScreen 对未签名 ps1 有警告；短期接受，正式分发再签
- **`SLOCK_STATE_DIR` 默认**：发行形态下 daemonRoot 是安装目录，stateDir 默认 `<root>/.slock` 会落在安装目录下——升级覆盖时状态被带走？应改为默认 `~/.slock/state/<serverName>`（profile.stateDir 可覆盖）。**这是与 repo 开发态语义的一处分叉，需要拍板**（repo 态保留 `<root>/.slock` 兼容既有状态；install 形态用 `~/.slock/state/`）

## 附录：名词

- **CDN**（Content Delivery Network，内容分发网络）：把文件缓存到离用户近的节点加速下载的服务（raft 用的 `cdn.raft.build`）。对我们而言**不需要真 CDN**——发行包就是个静态 tarball，GitHub Releases 或自有 server 的静态路由完全够用（§4.5-B）。只有用户量到「全球下载都要快」时才轮到真 CDN。

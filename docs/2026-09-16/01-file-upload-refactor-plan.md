# 文件上传/查看功能重构方案

> 日期：2026-09-16
> 状态：**批次一（P0）全部落地 ✅**——F1~F8 清零（2026-09-16）：attachment-gc.ts 5 测试 + upload.ts 收编；
> F4 线程附件——ThreadView 透传 attachmentIds + /thread 端点补附件聚合；F5 附件消息收编进 messageStore
> 离线队列；F6 daemon 透传附件——inbound 解析 + deliver 注入 prompt 摘要；F7 /files/ capability URL 下线——
> url 全收敛 /api/attachments/<id>（ACL），静态路由改 410 + warn 观察期，?inline=1 直显安全图片；
> F8 协议对齐——AttachmentRef 更名 filename（对齐线上 wire/web）+ url 收口必填 + thumbnailUrl 占位（F11 用）；
> **批次二启动：F9 流式/Range 已落地（2026-09-16）**——Storage 接口加 createReadStream(key, range?)
> （local 走 fs.createReadStream+stat，S3 走 GetObjectCommand Range 头 + ContentRange 解析 totalSize）；
> serveAttachment 不再整文件读内存，Range 解析支持 bytes=start-end/start-/-suffix，恒发 Accept-Ranges，
> 206 + Content-Range，越界/倒置 416（bytes */total），非 bytes 单位忽略走全量；黑盒 +1 测试（8 断言场景）、
> storage-s3 +4 单测。**F10 SHA256 去重已落地（2026-09-16）**——migration 026 加 `sha256 CHAR(64)`（NULL 允许）
> + 部分索引；upload 收编处算 hash 命中即复用首个命中行的 storage_key（跨用户安全：须持有内容才能匹配）；
> GC sweep 与频道删除的字节清理改按 storage_key 引用计数兜底（共享 key 不误删）；GC tick 顺带
> backfillSha256 小批量回填老行；黑盒 +1（去重共享 key + 删频道字节存活）、attachment-gc +2
> （共享 key 保留 + 回填/缺字节跳过）。**F11 缩略图已落地（2026-09-16）**——sharp 依赖入库
> （makeThumbnail 动态 import + 失败降级 null，不阻塞上传）；migration 027 加 `thumb_key TEXT`；
> 图片上传生成 ≤400px webp 存 `<key>.thumb.webp`，F10 去重命中时 thumb_key 一并复用；
> `GET /api/attachments/:id?thumb=1` inline 直出 webp（缺字节回落原图不破图）；attachmentsJson
> 补发 thumbnailUrl；GC/频道删除连带清派生键（主 key 引用计数覆盖）；web AttachmentView 列表用
> 缩略图、lightbox 用原图，存量无 thumb 自动回落。黑盒 +1（缩略图生成/尺寸/载荷/去重联动）。
> server 548/548 绿（STORAGE_BACKEND=local 口径）、web 143/143 绿。**MinIO 已落地（2026-09-16）**：对接外部共享桶
> skzhbg（192.168.50.104:9000），新增 S3_KEY_PREFIX=slock/ 目录隔离（逻辑 key 与真实对象路径分离，
> 路由/前端零感知），storage-s3 +2 前缀测试；冒烟（scripts/s3-smoke.ts：save/read/remove 字节比对）与
> HTTP 端到端（scripts/s3-e2e.ts：注册→建频道→上传→带附件发消息→ACL 下载字节一致→inline 白名单→
> 删频道连带删对象→404）全绿，验证数据已回收。**F13 MIME 白名单已落地（2026-09-17）**——默认
> ALLOWED_MIME_TYPES 追加 video/mp4,video/webm,audio/mpeg,audio/ogg（音视频可上传；播放依赖
> F9 Range 已就绪）；?inline=1 仍仅放行安全图片（<video>/<audio> 内联预览属 F14）；
> lib.test.ts +3 用例、attachments.test.ts 黑盒 +1（上传/下载/未入册 415/inline 不放行）；
> server 553/553 全绿（STORAGE_BACKEND=local 口径 + NODE_ENV=test server）。
> **F14 预览矩阵已落地（2026-09-17）**——server INLINE_SAFE_MIME 扩容（+video/mp4,video/webm,
> audio/mpeg,audio/ogg,application/pdf,text/plain,application/json；SVG/HTML 恒排除）+
> 附件字节响应补 `X-Content-Type-Options: nosniff`（inline 面扩容后的底线纵深）；
> web 新增 `lib/attachment-preview.ts` 纯判定模块（previewKind/textPreviewable，256KB 文本
> 上限）+ AttachmentView 预览矩阵：`<video>`（F9 Range 拖动可用）/`<audio>` 播放条/PDF
> lightbox iframe（浏览器内建阅读器）/text·json 代码块预览（cookie fetch 读字节，乱序回包
> id 比对防串）；顺手修 AttachmentView 图标未导入缺陷（模板用 FileText/X 但 script 没
> import，bee0848 同款）。web 159/159 绿（+16）、server 黑盒 attachments 11/11 绿、
> 双包 tsc 绿。**F15 上传体验已落地（2026-09-17）**——`uploadAttachment` fetch→XHR
> （`upload.onprogress` 进度 0~100，`lengthComputable=false` 时 pct=null 回落文案）+ AbortSignal
> 取消（XHR abort，reject「已取消」）；MessageComposer 附件徽标改进度条（蓝条+tabular 百分比）
> + 移除即取消（上传中点 X = abort），error 徽标区分「过大」（从未起传）/「失败」（起传后失败）；
> 老签名 (file) 全兼容（ProfileSettings 头像零改动）。api 测试换 FakeXhr 驱动（+进度/取消/
> 网络错误/settle-once 共 5 用例），web 162/162 绿。**分片/断点续传评估结论：暂不引入**——
> MAX_UPLOAD_SIZE=10MB 上限下无断点场景；分片端点（init/part/complete）+ MinIO multipart
> 与 F12 预签名直传天然组合，随 F12 设计时一并评估。下一步：F16 病毒扫描
> 下一步：批次三 F14 预览矩阵（AttachmentView 原生 video/audio 标签 + PDF/text 预览）→
> F15 上传进度/分片 → F16 病毒扫描
> 依据：对 packages/server、packages/web、packages/daemon 全量摸排（73 处工具调用，证据均带 文件:行号）

---

## 1. 现状架构摘要

当前文件功能**骨架是健全的**（multipart 上传 + 存储抽象 + 关联表 + ACL 下载），但处于"能用的半成品"状态，距离可长期演进的产品级文件能力还差一批结构性补课。

```
上传：web/daemon/CLI ──multipart──> server (@fastify/multipart, 10MB 上限)
        ├─ 人类：POST /api/attachments/upload        (routes/attachments.ts:59)
        └─ Agent：POST /internal/agent/:id/upload    (routes/agents-messages.ts:266)
存储：STORAGE_BACKEND=local|s3|minio                 (lib/storage.ts:117 工厂)
        ├─ local → ./uploads/<uuid>/<filename>       (lib/storage.ts:93)
        └─ s3    → @aws-sdk/client-s3                (lib/storage-s3.ts)
元数据：attachments 表 + message_attachments 关联表   (migrations/000:145-164)
下载：GET /api/attachments/:id  (整文件读内存发回, 强制 attachment)
       GET /api/attachments/by-key?key=...
       GET /files/<uuid>/<name> (静态路由, capability URL, 仅登录不做频道 ACL)
渲染：web AttachmentView.vue —— 仅图片 inline+lightbox，其余一律下载链接
```

已有亮点（重构时不要回退）：

- 存储后端已抽象（`storage.ts` 工厂），S3/MinIO 后端已落地（O4 提交 e5f04f9/08a9ebf）；
- docker-compose 已带可选 MinIO profile（`docker-compose.yml:104-128`）；
- 本地下载 `pathFor` 有路径穿越前缀校验（`storage.ts:66-72`）；
- `/api/attachments/:id` 与 `by-key` 有"上传者本人或频道成员"ACL；
- MCP/CLI 侧 agent 上传、随消息发附件链路已通。

---

## 2. 缺陷清单（分级）

### P0 —— 数据一致性 / 安全 / 明显功能缺口（本批必修）

| # | 缺陷 | 证据 |
|---|------|------|
| F1 | **孤儿文件无清理**：删消息只删 `message_attachments` 映射，`attachments` 行与对象字节都残留；无定时清理任务 | `routes/messages.ts:659-661`；全仓无 GC job |
| F2 | **Agent 上传不做文件名净化**：直接用原始 `data.filename` 拼 key，未走 `sanitizeFilename`（人类侧有） | `routes/agents-messages.ts:280` vs `lib/storage.ts:56-58` |
| F3 | **Agent 上传缺大小兜底**：人类侧在 multipart 限制外还有 `buf.length > MAX` 二次校验，Agent 侧没有 | `routes/attachments.ts:77-79` 有，`agents-messages.ts` 无 |
| F4 | **线程回复不能带附件**：ThreadView 的 `handleSend` 不传 `attachmentIds`（产品缺口，频道/DM 都支持唯独线程没有） | `pages/ThreadView.vue:234-238` |
| F5 | **带附件消息不进离线队列**：ChannelView/DmView 直接发送，失败即丢；store 的 pending 结构已支持 `attachmentIds` 但 UI 没用 | `ChannelView.vue:179-191`、`DmView.vue:106-120`、`messageStore.ts:295-309` |
| F6 | **Agent 实时收不到附件**：daemon 入站解析 `readDeliverMessage` 不透传 `attachments`，agent 只能 `read_history` 补看 | `daemon/src/handlers/inbound.ts:60-81` |
| F7 | **`/files/` capability URL 越权面**：任何登录用户凭 URL 即可下载，不校验频道成员；URL 一旦泄漏（日志/转发）即失守 | `index.ts:206-216` 注释自承 |
| F8 | **shared 协议类型缺 `url`**：`AttachmentRef` 无 `url` 字段，服务端实际下发，类型与协议漂移 | `packages/shared/src/index.ts:58-63` |

### P1 —— 存储与传输层结构性短板

| # | 缺陷 | 证据 |
|---|------|------|
| F9 | **整文件读内存**：`serveAttachment` 每次 `read()` 全量 Buffer，无流式、无 Range、无 `Accept-Ranges`；大文件/续传/音视频播放全废 | `routes/attachments.ts:20-57` |
| F10 | **无内容哈希/去重**：同一文件反复上传重复占空间；attachments 表无 sha256 列 | schema `000:145-158` |
| F11 | **无缩略图**：原图直接 inline，列表页/弱网/移动端体验差 | `AttachmentView.vue` 无 thumb 字段 |
| F12 | **上传/下载全过 server 中转**：无预签名 URL 直传直链，server 成带宽瓶颈（local 与 S3 后端同病） | 无 presign 相关代码 |

### P2 —— 产品能力缺口（可排期）

| # | 缺陷 | 证据 |
|---|------|------|
| F13 | MIME 白名单无 video/audio，产品层发不了音视频 | `lib/config.ts:80-83` |
| F14 | PDF/音视频/文本无预览器，只有下载链接 | `AttachmentView.vue` |
| F15 | 无上传进度条、无分片/断点续传 | `MessageComposer.vue:104-114` |
| F16 | 无病毒扫描（对外部署时的合规短板） | 全仓无 clamav 集成 |

---

## 3. 开源文件存储选型

结论先行：**继续用 S3 协议作为唯一存储接口，自托管推荐 MinIO；不引入第二套存储协议。**

候选对比（面向本项目体量：团队级协作、docker-compose 部署、Windows 开发机 + Linux 服务器）：

| 方案 | 协议 | 适配成本 | 运维成本 | 适用判断 |
|------|------|----------|----------|----------|
| **MinIO** | S3 | **零**（后端+compose profile 已落地） | 单容器单二进制，极轻 | ✅ **推荐默认**：私有部署/比赛交付（广石杯口径下"可离线私有化"是加分项） |
| 云厂商 S3（阿里 OSS/腾讯 COS/AWS） | S3 | 零（改 env 即切换） | 无 | ✅ 生产上云时的目标；`S3_PUBLIC_BASE_URL` 已支持 CDN 域名 |
| SeaweedFS | S3 + FUSE | 低 | 中（master/volume/filer 三角色） | 备选：文件量级到亿级、需要 POSIX 挂载时再评估，当前过度设计 |
| Garage | S3 | 低 | 低 | 备选：极小内存占用的 geo 分布式场景，社区生态弱于 MinIO |
| Ceph RGW | S3 | 中 | **高** | ❌ 团队体量不值得 |
| 本地磁盘（现状默认） | — | 零 | 零 | ✅ 保留为 dev/单机默认，但要补 GC 与 Range（见 §4） |

**关键决策：接口锁定 S3，实现可换。** 现有 `storage.ts` 工厂模式已经是对的，重构方向是把这个抽象**做厚**（流式接口、预签名、哈希去重），而不是换协议。MinIO 在 compose 里从"可选 profile"升级为"推荐默认生产后端"，README 部署文档同步改口径。

---

## 4. 重构方案（三批推进）

### 批次一（P0 修复批，不动架构，预计 2~3 天）

目标：把 §2 的 F1~F8 清零，全部是小切口修复，不改存储接口。

1. **F1 附件 GC**：新增 `packages/server/src/lib/attachment-gc.ts`——启动后每小时扫 `attachments` 表中无 `message_attachments` 引用且 `created_at < now() - interval '1 day'` 的行，先删对象字节（best-effort）再删行；频道删除链路（`channels.ts:300-342`）已有一半逻辑，抽公共函数复用。
2. **F2/F3 Agent 上传对齐人类侧**：`agents-messages.ts:266-` 复用 `sanitizeFilename` + 补 `buf.length > MAX_UPLOAD_SIZE` 校验；顺手把两条上传入口的公共段抽成 `handleUpload(req)` 收编到 `lib/upload.ts`，消除双份逻辑漂移的根源。
3. **F4 线程附件**：`ThreadView.vue` 的 `handleSend` 透传 `attachmentIds`（server 侧 `messages.ts` 已支持 threadId+附件同事务，只缺 UI 接线）。
4. **F5 附件进离线队列**：ChannelView/DmView 改为统一走 `messageStore` pending 链路（结构已支持，只改调用点）；附件先传后发的两段式保持，pending 里存已上传的 `attachmentIds`。
5. **F6 daemon 透传附件**：`inbound.ts` 的 `readDeliverMessage` 补解析 `attachments` 字段进 `WsDeliverMessage`，headless 注入 prompt 时附上 `filename/mimeType/url` 摘要（agent 需要时再 `read_history` 取细节）。
6. **F7 收紧 `/files/`**：两条路二选一——(a) 下线 `/files/` 静态路由，全部收敛到 `/api/attachments/:id`（有 ACL）；(b) 保留但加频道成员校验。**建议 (a)**：双下载出口本身就是缺陷温床，capability URL 模型与频道 ACL 模型长期必打架。
7. **F8 协议对齐**：`packages/shared` 的 `AttachmentRef` 补 `url: string`，并加 `thumbnailUrl?: string`（为批次二占位）。

### 批次二（P1 存储层强化，预计 3~5 天）

目标：流式 + 去重 + 缩略图，storage 抽象做厚。

1. **F9 流式下载**：`StorageBackend` 接口把 `read(key): Promise<Buffer>` 升级为 `createReadStream(key, range?)`；`serveAttachment` 改 `reply.send(stream)`，解析 `Range` 头回 206；local 用 `fs.createReadStream`，S3 用 `GetObjectCommand({ Range })`。**这是后续音视频预览（F13/F14）的前置。**
2. **F10 SHA256 去重**：attachments 表加 `sha256 CHAR(64)` 列 + 索引；上传时边收流边算 hash，命中同 hash 行则复用 `storage_key`（新行指向旧 key，引用计数或 GC 时按 key 查引用数兜底）。
3. **F12 预签名直链（S3 后端优先）**：上传走 `POST /api/attachments/presign` 拿 PUT 预签名 URL，浏览器直传 MinIO/S3，完成后 `POST /api/attachments/complete` 落元数据；下载侧 `storage_url` 改为 GET 预签名 URL（短时效）替代 server 中转。local 后端保留现有中转路径作为 dev 兜底。
4. **F11 缩略图**：上传图片时（batch 或异步队列）用 `sharp` 生成 ≤400px webp 缩略图，存 `<key>.thumb.webp`，`AttachmentRef.thumbnailUrl` 下发；AttachmentView 列表用缩略图、lightbox 用原图。

### 批次三（P2 产品能力，按排期）

1. **F13/F14 预览矩阵**：MIME 白名单加 `video/mp4,video/webm,audio/mpeg,audio/ogg`（依赖批次二的 Range）；AttachmentView 加 `<video>/<audio>` 原生标签、PDF 用 `<iframe>` 或 pdfjs、text/json 走代码块预览。
2. **F15 上传体验**：XMLHttpRequest/fetch+progress 做进度条；大文件（>50MB）评估分片（MinIO/S3 multipart 与预签名天然兼容）。
3. **F16 病毒扫描**：对外部署场景接 ClamAV（`clamscan` 子进程或 clamd TCP），上传落盘后异步扫，命中即删行+删字节+审计流上报；私有化/比赛场景可配置关闭。

---

## 5. 兼容与迁移

- **DB 迁移**：新增 migration `00X_attachment_sha_thumb.sql`（加列+索引），`sha256` 允许 NULL，老数据后台回填（读流算 hash，best-effort）。
- **API 兼容**：`/api/attachments/:id`、`by-key` 路径与响应字段保持；`/files/` 下线前观察期打 deprecation 日志（统计命中率），确认 web/daemon 无引用后删除。
- **存储迁移**：local → MinIO 切换提供一次性脚本 `scripts/migrate-uploads-to-s3.mjs`：扫 uploads 目录按 `storage_key` 上传并校验行数。
- **agent 侧**：F6 的 `attachments` 透传是纯增量字段，旧版 daemon 解析忽略即兼容。

## 6. 验收清单

- [x] `npx tsc --noEmit -p packages/server/tsconfig.json` / `-p packages/web/tsconfig.json` / `-p packages/daemon/tsconfig.json` 全绿（web 实际走 vue-tsc）
- [x] server/web/daemon 各自 `pnpm vitest run` 全绿；批次一每个 F 项配 1 个回归测试（vitest 需 `node --env-file=.env` 跑 server 测试，残留走 `scripts/cleanup-test-data.mjs`）
- [ ] 手测链：频道/DM/线程三入口发图发文件 → 删消息 → GC 后 uploads 目录无残留
- [x] Range 验证：`curl -H "Range: bytes=0-99"` 回 206（已由 attachments.test.ts F9 黑盒用例自动化覆盖：206/Content-Range/416/Accept-Ranges）
- [x] `/files/` 旧链接访问返回 404/410 且日志有迁移提示（F7：410 + warn 观察期日志）
- [ ] compose 以 MinIO profile 起栈，上传/下载/缩略图全链路通（缩略图链路本身已由 attachments.test.ts F11 用例自动化覆盖——local 后端口径；compose 起栈手测待做）

## 7. 风险与备注

- **`/files/` 下线是行为变更**：若有外部（比赛演示脚本、用户书签）依赖需先公告；观察期建议 ≥1 周。
- **预签名 URL 与现有频道 ACL 的关系**：URL 短时效（分钟级）+ 签发前走 ACL，语义上等价于现状 `/api/attachments/:id`，比 capability URL 更严。
- **sharp 在 Windows 开发机**：有预编译二进制，pnpm 安装即可，无需额外工具链；若出问题缩略图生成可降级为异步可选（失败不阻塞上传）。
- 本方案与 `docs/2026-08-20/02-daemon-evolution-tracker.md` 无冲突，属于 server/web 侧新批次，建议在 tracker 中增列「F 批（文件能力）」跟踪。

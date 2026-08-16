# syntax=docker/dockerfile:1
# Slock server 生产镜像（O19）：多阶段构建、非 root、内置健康检查。
# 与 O5 联动：NODE_ENV=production 且 JWT_SECRET/REFRESH_SECRET 命中默认值/缺失时，
# 应用启动即 process.exit(1)（packages/server/src/lib/config.ts 硬校验）。

# ---------- 构建阶段：全量依赖 + 编译 ----------
FROM node:22-alpine AS build
WORKDIR /repo

# pnpm 版本与 CI（pnpm/action-setup v9）保持一致
RUN corepack enable && corepack prepare pnpm@9 --activate

# 先拷清单与两个包的 package.json：依赖层缓存命中最大化
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/server/package.json packages/server/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile

# 拷贝源码并编译（server 运行时当前不 import shared；shared 一并构建以便未来固化协议包）
COPY packages/server/tsconfig.json packages/server/
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY packages/server/src packages/server/src
RUN pnpm --filter @collabagent/shared build && pnpm --filter @collabagent/server build

# pnpm deploy：裁剪出 server 的生产依赖 + 构建产物（含内联 workspace 依赖）。
# 注意：dist 在 .gitignore 中，deploy 的包文件收集会跳过它——单独补拷。
RUN pnpm --filter @collabagent/server deploy --prod /app && \
    cp -r /repo/packages/server/dist /app/dist && \
    rm -rf /app/src /app/test /app/scripts

# ---------- 运行阶段：精简、非 root、healthcheck ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3001

RUN addgroup -S slock && adduser -S slock -G slock

WORKDIR /app
COPY --from=build --chown=slock:slock /app ./
# 本地存储后端的上传目录（生产建议挂卷 uploads-data）
RUN mkdir -p /app/uploads && chown slock:slock /app/uploads

USER slock
EXPOSE 3001

# /api/health 含 DB 连通性探测；db:true 才判定健康
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/health | grep -q '"db":true' || exit 1

CMD ["node", "dist/index.js"]

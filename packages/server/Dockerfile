FROM node:22-alpine AS base
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9 --activate

COPY pnpm-workspace.yaml package.json ./
COPY packages/server/package.json packages/server/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile || pnpm install

COPY . .

RUN pnpm --filter @collabagent/server build || true

EXPOSE 3001
CMD ["pnpm", "--filter", "@collabagent/server", "dev"]

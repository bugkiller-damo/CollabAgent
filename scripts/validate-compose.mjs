#!/usr/bin/env node
/**
 * O19：生产部署形态静态校验（无需 docker 即可跑，已接入 CI L1）。
 *
 * 校验内容：
 *  - docker-compose.yml 可被 YAML 解析，且 server 服务满足生产形态约束
 *    （build 指向 Dockerfile、healthcheck、资源限制、必选密钥插值、无源码挂载、depends_on 健康条件）；
 *  - packages/server/Dockerfile 满足多阶段、非 root、healthcheck、pnpm deploy --prod。
 *
 * YAML 解析依赖仓库内已有的 yaml 包（@fastify/swagger 的传递依赖，lockfile 保证存在）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
function assert(cond, msg) {
  if (!cond) failures.push(msg);
}

// ---- 加载 yaml（从 .pnpm 虚拟仓库定位，版本无关） ----
function findYaml() {
  const pnpmDir = join(ROOT, "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) return null;
  const dir = readdirSync(pnpmDir).find((d) => /^yaml@/.test(d));
  if (!dir) return null;
  const entry = join(pnpmDir, dir, "node_modules", "yaml", "dist", "index.js");
  return existsSync(entry) ? entry : null;
}

const yamlEntry = findYaml();
if (!yamlEntry) {
  console.error("❌ 未找到 yaml 依赖（node_modules/.pnpm/yaml@*）——请先 pnpm install --frozen-lockfile");
  process.exit(1);
}
const { parse } = await import(pathToFileURL(yamlEntry).href);

// ---- 校验 docker-compose.yml ----
const composePath = join(ROOT, "docker-compose.yml");
let compose;
try {
  compose = parse(readFileSync(composePath, "utf8"));
} catch (err) {
  console.error(`❌ docker-compose.yml YAML 解析失败：${err.message}`);
  process.exit(1);
}

assert(compose?.services?.server, "compose 缺少 server 服务");
assert(compose?.services?.postgres, "compose 缺少 postgres 服务");
assert(compose?.services?.valkey, "compose 缺少 valkey 服务");

const server = compose?.services?.server ?? {};
assert(server.build?.dockerfile === "packages/server/Dockerfile", "server 必须通过 packages/server/Dockerfile 构建");
assert(server.healthcheck?.test, "server 必须有 healthcheck");
const hc = JSON.stringify(server.healthcheck?.test ?? "");
assert(hc.includes("/api/health"), "server healthcheck 必须探测 /api/health");
assert(hc.includes("db"), "server healthcheck 必须包含 db 连通性判定");
assert(server.deploy?.resources?.limits?.memory, "server 必须设置内存资源限制");
assert(server.restart, "server 必须设置 restart 策略");
assert(
  typeof server.environment?.JWT_SECRET === "string" && server.environment.JWT_SECRET.includes("${JWT_SECRET:?"),
  "server JWT_SECRET 必须使用必选插值 ${JWT_SECRET:?...}（O5 联动）",
);
assert(
  typeof server.environment?.REFRESH_SECRET === "string" &&
    server.environment.REFRESH_SECRET.includes("${REFRESH_SECRET:?"),
  "server REFRESH_SECRET 必须使用必选插值 ${REFRESH_SECRET:?...}（O5 联动）",
);
assert(server.environment?.NODE_ENV === "production", "server 必须 NODE_ENV=production");
const volumes = server.volumes ?? [];
assert(
  !volumes.some(
    (v) =>
      String(typeof v === "string" ? v : Object.keys(v)[0]).startsWith(".") ||
      String(typeof v === "string" ? v : Object.keys(v)[0]).startsWith("/app/"),
  ),
  "server 禁止挂载源码/依赖目录（生产形态读镜像内产物）",
);
assert(
  volumes.some((v) => String(typeof v === "string" ? v : Object.keys(v)[0]).includes("uploads")),
  "server 必须挂载 uploads 持久卷",
);
assert(server.depends_on?.postgres?.condition === "service_healthy", "server 必须依赖 postgres 健康后再启动");
assert(server.depends_on?.valkey?.condition === "service_healthy", "server 必须依赖 valkey 健康后再启动");
assert(compose?.services?.postgres?.healthcheck, "postgres 必须有 healthcheck");
assert(compose?.services?.valkey?.healthcheck, "valkey 必须有 healthcheck");
assert(
  Array.isArray(compose?.services?.minio?.profiles) && compose.services.minio.profiles.includes("s3"),
  "minio 服务必须挂 profiles: [s3]（可选启动）",
);
assert(compose?.volumes?.["uploads-data"] !== undefined, "必须声明 uploads-data 卷");

// ---- 校验 packages/server/Dockerfile ----
const dockerfile = readFileSync(join(ROOT, "packages", "server", "Dockerfile"), "utf8");
const fromCount = (dockerfile.match(/^FROM /gm) ?? []).length;
assert(fromCount >= 2, `Dockerfile 必须多阶段构建（当前 FROM 数=${fromCount}）`);
assert(dockerfile.includes("USER slock"), "Dockerfile 必须以非 root 用户 slock 运行");
assert(dockerfile.includes("HEALTHCHECK"), "Dockerfile 必须内置 HEALTHCHECK");
assert(dockerfile.includes("deploy --prod"), "Dockerfile 必须使用 pnpm deploy --prod 裁剪生产依赖");
assert(
  dockerfile.includes("packages/server/dist"),
  "Dockerfile 必须显式补拷 dist（.gitignore 会使其被 deploy 包文件收集跳过）",
);
assert(!/CMD \["pnpm"[^\]]*dev/.test(dockerfile), "Dockerfile CMD 禁止 pnpm dev（必须跑编译产物）");
assert(dockerfile.includes('CMD ["node", "dist/index.js"]'), "Dockerfile CMD 必须是 node dist/index.js");
assert(
  !dockerfile.includes("|| true") && !dockerfile.includes("|| pnpm install"),
  "Dockerfile 禁止容错降级写法（build 失败必须显式失败）",
);

// ---- 结果 ----
if (failures.length > 0) {
  console.error(`❌ 生产部署形态校验失败（${failures.length} 项）：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  "✅ 生产部署形态校验通过：compose（healthcheck/资源限制/必选密钥/无源码挂载）+ Dockerfile（多阶段/非 root/healthcheck/deploy --prod）",
);

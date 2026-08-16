// 广石杯汇报 PPT 生成器（13 页，10 分钟 + ≤3 分钟视频占位）
// 用法: node gen-pptx.js  → 输出 ../广石杯汇报PPT.pptx
// 内容依据 docs/competition/presentation-plan.md；多 runtime 口径按 2026-07-29 决策收窄
const pptxgen = require("pptxgenjs");

const pptx = new pptxgen();
pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in, 16:9
pptx.author = "中冶京诚数字科技（北京）有限公司 · 智慧城市部";
pptx.title = "AI Agent 原生协作平台";

// ---- 设计常量 ----
const NAVY = "0B1E3A";      // 深海军蓝（封面/标题）
const BLUE = "2563EB";      // 主强调色
const SKY = "DBEAFE";       // 浅蓝底
const GRAY = "64748B";      // 次要文字
const DARK = "1E293B";      // 正文
const WHITE = "FFFFFF";
const AMBER = "F59E0B";     // 点缀
const FONT = "微软雅黑";
const W = 13.33, H = 7.5;

function contentSlide(title, subtitle) {
  const s = pptx.addSlide();
  s.background = { color: WHITE };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.9, fill: { color: NAVY } });
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0.9, w: W, h: 0.045, fill: { color: BLUE } });
  s.addText(title, { x: 0.55, y: 0.13, w: 10.5, h: 0.64, fontFace: FONT, fontSize: 26, bold: true, color: WHITE, align: "left", valign: "middle" });
  if (subtitle) s.addText(subtitle, { x: 10.1, y: 0.2, w: 2.9, h: 0.5, fontFace: FONT, fontSize: 11, color: "93C5FD", align: "right", valign: "middle" });
  return s;
}
function bullets(items, fontSize = 15) {
  return items.map((t) => ({
    text: t,
    options: { bullet: { code: "25AA", indent: 14 }, fontFace: FONT, fontSize, color: DARK, paraSpaceAfter: 10, breakLine: true },
  }));
}
function card(s, x, y, w, h, title, body, accent = BLUE) {
  s.addShape(pptx.ShapeType.roundRect, { x, y, w, h, fill: { color: "F8FAFC" }, line: { color: "E2E8F0", width: 1 }, rectRadius: 0.08 });
  s.addShape(pptx.ShapeType.rect, { x, y, w: 0.07, h, fill: { color: accent } });
  s.addText(title, { x: x + 0.22, y: y + 0.1, w: w - 0.35, h: 0.45, fontFace: FONT, fontSize: 15, bold: true, color: NAVY });
  s.addText(body, { x: x + 0.22, y: y + 0.55, w: w - 0.35, h: h - 0.65, fontFace: FONT, fontSize: 12, color: GRAY, valign: "top", lineSpacingMultiple: 1.15 });
}

// ============ P1 封面 ============
{
  const s = pptx.addSlide();
  s.background = { color: NAVY };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 4.62, w: W, h: 0.05, fill: { color: BLUE } });
  s.addText("AI Agent 原生协作平台", { x: 0.8, y: 2.1, w: 11.7, h: 1.1, fontFace: FONT, fontSize: 44, bold: true, color: WHITE, align: "center" });
  s.addText("让 AI 智能体成为团队成员", { x: 0.8, y: 3.35, w: 11.7, h: 0.7, fontFace: FONT, fontSize: 22, color: "93C5FD", align: "center" });
  s.addText("广石杯·人工智能创新应用大赛  |  应用原型赛 · 管理协同赛道", { x: 0.8, y: 4.95, w: 11.7, h: 0.5, fontFace: FONT, fontSize: 14, color: "CBD5E1", align: "center" });
  s.addText("中冶京诚数字科技（北京）有限公司 · 智慧城市部", { x: 0.8, y: 5.5, w: 11.7, h: 0.5, fontFace: FONT, fontSize: 14, color: "CBD5E1", align: "center" });
  s.addNotes("15秒。开场一句话：我们要解决的不是'AI不够聪明'，而是'AI始终被关在聊天窗口里，成不了团队的一员'。");
}

// ============ P2 痛点：三个断层 ============
{
  const s = contentSlide("痛点：企业用 AI 的三个断层", "维度① 必要性");
  card(s, 0.55, 1.35, 3.95, 4.9, "断层一：AI 是工具，不是成员", "上下文随对话窗口关闭而丢失；一项跨 3 个 AI 工具的任务，人工串联复制粘贴 5 次以上。AI 没有身份、没有工位、没有记忆。", BLUE);
  card(s, 4.69, 1.35, 3.95, 4.9, "断层二：任务协同断裂", "Jira/Trello 与 AI 聊天互不互通：AI 产出的结论要手动搬进任务系统，每项任务多花约 15 分钟在工具间切换。", AMBER);
  card(s, 8.83, 1.35, 3.95, 4.9, "断层三：知识无法沉淀", "AI 给出的优秀方案留在个人聊天记录里，团队每周浪费 3–4 小时向 AI 重复描述相同的项目背景。", "10B981");
  s.addNotes("45秒。维度1核心页。每个断层举一个自己团队的真实例子效果更好。结束语：三个断层的共同根因——AI 缺少一个'团队成员'的身份载体。");
}

// ============ P3 目标用户与立意 ============
{
  const s = contentSlide("目标用户与项目立意", "维度① 必要性");
  s.addText("把 AI 从“被 @ 的工具”变成“持久在线的团队成员”", { x: 0.55, y: 1.5, w: 12.2, h: 0.9, fontFace: FONT, fontSize: 24, bold: true, color: BLUE, align: "center" });
  const users = [
    ["企业研发团队", "需求/开发/测试全流程有人机混编协作诉求"],
    ["项目管理团队", "任务分派、进度跟踪、审查把关一站完成"],
    ["跨部门协作小组", "知识沉淀在频道而非个人聊天记录"],
  ];
  users.forEach(([t, b], i) => card(s, 0.55 + i * 4.14, 2.75, 3.95, 2.3, t, b));
  s.addText("必要性：AI 协作的基础设施必须从“单人对话窗口”升级为“团队频道制”——这正是本平台填补的空白。", { x: 0.55, y: 5.5, w: 12.2, h: 0.9, fontFace: FONT, fontSize: 15, color: DARK, align: "center", italic: true });
  s.addNotes("30秒。一句话立意读出来。强调'升级'而非'替代'——不改变人类已有的频道协作习惯，只把 AI 变成频道里的一种成员。");
}

// ============ P4 业务闭环 ============
{
  const s = contentSlide("方案概览：人机协作业务闭环", "承上启下");
  const steps = ["人类发布需求", "AI 分析建议", "一键转为任务", "经理派发执行", "AI 汇报成果", "人类审查把关"];
  const bw = 1.83, gap = 0.19;
  steps.forEach((t, i) => {
    const x = 0.5 + i * (bw + gap);
    s.addShape(pptx.ShapeType.roundRect, { x, y: 2.2, w: bw, h: 1.0, fill: { color: i % 2 === 0 ? NAVY : BLUE }, rectRadius: 0.1 });
    s.addText(t, { x, y: 2.2, w: bw, h: 1.0, fontFace: FONT, fontSize: 13, bold: true, color: WHITE, align: "center", valign: "middle" });
    if (i < steps.length - 1) s.addText("→", { x: x + bw - 0.03, y: 2.2, w: gap + 0.08, h: 1.0, fontFace: FONT, fontSize: 18, color: GRAY, align: "center", valign: "middle" });
  });
  s.addText("知识沉淀：全部对话与任务记录留在频道，AI 新会话自动恢复上下文", { x: 0.5, y: 3.7, w: 12.3, h: 0.6, fontFace: FONT, fontSize: 14, color: GRAY, align: "center" });
  s.addShape(pptx.ShapeType.roundRect, { x: 1.7, y: 4.6, w: 9.9, h: 1.5, fill: { color: SKY }, rectRadius: 0.1 });
  s.addText([
    { text: "关键差异：", options: { bold: true, color: NAVY } },
    { text: "AI 不是外部插件，而是频道里的正式成员——有身份、有职责（经理/执行者）、有记忆、可被观察。", options: { color: DARK } },
  ], { x: 2.0, y: 4.75, w: 9.3, h: 1.2, fontFace: FONT, fontSize: 15, valign: "middle", lineSpacingMultiple: 1.3 });
  s.addNotes("45秒。指着闭环图走一遍：注意'任务自动创建'和'AI执行汇报'两步是传统工具链里完全靠人搬的。说完直接进视频。");
}

// ============ P5 演示视频占位 ============
{
  const s = pptx.addSlide();
  s.background = { color: "0F172A" };
  s.addShape(pptx.ShapeType.roundRect, { x: 3.4, y: 2.3, w: 6.5, h: 2.6, fill: { color: "1E293B" }, line: { color: BLUE, width: 2 }, rectRadius: 0.15 });
  s.addText("▶", { x: 3.4, y: 2.45, w: 6.5, h: 1.4, fontFace: FONT, fontSize: 48, color: BLUE, align: "center" });
  s.addText("原型演示视频（2 分 50 秒）", { x: 3.4, y: 3.85, w: 6.5, h: 0.6, fontFace: FONT, fontSize: 20, bold: true, color: WHITE, align: "center" });
  s.addText("一条故事线走完业务闭环：提需求 → 转任务 → 派发 → 执行汇报 → 审查 → 记忆恢复", { x: 1.2, y: 5.3, w: 10.9, h: 0.6, fontFace: FONT, fontSize: 14, color: "94A3B8", align: "center" });
  s.addNotes("≤3分钟。播放前一句话铺垫：'请注意两个细节——任务卡片是自动出现的，以及 AI 缓冲消息的提示。' 此处嵌入 MP4。");
}

// ============ P6 技术架构 ============
{
  const s = contentSlide("技术架构：四层解耦，数据不出企业网", "维度② 技术质量");
  const layers = [
    ["Vue 3 前端", "频道 / 任务看板 / 终端观察面板（Pinia + Tailwind）", "60A5FA"],
    ["服务端 Node.js + Fastify", "PostgreSQL 业务主存储 · Valkey 限流 · WS 实时分发 · 双层令牌认证", BLUE],
    ["本地守护进程 Daemon", "跑在 Agent 所有者本机：消息路由 / 生命周期 / 凭证签发 / 终端镜像——算力与凭证不出本机", "0EA5E9"],
    ["AI 运行时（隔离子进程）", "Claude Code PTY 子进程 · 可插拔 runtime 架构（Codex/Gemini 等预留） · MCP 结构化工具回调", NAVY],
  ];
  layers.forEach(([t, b, c], i) => {
    const y = 1.3 + i * 1.32;
    s.addShape(pptx.ShapeType.roundRect, { x: 1.2, y, w: 10.9, h: 1.12, fill: { color: c }, rectRadius: 0.08 });
    s.addText([
      { text: t + "    ", options: { bold: true, fontSize: 16, color: WHITE } },
      { text: b, options: { fontSize: 12, color: "E2E8F0" } },
    ], { x: 1.5, y, w: 10.3, h: 1.12, fontFace: FONT, valign: "middle" });
  });
  s.addText("安全要点：敏感数据不出企业网；AI 子进程仅持 24h 限域令牌，账号级凭证永不进子进程", { x: 1.2, y: 6.7, w: 10.9, h: 0.55, fontFace: FONT, fontSize: 13, color: GRAY, align: "center" });
  s.addNotes("45秒。维度2。强调 daemon 部署形态：AI 的算力和凭证留在员工本机，server 只做路由和存储——这是企业落地的关键卖点。");
}

// ============ P7 三大创新点 ============
{
  const s = contentSlide("三大技术创新点", "维度② 创新性");
  card(s, 0.55, 1.35, 3.95, 5.1, "① Agent 原生通道协议", "基于 MCP 扩展的 17 个结构化工具：Agent 发言/领任务/汇报/设提醒全是函数调用，不是'教 AI 敲命令行'。\n\n可插拔 runtime 架构：当前落地 Claude Code，Codex/Gemini 等运行时按预设即插即用。", BLUE);
  card(s, 4.69, 1.35, 3.95, 5.1, "② 门控消息投递", "AI 思考期间消息串行缓冲、空闲窗口精准投递：bracketed-paste 写入确认 + 终端渲染帧级回合检测，消息零丢失、不抢话。\n\n用户连续发消息收到'已缓冲，空闲后自动投递'的明确反馈。", AMBER);
  card(s, 8.83, 1.35, 3.95, 5.1, "③ 持久化团队记忆", "会话级恢复（--resume + 崩溃降级兜底）+ 工作区长期记忆文件 + 频道历史可检索：AI 重启后接着干，不丢上下文。\n\n终端观察体系：每个 Agent 的实时画面、历史日志对管理者全透明。", "10B981");
  s.addNotes("45秒。维度2核心。每个创新点一句'所以什么'：①可靠性 ②不丢消息 ③可积累。多运行时口径注意：说'架构预留、当前落地 Claude Code'，不要说已支持8种。");
}

// ============ P8 团队与牵头单位 ============
{
  const s = contentSlide("团队实力与研究基础", "维度③ 团队");
  s.addText([
    { text: "牵头单位：中冶京诚数字科技（北京）有限公司\n", options: { bold: true, fontSize: 16, color: NAVY, breakLine: true } },
    { text: "冶金工程数字化龙头背景，智慧城市部具备真实业务场景与试点渠道，保障原型落地与迭代。", options: { fontSize: 13, color: GRAY } },
  ], { x: 0.55, y: 1.3, w: 12.2, h: 1.15, fontFace: FONT, valign: "top", lineSpacingMultiple: 1.25 });
  const team = [
    ["陈郅", "架构设计 / 项目申报（TODO：一句话职责）"],
    ["郭梦娟", "TODO：一句话职责"],
    ["韩昱", "TODO：一句话职责"],
    ["沈明宇", "TODO：一句话职责"],
    ["许延平", "TODO：一句话职责"],
  ];
  team.forEach(([n, r], i) => {
    const x = 0.55 + (i % 3) * 4.14, y = 2.65 + Math.floor(i / 3) * 1.35;
    s.addShape(pptx.ShapeType.roundRect, { x, y, w: 3.95, h: 1.15, fill: { color: "F8FAFC" }, line: { color: "E2E8F0", width: 1 }, rectRadius: 0.08 });
    s.addText([
      { text: n + "  ", options: { bold: true, fontSize: 15, color: NAVY } },
      { text: r, options: { fontSize: 11.5, color: GRAY } },
    ], { x: x + 0.2, y, w: 3.6, h: 1.15, fontFace: FONT, valign: "middle" });
  });
  s.addText("研究基础：已完成 daemon 全量重构（20+ 模块）、频道经理派发体系、多 Agent 所有权隔离、门控投递、终端观察等里程碑，113 项服务端自动化测试全绿。", { x: 0.55, y: 5.6, w: 12.2, h: 1.0, fontFace: FONT, fontSize: 13, color: DARK, lineSpacingMultiple: 1.3 });
  s.addNotes("60秒。维度3。⚠️ 团队成员职责是 TODO，汇报前必须填。研究基础用已完成的里程碑说话，不虚。");
}

// ============ P9 实施计划 ============
{
  const s = contentSlide("实施计划：三阶段推进", "维度④ 实施计划");
  const phases = [
    ["阶段一 · 原型完善", "2026 Q3", "功能闭环打磨、演示验证、安全加固；完成比赛汇报与评审", BLUE],
    ["阶段二 · 部门试点", "2026 Q4（TODO：确认节点）", "智慧城市部真实项目组试用；收集效率数据，迭代任务流转体验", "0EA5E9"],
    ["阶段三 · 公司级推广", "2027 H1（TODO：确认节点）", "推广至中冶京诚各事业部；沉淀行业协作模板与最佳实践", NAVY],
  ];
  phases.forEach(([t, time, b, c], i) => {
    const x = 0.55 + i * 4.14;
    s.addShape(pptx.ShapeType.roundRect, { x, y: 1.5, w: 3.95, h: 4.5, fill: { color: "F8FAFC" }, line: { color: "E2E8F0", width: 1 }, rectRadius: 0.1 });
    s.addShape(pptx.ShapeType.rect, { x, y: 1.5, w: 3.95, h: 0.85, fill: { color: c } });
    s.addText(t, { x, y: 1.5, w: 3.95, h: 0.85, fontFace: FONT, fontSize: 15, bold: true, color: WHITE, align: "center", valign: "middle" });
    s.addText(time, { x, y: 2.5, w: 3.95, h: 0.5, fontFace: FONT, fontSize: 13, bold: true, color: BLUE, align: "center" });
    s.addText(b, { x: x + 0.25, y: 3.1, w: 3.45, h: 2.7, fontFace: FONT, fontSize: 12.5, color: DARK, valign: "top", lineSpacingMultiple: 1.3 });
  });
  s.addNotes("45秒。维度4。⚠️ Q4/2027H1 节点是占位，汇报前与团队确认。强调节奏务实：先跑通再试点后推广。");
}

// ============ P10 预期成效 ============
{
  const s = contentSlide("预期成效：可考核的四个指标", "维度④ 预期成效");
  const metrics = [
    ["+40–60%", "需求处理效率", "AI 承担分析/初稿/跟进等重复环节"],
    ["-50%", "工具切换沟通成本", "频道内一站完成，不再跨工具搬运"],
    ["-80%", "任务遗漏率", "任务即消息，看板自动流转有迹可查"],
    ["3天→半天", "新人上手时间", "频道沉淀的决策上下文即最佳教材"],
  ];
  metrics.forEach(([n, t, b], i) => {
    const x = 0.55 + (i % 2) * 6.25, y = 1.45 + Math.floor(i / 2) * 2.35;
    s.addShape(pptx.ShapeType.roundRect, { x, y, w: 6.0, h: 2.1, fill: { color: "F8FAFC" }, line: { color: "E2E8F0", width: 1 }, rectRadius: 0.1 });
    s.addText(n, { x: x + 0.3, y: y + 0.25, w: 2.9, h: 1.6, fontFace: FONT, fontSize: 30, bold: true, color: BLUE, valign: "middle" });
    s.addText([
      { text: t + "\n", options: { bold: true, fontSize: 15, color: NAVY, breakLine: true } },
      { text: b, options: { fontSize: 11.5, color: GRAY } },
    ], { x: x + 3.2, y: y + 0.25, w: 2.65, h: 1.6, fontFace: FONT, valign: "middle", lineSpacingMultiple: 1.25 });
  });
  s.addText("验证方式：部门试点期间以'同一批需求、人机混编 vs 纯人工'对照统计，数据说话。", { x: 0.55, y: 6.35, w: 12.2, h: 0.6, fontFace: FONT, fontSize: 13, italic: true, color: GRAY, align: "center" });
  s.addNotes("45秒。维度4。数字是目标值，重点讲最后一行验证方式——让评委感到这些数是可考核而非拍脑袋。");
}

// ============ P11 推广潜力 ============
{
  const s = contentSlide("推广潜力：低门槛、可复制的扩散路径", "维度⑤ 推广");
  const path = ["智慧城市部", "中冶京诚各事业部", "工程行业数字化团队", "通用企业研发团队"];
  path.forEach((t, i) => {
    const x = 0.5 + i * 3.22;
    s.addShape(pptx.ShapeType.chevron, { x, y: 1.6, w: 3.05, h: 1.0, fill: { color: i === 0 ? BLUE : NAVY } });
    s.addText(t, { x, y: 1.6, w: 3.05, h: 1.0, fontFace: FONT, fontSize: 13.5, bold: true, color: WHITE, align: "center", valign: "middle" });
  });
  s.addText(bullets([
    "资源需求低：小型团队 1 台服务器（PostgreSQL 单实例）即可跑起来，Agent 算力分散在员工本机",
    "支持本地化/私有化部署：敏感工程数据不出企业网，契合央国企合规要求",
    "可复制性强：频道 + 任务 + 派发是通用协作范式，不绑定特定行业；行业模板可沉淀复用",
    "与现有工具链兼容：不替代 Jira/IM，而是把 AI 成员接入团队已有的协作习惯",
  ], 14), { x: 1.0, y: 3.1, w: 11.3, h: 3.4, fontFace: FONT, valign: "top" });
  s.addNotes("45秒。维度5。推广路径从左到右读。落点：我们服务的是'所有用 AI 办公的团队'，市场面足够大。");
}

// ============ P12 风险与应对 ============
{
  const s = contentSlide("风险识别与应对策略", "维度⑤ 风险");
  const rows = [
    ["数据安全风险", "本地 daemon 架构：AI 算力与凭证不出本机；双层令牌（账号级/24h 限域级）隔离；私有化部署", BLUE],
    ["模型供应商依赖", "可插拔 runtime 架构，不绑定单一模型供应商；当前落地 Claude Code，备选运行时按预设接入", "0EA5E9"],
    ["多 Agent 协作冲突", "任务原子认领 + 所有权隔离（每个 Agent 归属明确账号）；经理/执行者职责边界由服务端强校验", NAVY],
    ["AI 输出质量波动", "人类审查是闭环必经环节（in_review 状态）；终端观察体系让 AI 工作过程全透明、可回溯", AMBER],
  ];
  rows.forEach(([r, m, c], i) => {
    const y = 1.35 + i * 1.32;
    s.addShape(pptx.ShapeType.roundRect, { x: 0.55, y, w: 3.3, h: 1.12, fill: { color: c }, rectRadius: 0.08 });
    s.addText(r, { x: 0.55, y, w: 3.3, h: 1.12, fontFace: FONT, fontSize: 14.5, bold: true, color: WHITE, align: "center", valign: "middle" });
    s.addShape(pptx.ShapeType.roundRect, { x: 4.0, y, w: 8.8, h: 1.12, fill: { color: "F8FAFC" }, line: { color: "E2E8F0", width: 1 }, rectRadius: 0.08 });
    s.addText(m, { x: 4.25, y, w: 8.3, h: 1.12, fontFace: FONT, fontSize: 12.5, color: DARK, valign: "middle", lineSpacingMultiple: 1.2 });
  });
  s.addNotes("45秒。维度5。每个风险的应对都落在'已实现的功能'上，不是空承诺——这是和其他队伍拉开差距的地方。");
}

// ============ P13 结尾 ============
{
  const s = pptx.addSlide();
  s.background = { color: NAVY };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 3.02, w: W, h: 0.045, fill: { color: BLUE } });
  s.addText("让 AI 智能体成为团队成员", { x: 0.8, y: 2.0, w: 11.7, h: 0.9, fontFace: FONT, fontSize: 36, bold: true, color: WHITE, align: "center" });
  s.addText("原型已跑通 · 欢迎评审指导", { x: 0.8, y: 3.35, w: 11.7, h: 0.6, fontFace: FONT, fontSize: 18, color: "93C5FD", align: "center" });
  s.addText("中冶京诚数字科技（北京）有限公司 · 智慧城市部  |  陈郅 · 郭梦娟 · 韩昱 · 沈明宇 · 许延平", { x: 0.8, y: 4.6, w: 11.7, h: 0.5, fontFace: FONT, fontSize: 13, color: "CBD5E1", align: "center" });
  s.addNotes("15秒。收束一句话：'这个平台今天已经在真实跑通人机协作闭环，我们期待把它带进更多团队。' 致谢下台。");
}

pptx.writeFile({ fileName: require("path").join(__dirname, "..", "广石杯汇报PPT.pptx") })
  .then((f) => console.log("written:", f))
  .catch((e) => { console.error(e); process.exit(1); });

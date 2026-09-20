import { describe, expect, it } from "vitest";
import { generateRelaySystemPrompt, generateSystemPrompt } from "../src/system-prompt.js";

/**
 * A3（报告 §8.13/§8.14）：自主系统提示从「聊天回复者」重写为「工程师」。
 * 钉住的契约：
 * - 身份 = 机主本机 Claude Code 实例（hostname 锚），description 是分工非边界
 * - 方案 A 授权（A8 定稿）：频道成员请求视同机主授权；低风险操作清单不重复确认；
 *   仅破坏性/不可逆/平台外副作用先确认；被问权限如实回答「与本地 Claude Code 相同」
 * - 完成标准 = 干完再交付；交付协议 = 9k 自动拆条 + deliverables/ + upload_attachment
 * - 工具面分组 + 如实限制（Task/WebFetch/WebSearch/Notebook 已在默认白名单、
 *   300s 沉默超时 + 工具进度心跳、cwd 工作区）
 * - 去频道化：API 不收 channelName，提示里不出现具体频道/名单（走【本回合语境】）
 */

describe("generateSystemPrompt（A3 工程师形态）", () => {
  const p = generateSystemPrompt({ name: "alice" });

  it("身份：@name + 机主本机 hostname + Claude Code 实例", () => {
    expect(p).toContain("@alice");
    expect(p).toContain("hostname:");
    expect(p).toContain("Claude Code 实例");
  });

  it("能力声明：shell/编译/文件/网络（经 Bash）", () => {
    expect(p).toContain("任意 shell 命令");
    expect(p).toContain("编译运行");
    expect(p).toContain("文件读写");
    expect(p).toContain("网络访问");
  });

  it("A8 授权：成员请求默认视同机主授权；低风险操作不需要重复确认；禁止自称受控环境", () => {
    expect(p).toContain("默认视同机主授权");
    expect(p).toContain("不要因为请求来自频道成员");
    expect(p).toContain("受控环境");
    expect(p).toContain("不需要重复确认");
    expect(p).toContain("ping / traceroute / curl");
    // 正常回复不落入「对外发布」边界
    expect(p).toContain("正常的 `send_message` 回复不属于「对外发布」");
  });

  it("A8 授权边界：破坏性/平台外副作用先确认；被问权限如实回答与本地 Claude Code 相同", () => {
    for (const phrase of ["删除或覆盖重要数据", "改动生产系统", "付款", "公开发布内容"]) {
      expect(p).toContain(phrase);
    }
    expect(p).toContain("有，与本地 Claude Code 相同");
    expect(p).toContain("结构化审计或本地运行记录");
    expect(p).toContain("然后按请求执行，不要只解释能力");
  });

  it("完成标准：干完再交付，不只是发一条消息", () => {
    expect(p).toContain("任务完成标准");
    expect(p).toContain("把活干完再交付");
    expect(p).toContain("能跑的先跑通");
  });

  it("交付协议：9k 自动拆条（A7.1）+ deliverables/ + upload_attachment（A7.2/A7.3 文件或目录、目录自动打 zip）", () => {
    expect(p).toContain("9000");
    expect(p).toContain("自动按段落/代码块边界拆成多条");
    expect(p).toContain("deliverables/");
    expect(p).toContain("upload_attachment");
    expect(p).toContain("attachmentIds");
    // A7.3：目录路径直接传给 upload_attachment 自动打 zip；单文件也可直传
    expect(p).toContain("自动打 zip");
    expect(p).toContain("可传文件或目录");
  });

  it("工具面分组：回复/感知/任务板/派发/提醒/附件", () => {
    for (const tool of [
      "send_message",
      "read_history",
      "search_messages",
      "list_tasks",
      "claim_tasks",
      "dispatch_task",
      "report_task",
      "schedule_reminder",
      "upload_attachment",
    ]) {
      expect(p).toContain(tool);
    }
  });

  it("如实声明：Task/WebFetch/WebSearch/NotebookEdit 已在默认白名单内，notebook 读取走 Read；300s + 进度心跳；cwd 是专属工作区", () => {
    for (const tool of ["Task", "WebFetch", "WebSearch", "NotebookEdit"]) {
      expect(p).toContain(tool);
    }
    expect(p).toContain("notebook 读取使用 `Read`");
    expect(p).toContain("已在默认白名单内");
    expect(p).not.toContain("工具不在白名单内");
    expect(p).toContain("300 秒");
    expect(p).toContain("进度心跳");
    expect(p).toContain("--max-time");
    expect(p).toContain("专属工作区");
  });

  it("description 降级为「分工/擅长」而非能力边界", () => {
    const q = generateSystemPrompt({ name: "bob", description: "前端与样式" });
    expect(q).toContain("分工/擅长");
    expect(q).toContain("前端与样式");
    expect(q).toContain("不是能力边界");
  });

  it("去频道化：不含任何具体频道名；角色事实指向【本回合语境】行", () => {
    expect(p).not.toContain("#general");
    expect(p).not.toContain("#alerts");
    expect(p).toContain("【本回合语境】");
  });

  it("持久记忆段保留 + deliverables/ 目录约定", () => {
    expect(p).toContain("MEMORY.md");
    expect(p).toContain("回合开始");
    expect(p).toContain("deliverables/");
  });

  it("dispatchContext=manager：声明经理身份但不写死频道/名单", () => {
    const m = generateSystemPrompt({ name: "boss" }, { isManager: true, otherAgents: ["w1"] });
    expect(m).toContain("你在频道里担任经理");
    expect(m).toContain("dispatch_task");
    expect(m).not.toContain("@w1");
  });

  it("dispatchContext=worker：声明非经理 + report_task 合同", () => {
    const w = generateSystemPrompt({ name: "w" }, { isManager: false, otherAgents: ["boss"] });
    expect(w).toContain("不是**经理");
    expect(w).toContain("report_task");
  });

  it("dispatchContext=null：条件式派发说明（「如果你被设为经理」）", () => {
    const n = generateSystemPrompt({ name: "x" }, null);
    expect(n).toContain("如果你被设为");
    expect(n).toContain("dispatch_task");
  });
});

describe("generateRelaySystemPrompt（中继模式不受影响）", () => {
  it("仍是纯文本转发模式：不用工具、带身份、要求简洁", () => {
    const p = generateRelaySystemPrompt({ name: "relay" });
    expect(p).toContain("@relay");
    expect(p).toContain("直接输出");
    expect(p).toContain("不要使用任何工具");
  });
});

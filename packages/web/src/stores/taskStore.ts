import { create } from "zustand";
import type { Message, TaskStatus } from "@collabagent/shared";

interface Task extends Message {
  taskNumber: number;
  taskStatus: TaskStatus;
  taskAssigneeId?: string;
  taskAssigneeType?: "human" | "agent";
}

interface TaskState {
  tasksByChannel: Record<string, Task[]>;
  loading: boolean;

  fetchTasks: (channel: string, status?: TaskStatus) => Promise<void>;
  createTasks: (channel: string, titles: string[]) => Promise<void>;
  claimTasks: (channel: string, numbers: number[]) => Promise<void>;
  unclaimTask: (channel: string, number: number) => Promise<void>;
  updateStatus: (channel: string, number: number, status: TaskStatus) => Promise<void>;
  moveTask: (channel: string, number: number, newStatus: TaskStatus) => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasksByChannel: {},
  loading: false,

  fetchTasks: async (channel, status) => {
    set({ loading: true });
    const params = new URLSearchParams({ channel });
    if (status) params.set("status", status);
    const res = await fetch(`/api/tasks?${params}`);
    const data = await res.json();
    set((s) => ({
      tasksByChannel: { ...s.tasksByChannel, [channel]: data.tasks },
      loading: false,
    }));
  },

  createTasks: async (channel, titles) => {
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, tasks: titles.map((t) => ({ title: t })) }),
    });
    if (!res.ok) throw new Error("Create tasks failed");
    await get().fetchTasks(channel);
  },

  claimTasks: async (channel, numbers) => {
    const res = await fetch("/api/tasks/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, task_numbers: numbers }),
    });
    if (!res.ok) throw new Error("Claim failed");
    await get().fetchTasks(channel);
  },

  unclaimTask: async (channel, number) => {
    await fetch("/api/tasks/unclaim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, task_number: number }),
    });
    await get().fetchTasks(channel);
  },

  updateStatus: async (channel, number, status) => {
    const res = await fetch(`/api/tasks/${number}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, status }),
    });
    if (!res.ok) throw new Error("Update status failed");
    await get().fetchTasks(channel);
  },

  // 乐观更新：拖拽时立即移动，异步确认
  moveTask: (channel, number, newStatus) => {
    set((s) => {
      const tasks = s.tasksByChannel[channel] || [];
      const updated = tasks.map((t) =>
        t.taskNumber === number ? { ...t, taskStatus: newStatus } : t
      );
      return { tasksByChannel: { ...s.tasksByChannel, [channel]: updated } };
    });
    get().updateStatus(channel, number, newStatus).catch(() => {
      get().fetchTasks(channel); // 失败回滚
    });
  },
}));

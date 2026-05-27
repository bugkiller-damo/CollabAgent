import { create } from "zustand";
import { apiGet, apiPost } from "../api/client";
import type { Message, TaskStatus } from "@collabagent/shared";

export interface Task extends Message {
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
    const params: Record<string, string> = { channel };
    if (status) params.status = status;
    try {
      const data = await apiGet<{ tasks: Task[] }>("/api/tasks", params);
      set((s) => ({ tasksByChannel: { ...s.tasksByChannel, [channel]: data.tasks || [] }, loading: false }));
    } catch { set({ loading: false }); }
  },

  createTasks: async (channel, titles) => {
    await apiPost("/api/tasks", { channel, tasks: titles.map((t) => ({ title: t })) });
    await get().fetchTasks(channel);
  },

  claimTasks: async (channel, numbers) => {
    await apiPost("/api/tasks/claim", { channel, task_numbers: numbers });
    await get().fetchTasks(channel);
  },

  unclaimTask: async (channel, number) => {
    await apiPost("/api/tasks/unclaim", { channel, task_number: number });
    await get().fetchTasks(channel);
  },

  updateStatus: async (channel, number, status) => {
    await apiPost(`/api/tasks/${number}/status`, { channel, status });
    await get().fetchTasks(channel);
  },

  moveTask: (channel, number, newStatus) => {
    set((s) => {
      const tasks = s.tasksByChannel[channel] || [];
      return { tasksByChannel: { ...s.tasksByChannel, [channel]: tasks.map((t) => t.taskNumber === number ? { ...t, taskStatus: newStatus } : t) } };
    });
    get().updateStatus(channel, number, newStatus).catch(() => get().fetchTasks(channel));
  },
}));

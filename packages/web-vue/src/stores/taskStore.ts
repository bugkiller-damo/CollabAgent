import type { Message, TaskStatus } from "@collabagent/shared";
import { defineStore } from "pinia";
import { ref } from "vue";
import { apiGet, apiPost } from "../api";

export interface Task extends Message {
  taskNumber: number;
  taskStatus: TaskStatus;
  taskAssigneeId?: string;
  taskAssigneeType?: "human" | "agent";
}

export const useTaskStore = defineStore("tasks", () => {
  const tasksByChannel = ref<Record<string, Task[]>>({});
  const loading = ref(false);

  async function fetchTasks(channel: string, status?: TaskStatus): Promise<void> {
    loading.value = true;
    const params: Record<string, string> = { channel };
    if (status) params.status = status;
    try {
      const data = await apiGet<{ tasks: Task[] }>("/api/tasks", params);
      tasksByChannel.value = { ...tasksByChannel.value, [channel]: data.tasks || [] };
      loading.value = false;
    } catch {
      loading.value = false;
    }
  }

  async function createTasks(channel: string, titles: string[]): Promise<void> {
    await apiPost("/api/tasks", { channel, tasks: titles.map((t) => ({ title: t })) });
    await fetchTasks(channel);
  }

  async function claimTasks(channel: string, numbers: number[]): Promise<void> {
    await apiPost("/api/tasks/claim", { channel, task_numbers: numbers });
    await fetchTasks(channel);
  }

  async function unclaimTask(channel: string, number: number): Promise<void> {
    await apiPost("/api/tasks/unclaim", { channel, task_number: number });
    await fetchTasks(channel);
  }

  async function updateStatus(channel: string, number: number, status: TaskStatus): Promise<void> {
    await apiPost(`/api/tasks/${number}/status`, { channel, status });
    await fetchTasks(channel);
  }

  function moveTask(channel: string, number: number, newStatus: TaskStatus): void {
    const tasks = tasksByChannel.value[channel] || [];
    tasksByChannel.value = {
      ...tasksByChannel.value,
      [channel]: tasks.map((t) => (t.taskNumber === number ? { ...t, taskStatus: newStatus } : t)),
    };
    // 乐观更新后后台同步；失败则重新拉取回滚
    updateStatus(channel, number, newStatus).catch(() => fetchTasks(channel));
  }

  return { tasksByChannel, loading, fetchTasks, createTasks, claimTasks, unclaimTask, updateStatus, moveTask };
});

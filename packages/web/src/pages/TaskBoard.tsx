import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { apiGet, apiPost } from "../api/client";
import { useChannelStore } from "../stores";
import { toast } from "../stores/toastStore";
import { PageHeader } from "../components/layout/PageHeader";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";

interface Task {
  id: string;
  content: string;
  task_number: number;
  task_status: string;
  task_assignee: string | null;
  assignee_handle: string | null;
  creator_name: string;
}

const COLUMNS: { status: string; label: string; tint: string }[] = [
  { status: "todo", label: "待办", tint: "border-t-gray-400" },
  { status: "in_progress", label: "进行中", tint: "border-t-blue-500" },
  { status: "in_review", label: "审查中", tint: "border-t-amber-500" },
  { status: "done", label: "已完成", tint: "border-t-green-500" },
];

export function TaskBoard() {
  const { channelName } = useParams<{ channelName: string }>();
  const navigate = useNavigate();
  const channels = useChannelStore((s) => s.channels);
  const activeChannelName = useChannelStore((s) => s.activeChannelName);

  const [channel, setChannel] = useState<string>("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [dragNum, setDragNum] = useState<number | null>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);

  useEffect(() => {
    const pick = channelName || activeChannelName || (channels[0] as any)?.name || "";
    if (pick && pick !== channel) setChannel(pick);
  }, [channelName, activeChannelName, channels, channel]);

  const load = useCallback(() => {
    if (!channel) return;
    setLoading(true);
    apiGet<{ tasks: Task[] }>("/api/tasks", { channel: "#" + channel })
      .then((d) => { setTasks(d.tasks || []); setLoading(false); })
      .catch(() => { setTasks([]); setLoading(false); });
  }, [channel]);

  useEffect(() => { load(); }, [load]);

  const createTask = async () => {
    const t = newTitle.trim();
    if (!t || !channel) return;
    setNewTitle("");
    try {
      await apiPost("/api/tasks", { channel: "#" + channel, tasks: [{ title: t }] });
      load();
    } catch (err: any) {
      toast.error(err?.message || "创建失败");
    }
  };

  const claim = async (num: number) => {
    try {
      await apiPost("/api/tasks/claim", { channel: "#" + channel, task_numbers: [num] });
      load();
    } catch (err: any) {
      toast.error(err?.message || "认领失败");
    }
  };

  const moveTo = async (num: number, status: string) => {
    try {
      await apiPost("/api/tasks/update-status", { channel: "#" + channel, number: num, status });
      load();
    } catch (err: any) {
      toast.error(err?.message || "移动失败");
    }
  };

  const onDrop = (status: string) => {
    setDragOverCol(null);
    if (dragNum == null) return;
    const task = tasks.find((t) => t.task_number === dragNum);
    setDragNum(null);
    if (task && task.task_status !== status) moveTo(dragNum, status);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="任务看板" backTo={`/channels/${channel}`}
        breadcrumb={channel ? [{ label: `#${channel}`, to: `/channels/${channel}` }, { label: "任务看板" }] : undefined}
      >
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={channel}
            onChange={(e) => { setChannel(e.target.value); navigate("/tasks/" + e.target.value); }}
            className="rounded-md border border-gray-300 bg-gray-100 px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
          >
            {channels.map((c: any) => <option key={c.id} value={c.name}>#{c.name}</option>)}
          </select>
          <Input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createTask(); }}
            placeholder="新建任务标题…"
            className="w-56"
          />
          <Button onClick={createTask} disabled={!newTitle.trim()} size="sm">+ 新建</Button>
        </div>
      </PageHeader>

      <div className="grid flex-1 grid-cols-1 content-start gap-4 overflow-y-auto p-4 sm:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((col) => {
          const colTasks = tasks.filter((t) => t.task_status === col.status);
          return (
            <div
              key={col.status}
              onDragOver={(e) => { e.preventDefault(); setDragOverCol(col.status); }}
              onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOverCol(null); }}
              onDrop={() => onDrop(col.status)}
              className={[
                "min-w-0 rounded-lg border-t-4 bg-gray-100 p-3 dark:bg-gray-800",
                col.tint,
                dragOverCol === col.status ? "ring-2 ring-blue-400" : "",
              ].join(" ")}
            >
              <h3 className="mb-3 flex items-center justify-between font-semibold text-gray-700 dark:text-gray-300">
                {col.label}
                <span className="text-xs text-gray-400">{colTasks.length}</span>
              </h3>
              <div className="min-h-[40px] space-y-2">
                {colTasks.map((t) => (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={() => setDragNum(t.task_number)}
                    onDragEnd={() => { setDragNum(null); setDragOverCol(null); }}
                    className="cursor-grab rounded border border-gray-200 bg-white p-2.5 shadow-sm active:cursor-grabbing dark:border-gray-600 dark:bg-gray-700"
                  >
                    <div className="flex items-start gap-2">
                      <span className="shrink-0 text-xs text-gray-400">#{t.task_number}</span>
                      <p className="flex-1 text-sm text-gray-800 dark:text-gray-200">{t.content}</p>
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      {t.assignee_handle
                        ? <span className="text-[11px] text-blue-600 dark:text-blue-400">@{t.assignee_handle}</span>
                        : <button onClick={() => claim(t.task_number)} className="text-[11px] text-gray-500 hover:text-blue-500">认领</button>}
                      <select
                        value={t.task_status}
                        onChange={(e) => moveTo(t.task_number, e.target.value)}
                        className="rounded border border-gray-200 bg-transparent px-1 text-[11px] text-gray-500 dark:border-gray-600 dark:text-gray-400"
                      >
                        {COLUMNS.map((c) => <option key={c.status} value={c.status}>{c.label}</option>)}
                        <option value="closed">已关闭</option>
                      </select>
                    </div>
                  </div>
                ))}
                {!loading && colTasks.length === 0 && (
                  <p className="py-2 text-center text-xs text-gray-400">拖到此处</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

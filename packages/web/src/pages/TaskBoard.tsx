import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { apiGet, apiPost } from "../api/client";
import { useChannelStore } from "../stores";

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

  // 选定频道：路由参数 > 当前活动频道 > 第一个频道
  useEffect(() => {
    const pick = channelName || activeChannelName || (channels[0] as any)?.name || "";
    if (pick && pick !== channel) setChannel(pick);
  }, [channelName, activeChannelName, channels]);

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
    try { await apiPost("/api/tasks", { channel: "#" + channel, tasks: [{ title: t }] }); load(); }
    catch (err: any) { alert(err?.message || "创建失败"); }
  };

  const claim = async (num: number) => {
    try { await apiPost("/api/tasks/claim", { channel: "#" + channel, task_numbers: [num] }); load(); }
    catch (err: any) { alert(err?.message || "认领失败"); }
  };

  const moveTo = async (num: number, status: string) => {
    try { await apiPost("/api/tasks/update-status", { channel: "#" + channel, number: num, status }); load(); }
    catch (err: any) { alert(err?.message || "移动失败"); }
  };

  const onDrop = (status: string) => {
    setDragOverCol(null);
    if (dragNum == null) return;
    const task = tasks.find((t) => t.task_number === dragNum);
    setDragNum(null);
    if (task && task.task_status !== status) moveTo(dragNum, status);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex items-center gap-3 flex-wrap">
        <h2 className="text-gray-900 dark:text-white font-bold">任务看板</h2>
        <select value={channel} onChange={(e) => { setChannel(e.target.value); navigate("/tasks/" + e.target.value); }}
          className="p-1.5 rounded text-sm bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600">
          {channels.map((c: any) => <option key={c.id} value={c.name}>#{c.name}</option>)}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createTask(); }}
            placeholder="新建任务标题…"
            className="p-1.5 rounded text-sm bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600 w-56" />
          <button onClick={createTask} disabled={!newTitle.trim()}
            className="px-3 py-1.5 rounded text-sm bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">+ 新建</button>
        </div>
      </div>

      <div className="flex-1 p-4 flex gap-4 overflow-x-auto">
        {COLUMNS.map((col) => {
          const colTasks = tasks.filter((t) => t.task_status === col.status);
          return (
            <div key={col.status}
              onDragOver={(e) => { e.preventDefault(); setDragOverCol(col.status); }}
              onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOverCol(null); }}
              onDrop={() => onDrop(col.status)}
              className={"flex-1 min-w-64 rounded-lg p-3 border-t-4 " + col.tint + " bg-gray-100 dark:bg-gray-800 " +
                (dragOverCol === col.status ? "ring-2 ring-blue-400" : "")}>
              <h3 className="text-gray-700 dark:text-gray-300 font-semibold mb-3 flex items-center justify-between">
                {col.label}<span className="text-gray-400 text-xs">{colTasks.length}</span>
              </h3>
              <div className="space-y-2 min-h-[40px]">
                {colTasks.map((t) => (
                  <div key={t.id} draggable
                    onDragStart={() => setDragNum(t.task_number)}
                    onDragEnd={() => { setDragNum(null); setDragOverCol(null); }}
                    className="bg-white dark:bg-gray-700 rounded p-2.5 shadow-sm cursor-grab active:cursor-grabbing border border-gray-200 dark:border-gray-600">
                    <div className="flex items-start gap-2">
                      <span className="text-gray-400 text-xs shrink-0">#{t.task_number}</span>
                      <p className="text-gray-800 dark:text-gray-200 text-sm flex-1">{t.content}</p>
                    </div>
                    <div className="flex items-center justify-between mt-2">
                      {t.assignee_handle
                        ? <span className="text-[11px] text-blue-600 dark:text-blue-400">@{t.assignee_handle}</span>
                        : <button onClick={() => claim(t.task_number)} className="text-[11px] text-gray-500 hover:text-blue-500">认领</button>}
                      <select value={t.task_status} onChange={(e) => moveTo(t.task_number, e.target.value)}
                        className="text-[11px] bg-transparent text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-600 rounded px-1">
                        {COLUMNS.map((c) => <option key={c.status} value={c.status}>{c.label}</option>)}
                        <option value="closed">已关闭</option>
                      </select>
                    </div>
                  </div>
                ))}
                {!loading && colTasks.length === 0 && (
                  <p className="text-gray-400 text-xs text-center py-2">拖到此处</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

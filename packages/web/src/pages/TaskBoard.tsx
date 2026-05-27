import type { TaskStatus } from "@collabagent/shared";

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "todo", label: "待办" },
  { status: "in_progress", label: "进行中" },
  { status: "in_review", label: "审查中" },
  { status: "done", label: "已完成" },
];

export function TaskBoard() {
  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-gray-700">
        <h2 className="text-white font-bold">任务看板</h2>
      </div>
      <div className="flex-1 p-4 flex gap-4 overflow-x-auto">
        {COLUMNS.map((col) => (
          <div key={col.status} className="flex-1 min-w-60 bg-gray-800 rounded-lg p-3">
            <h3 className="text-gray-300 font-semibold mb-3">{col.label}</h3>
            <div className="space-y-2">
              <p className="text-gray-500 text-sm">拖拽任务到此处</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

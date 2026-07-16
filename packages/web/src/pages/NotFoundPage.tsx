import { useNavigate } from "react-router-dom";
import { EmptyState } from "../components/EmptyState";

export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <div className="flex items-center justify-center min-h-[80vh]">
      <EmptyState
        icon="🔍"
        title="页面未找到"
        description="你访问的页面不存在或已被移动。"
        actionLabel="返回主聊天"
        onAction={() => navigate("/channels/general", { replace: true })}
      />
    </div>
  );
}

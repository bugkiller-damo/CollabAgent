import { Component, type ReactNode } from "react";

interface Props { children: ReactNode; }
interface State { hasError: boolean; error?: Error; }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error("[ErrorBoundary] Caught:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full py-16 px-4 text-center bg-gray-50 dark:bg-gray-900">
          <div className="text-5xl mb-4">⚠️</div>
          <h2 className="text-gray-800 dark:text-white font-bold text-lg mb-2">页面遇到问题</h2>
          <p className="text-gray-500 dark:text-gray-400 text-sm max-w-md mb-1">{this.state.error?.message || "未知错误"}</p>
          <p className="text-gray-400 dark:text-gray-600 text-xs mb-4">刷新或点击下方按钮重试</p>
          <div className="flex gap-2">
            <button onClick={() => this.setState({ hasError: false })}
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-500 text-sm">重试</button>
            <button onClick={() => window.location.reload()}
              className="bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-500 text-sm">刷新页面</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

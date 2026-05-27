import { Outlet } from "react-router-dom";

export function AppLayout() {
  return (
    <div className="flex h-screen bg-gray-900">
      <aside className="w-64 bg-gray-800 border-r border-gray-700 p-4">
        <h1 className="text-white font-bold mb-4">CollabAgent</h1>
        <nav className="space-y-1">
          <a href="/channels/general" className="block text-gray-300 hover:text-white p-2 rounded hover:bg-gray-700">
            # general
          </a>
        </nav>
      </aside>
      <main className="flex-1 flex flex-col">
        <Outlet />
      </main>
    </div>
  );
}

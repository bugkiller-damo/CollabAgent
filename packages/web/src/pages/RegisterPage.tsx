export function RegisterPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900">
      <div className="bg-gray-800 p-8 rounded-lg w-96">
        <h1 className="text-white text-2xl font-bold mb-6">注册</h1>
        <form className="space-y-4">
          <input type="text" placeholder="用户名" className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600" />
          <input type="email" placeholder="邮箱" className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600" />
          <input type="password" placeholder="密码" className="w-full p-2 rounded bg-gray-700 text-white border border-gray-600" />
          <button type="submit" className="w-full bg-blue-600 text-white p-2 rounded hover:bg-blue-700">注册</button>
        </form>
        <p className="text-gray-400 mt-4 text-sm text-center">
          已有账号？<a href="/login" className="text-blue-400">登录</a>
        </p>
      </div>
    </div>
  );
}

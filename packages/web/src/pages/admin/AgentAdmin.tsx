import { useState, useEffect } from 'react';
import { apiGet, apiPost } from '../../api/client';
import { useAgentStore } from '../../stores/agentStore';

interface Agent {
  id: string; name: string; displayName?: string;
  status: string; model?: string; runtime?: string;
}

export function AgentAdmin() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState('');
  const [model, setModel] = useState('claude');
  const [msg, setMsg] = useState('');
  const liveAgents = useAgentStore(s => s.agents);

  const load = async () => {
    try { const d = await apiGet<{agents:Agent[]}>('/api/agents'); setAgents(d.agents||[]); } catch {}
  };

  useEffect(() => { load(); }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if(!name.trim())return;
    try {
      await apiPost('/api/agents',{name:name.trim(),model,runtime:'claude'});
      setName('');setMsg('Agent 已创建，daemon 正在启动...');
      load();
    } catch(err:any) { setMsg(err.message||'创建失败'); }
  };

  const toggleStatus = async (agent: Agent) => {
    const newStatus = agent.status === 'active' ? 'inactive' : 'active';
    try {
      await apiPost('/api/agents/'+agent.id,{status:newStatus});
      load();
    } catch {}
  };

  const statusColor = (s: string) => {
    const live = liveAgents[Object.keys(liveAgents).find(k => k.includes('agent')) || ''];
    if (live && (live.status === 'thinking' || live.status === 'working')) return 'bg-yellow-400 animate-pulse';
    if (s === 'active') return 'bg-green-500';
    return 'bg-gray-500';
  };

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-white text-xl font-bold">Agent 管理</h2>
      
      {/* Create form */}
      <form onSubmit={create} className="bg-gray-800 rounded-lg p-4 flex gap-3 items-end">
        <div>
          <label className="text-gray-400 text-sm block mb-1">Agent 名称</label>
          <input value={name} onChange={e=>setName(e.target.value)} placeholder="my-agent"
            className="p-2 rounded bg-gray-700 text-white border border-gray-600 w-48" />
        </div>
        <div>
          <label className="text-gray-400 text-sm block mb-1">模型</label>
          <select value={model} onChange={e=>setModel(e.target.value)}
            className="p-2 rounded bg-gray-700 text-white border border-gray-600">
            <option value="claude">Claude</option>
            <option value="deepseek">DeepSeek</option>
            <option value="openai">OpenAI</option>
          </select>
        </div>
        <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
          创建 Agent
        </button>
        {msg && <span className="text-green-400 text-sm">{msg}</span>}
      </form>

      {/* Agent list */}
      <div className="space-y-2">
        {agents.map(a => (
          <div key={a.id} className="bg-gray-800 rounded-lg p-4 flex items-center gap-4">
            <span className={"w-3 h-3 rounded-full "+statusColor(a.status)} />
            <div className="flex-1 min-w-0">
              <div className="text-white font-medium">@{a.name}</div>
              <div className="text-gray-500 text-xs">{a.model||'claude'} · {a.status}</div>
            </div>
            <button onClick={()=>toggleStatus(a)}
              className={"px-3 py-1 rounded text-xs "+(a.status==='active'?'bg-red-600 hover:bg-red-700':'bg-green-600 hover:bg-green-700')}>
              {a.status==='active'?'停止':'启动'}
            </button>
          </div>
        ))}
        {agents.length===0 && <p className="text-gray-500 text-sm">暂无 Agent，创建一个开始</p>}
      </div>
    </div>
  );
}

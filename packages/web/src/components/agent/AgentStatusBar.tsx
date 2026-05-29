import { useAgentStore } from "../../stores/agentStore";
const COLORS: Record<string,string>={online:"bg-green-500",offline:"bg-gray-500",thinking:"bg-yellow-400 animate-pulse",working:"bg-blue-400 animate-pulse",idle:"bg-green-500/50"};
const LABELS: Record<string,string>={online:"在线",offline:"离线",thinking:"思考中",working:"工作中",idle:"空闲"};
export function AgentStatusBar(){
const agents=useAgentStore(s=>s.agents);
const list=Object.values(agents);
if(list.length===0)return null;
return (<div className="border-t border-gray-700 p-2"><div className="text-gray-500 text-xs font-semibold uppercase px-2 py-1">Agent</div>
{list.map(a=>(<div key={a.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-700/50"><span className={"w-2 h-2 rounded-full shrink-0 "+COLORS[a.status]}/><div className="min-w-0 flex-1"><div className="text-gray-300 text-xs font-medium truncate">{a.name}</div><div className="text-gray-500 text-[10px] truncate">{LABELS[a.status]}{a.detail?" · "+a.detail.slice(0,24):""}</div></div></div>))}</div>);
}
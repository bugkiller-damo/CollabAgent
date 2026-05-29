export function ThinkingIndicator({agentName,text}:{agentName:string;text:string}){
return (<div className="flex items-center gap-2 px-4 py-2 bg-gray-800/80 border-b border-gray-700 animate-pulse"><div className="w-2 h-2 rounded-full bg-yellow-400"/><span className="text-yellow-400 text-xs font-medium">{agentName}</span><span className="text-gray-500 text-xs">{text}</span></div>);
}
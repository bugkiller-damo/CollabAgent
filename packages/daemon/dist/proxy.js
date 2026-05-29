import { ProxyAgent } from "undici";
const fetchDispatcherCache = new Map();
function getDefaultPort(protocol) {
    switch (protocol) {
        case "https:":
        case "wss:":
            return "443";
        case "http:":
        case "ws:":
            return "80";
        default:
            return "";
    }
}
function hostMatchesNoProxyEntry(hostname, ruleHost) {
    const normalizedRule = ruleHost.replace(/^\*\./, ".").replace(/^\./, "").toLowerCase();
    const normalizedHost = hostname.toLowerCase();
    return normalizedHost === normalizedRule || normalizedHost.endsWith(`.${normalizedRule}`);
}
function getProxyUrlForTarget(targetUrl, env = process.env) {
    const protocol = new URL(targetUrl).protocol;
    switch (protocol) {
        case "wss:":
            return env.WSS_PROXY || env.wss_proxy || env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy;
        case "ws:":
            return env.WS_PROXY || env.ws_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
        case "https:":
            return env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy;
        case "http:":
            return env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
        default:
            return env.ALL_PROXY || env.all_proxy;
    }
}
function shouldBypassProxy(targetUrl, env = process.env) {
    const rawNoProxy = env.NO_PROXY || env.no_proxy;
    if (!rawNoProxy)
        return false;
    const url = new URL(targetUrl);
    const hostname = url.hostname.toLowerCase();
    const port = url.port || getDefaultPort(url.protocol);
    return rawNoProxy
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean)
        .some((entry) => {
        if (entry === "*")
            return true;
        const [ruleHost, rulePort] = entry.split(":", 2);
        if (rulePort && rulePort !== port)
            return false;
        return hostMatchesNoProxyEntry(hostname, ruleHost);
    });
}
export function buildFetchDispatcher(targetUrl, env = process.env) {
    const proxyUrl = getProxyUrlForTarget(targetUrl, env);
    if (!proxyUrl || shouldBypassProxy(targetUrl, env))
        return undefined;
    const cached = fetchDispatcherCache.get(proxyUrl);
    if (cached)
        return cached;
    const dispatcher = new ProxyAgent(proxyUrl);
    fetchDispatcherCache.set(proxyUrl, dispatcher);
    return dispatcher;
}
//# sourceMappingURL=proxy.js.map
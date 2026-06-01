export function buildLocalProxyOptions(request, hostPort, suffixPath = "") {
  const target = new URL(request.url || "/", "http://control-plane.local");
  const safeSuffixPath = String(suffixPath || "").replace(/^\/+/u, "");
  const upstreamHost = "127.0.0.1";
  return {
    protocol: "http:",
    hostname: upstreamHost,
    port: String(hostPort),
    method: request.method,
    path: `/${safeSuffixPath}${target.search}`,
    headers: {
      ...request.headers,
      host: `${upstreamHost}:${hostPort}`,
    },
  };
}

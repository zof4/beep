import { removeStaticSitePreview, updateStaticSitePreview as defaultUpdateStaticSitePreview } from "./static-site-preview.mjs";
import { readJsonBody, sendJson, sendNotFound } from "./http-utils.mjs";

export async function handleSiteRoute({
  request,
  response,
  pathname,
  url,
  store,
  requireOperatorAuth,
  updateStaticSitePreview = defaultUpdateStaticSitePreview,
}) {
  requireOperatorAuth(request);
  const parts = pathname.split("/").filter(Boolean);
  const siteId = parts[2] || null;
  const action = parts[3] || null;

  if (request.method === "GET" && parts.length === 2) {
    const limit = Math.min(Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1000);
    const status = url.searchParams.get("status") || null;
    sendJson(response, 200, { ok: true, sites: store.listSites({ status, limit }) });
    return;
  }

  if (!siteId) {
    sendNotFound(response);
    return;
  }

  const site = store.getSite(siteId);
  if (!site) {
    sendJson(response, 404, { ok: false, error: `Unknown siteId: ${siteId}` });
    return;
  }

  if (request.method === "GET" && parts.length === 3) {
    sendJson(response, 200, { ok: true, site });
    return;
  }

  if (request.method === "POST" && action === "update") {
    const body = await readJsonBody(request);
    const updated = await updateStaticSitePreview({
      runtimeId: site.runtimeId,
      site,
      args: { sourcePath: String(body.sourcePath || site.sourcePath || "") },
      store,
    });
    sendJson(response, 200, { ok: true, site: updated });
    return;
  }

  if (request.method === "POST" && action === "stop") {
    const stopped = await removeStaticSitePreview({ site, store });
    sendJson(response, 200, { ok: true, site: stopped });
    return;
  }

  sendNotFound(response);
}

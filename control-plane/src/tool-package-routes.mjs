import { readJsonBody, sendJson, sendNotFound } from "./http-utils.mjs";
import { validateToolPackageManifest } from "./tool-package-validator.mjs";

function decodeSegment(value) {
  return decodeURIComponent(String(value || ""));
}

export async function handleToolPackageRoute({ request, response, pathname, store, requireOperatorAuth }) {
  requireOperatorAuth(request);

  if (request.method === "GET" && pathname === "/api/tools/packages") {
    sendJson(response, 200, { ok: true, packages: store.listToolPackages() });
    return;
  }

  if (request.method === "POST" && pathname === "/api/tools/packages") {
    const body = await readJsonBody(request);
    const manifest = validateToolPackageManifest(body);
    const record = store.installToolPackage(manifest);
    sendJson(response, 200, { ok: true, package: record });
    return;
  }

  const toolDecisionMatch = pathname.match(
    /^\/api\/tools\/packages\/([^/]+)\/([^/]+)\/tools\/([^/]+)\/(enable|disable)$/u,
  );
  if (request.method === "POST" && toolDecisionMatch) {
    const [, packageIdRaw, versionRaw, toolNameRaw, action] = toolDecisionMatch;
    const record = store.setToolPackageToolEnabled({
      packageId: decodeSegment(packageIdRaw),
      version: decodeSegment(versionRaw),
      toolName: decodeSegment(toolNameRaw),
      enabled: action === "enable",
      decidedBy: "operator",
    });
    sendJson(response, 200, { ok: true, package: record });
    return;
  }

  sendNotFound(response);
}

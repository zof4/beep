import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function gatekeeperPolicyPrompt() {
  const template = readFileSync(join(here, "policy-template.md"), "utf8").trim();
  const policy = readFileSync(join(here, "policy.md"), "utf8").trim();
  return template.replace("{tenant_policy}", policy);
}

export function buildGatekeeperPrompt({ action, args, definition, classification, context, evidence }) {
  return [
    gatekeeperPolicyPrompt(),
    "",
    ">>> TRUSTED CONTROL-PLANE CLASSIFICATION",
    JSON.stringify(
      {
        action,
        label: definition?.label || null,
        defaultDecision: definition?.defaultDecision || null,
        scopes: definition?.scopes || [],
        risk: classification?.risk || null,
        reason: classification?.reason || null,
      },
      null,
      2,
    ),
    ">>> END CLASSIFICATION",
    "",
    ">>> TRUSTED DETERMINISTIC EVIDENCE",
    JSON.stringify(evidence || {}, null, 2),
    ">>> END EVIDENCE",
    "",
    ">>> RECENT BEEP CONTEXT",
    context?.text || "<no trusted runtime context available>",
    ">>> END CONTEXT",
    "",
    ">>> EXACT ACTION JSON",
    JSON.stringify({ action, args }, null, 2),
    ">>> END ACTION",
  ].join("\n");
}

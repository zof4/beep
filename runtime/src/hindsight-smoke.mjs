import { randomUUID } from "node:crypto";
import { defaultHindsightService, deriveHindsightBankId } from "./hindsight-service.mjs";

function fail(message, details = {}) {
  console.error(JSON.stringify({ ok: false, error: message, ...details }, null, 2));
  process.exit(1);
}

function errorDetails(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error?.status ? { status: error.status } : {}),
    ...(error?.payload ? { payload: error.payload } : {}),
  };
}

const service = defaultHindsightService;
const config = service.config;
const bankId = deriveHindsightBankId(config);
const canary = `beep-hindsight-smoke-${randomUUID()}`;
const documentId = `smoke:${canary}`;

const health = await service.health();
if (!health.ok) {
  fail("Hindsight health failed.", { health });
}

let retain;
try {
  retain = await service.retain({
    bankId,
    items: [
      {
        content: `Smoke canary memory: ${canary}. The Beep Hindsight sidecar is reachable.`,
        context: "Beep Hindsight smoke test",
        timestamp: new Date().toISOString(),
        document_id: documentId,
        tags: ["smoke", "source:beep-hindsight-smoke"],
        metadata: { source: "beep-hindsight-smoke", canary },
      },
    ],
    async: false,
  });
} catch (error) {
  fail("Hindsight retain failed.", { bankId, canary, documentId, retainError: errorDetails(error) });
}

let recall;
try {
  recall = await service.recall({
    bankId,
    query: `What smoke canary proves the Beep Hindsight sidecar is reachable? ${canary}`,
    tags: ["smoke", "source:beep-hindsight-smoke"],
  });
} catch (error) {
  fail("Hindsight recall failed.", { bankId, canary, documentId, retain, recallError: errorDetails(error) });
}

const found = Array.isArray(recall.results) && recall.results.some((memory) => String(memory.text || "").includes(canary));
if (!found) {
  fail("Hindsight recall did not return the smoke canary.", { bankId, canary, retain, recall });
}

let document = null;
try {
  document = await service.getDocument({ bankId, documentId });
} catch (error) {
  fail("Hindsight retained document was not readable.", {
    bankId,
    canary,
    documentId,
    retain,
    recallCount: recall.results.length,
    documentError: errorDetails(error),
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      bankId,
      canary,
      documentId,
      health,
      retain,
      recallCount: recall.results.length,
      document,
    },
    null,
    2,
  ),
);

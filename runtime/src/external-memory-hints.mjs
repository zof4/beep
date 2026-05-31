function normalizeMemory(memory) {
  if (!memory || typeof memory !== "object") return null;
  return {
    id: String(memory.id || ""),
    text: String(memory.text || ""),
    kind: String(memory.type || memory.kind || "memory"),
    score: Number.isFinite(Number(memory.score)) ? Number(memory.score) : null,
    documentId: memory.document_id || memory.documentId || null,
    tags: Array.isArray(memory.tags) ? [...memory.tags] : [],
    sourceRef: memory.metadata?.sourceRef || memory.sourceRef || null,
    createdAt: memory.created_at || memory.createdAt || null,
    updatedAt: memory.updated_at || memory.updatedAt || memory.mentioned_at || null,
  };
}

function escapeRenderedMemoryField(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function buildExternalMemoryHints({
  bankId,
  query,
  tags = [],
  generatedAt = new Date().toISOString(),
  tokenBudget = 4096,
  recall,
} = {}) {
  const memories = Array.isArray(recall?.results)
    ? recall.results.map(normalizeMemory).filter((memory) => memory?.text)
    : [];
  return {
    schemaVersion: 1,
    source: "hindsight",
    persist: false,
    stripOnRetain: true,
    bankId,
    query,
    mode: "recall",
    budget: "high",
    generatedAt,
    tokenBudget,
    tags: Array.isArray(tags) ? [...tags] : [],
    memories,
  };
}

function memoryLine(memory) {
  const kind = memory.kind ? ` [${escapeRenderedMemoryField(memory.kind)}]` : "";
  const id = memory.id ? ` (${escapeRenderedMemoryField(memory.id)})` : "";
  const whenValue = memory.updatedAt || memory.createdAt;
  const when = whenValue ? ` at ${escapeRenderedMemoryField(whenValue)}` : "";
  return `- ${escapeRenderedMemoryField(memory.text)}${kind}${id}${when}`;
}

export function renderExternalMemoryHintsAsMessages(hints) {
  if (!hints || !Array.isArray(hints.memories) || hints.memories.length === 0) return [];
  const text = [
    "<hindsight_memories>",
    "Relevant learned memories from prior Beep work. Treat current user instructions and current transcript as higher priority when there is any conflict.",
    `Bank: ${hints.bankId}`,
    `Generated: ${hints.generatedAt}`,
    ...hints.memories.map(memoryLine),
    "</hindsight_memories>",
  ].join("\n");
  return [
    {
      role: "system",
      content: [{ type: "text", text }],
      beepEphemeralContext: {
        schemaVersion: 1,
        source: "hindsight",
        persist: false,
        stripOnRetain: true,
        bankId: hints.bankId,
        memoryCount: hints.memories.length,
      },
    },
  ];
}

export function stripInjectedHindsightMemory(text) {
  return String(text || "")
    .replace(/\r?\n?<hindsight_memories>[\s\S]*?<\/hindsight_memories>\r?\n?/gu, "\n")
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.trim() || (index > 0 && index < lines.length - 1))
    .join("\n")
    .trim();
}

export function cleanRetainText(text) {
  return stripInjectedHindsightMemory(text);
}

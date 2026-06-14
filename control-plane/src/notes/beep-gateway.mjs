const PROPOSAL_KINDS = new Set(["todo", "calendarBlock", "research", "comment", "estimate", "plan"]);

function optionalArray(value, fieldName) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array`);
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeStageOutput(raw) {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) throw new Error("stage output must be an object");
  return raw;
}

function parseAgentJson(result) {
  const text = result?.finalText || result?.text || result?.message || "";
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`local agent returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeSourceId(value, fieldName) {
  const valueType = typeof value;
  if (value == null || (valueType !== "string" && valueType !== "number" && valueType !== "boolean")) {
    throw new Error(`${fieldName} entries must be primitive ids`);
  }
  const id = String(value).trim();
  if (!id) throw new Error(`${fieldName} entries must be non-empty ids`);
  return id;
}

function normalizeRequiredObject(value, fieldName) {
  if (!isPlainObject(value)) throw new Error(`${fieldName} must be an object`);
  return value;
}

function normalizeRequiredText(value, fieldName, requiredMessage) {
  const valueType = typeof value;
  if (value == null) throw new Error(requiredMessage);
  if (valueType !== "string" && valueType !== "number" && valueType !== "boolean") {
    throw new Error(`${fieldName} must be text`);
  }
  const text = String(value).trim();
  if (!text) throw new Error(requiredMessage);
  return text;
}

function normalizeOptionalText(value, fieldName) {
  if (value === undefined) return "";
  const valueType = typeof value;
  if (value === null || (valueType !== "string" && valueType !== "number" && valueType !== "boolean")) {
    throw new Error(`${fieldName} must be text`);
  }
  return String(value);
}

function normalizeRequiredId(value, fieldName, requiredMessage) {
  const valueType = typeof value;
  if (value == null) throw new Error(requiredMessage);
  if (valueType !== "string" && valueType !== "number" && valueType !== "boolean") {
    throw new Error(`${fieldName} must be a primitive id`);
  }
  const id = String(value).trim();
  if (!id) throw new Error(requiredMessage);
  return id;
}

function cleanSourceIds(value, fieldName) {
  return optionalArray(value, fieldName).map((entry) => normalizeSourceId(entry, fieldName));
}

export function validateStageOutput(raw) {
  const input = normalizeStageOutput(raw);
  const comments = optionalArray(input.comments, "comments").map((comment, index) => {
    const inputComment = normalizeRequiredObject(comment, `comments[${index}]`);
    return {
      targetId: normalizeRequiredId(inputComment.targetId, "comment targetId", "comment targetId is required"),
      body: normalizeRequiredText(inputComment.body, "comment body", "comment body is required"),
      sourceItemIds: cleanSourceIds(inputComment.sourceItemIds, "comment sourceItemIds"),
      sourceArtifactIds: cleanSourceIds(inputComment.sourceArtifactIds, "comment sourceArtifactIds"),
      uncertainty: normalizeOptionalText(inputComment.uncertainty, "comment uncertainty"),
    };
  });

  const proposals = optionalArray(input.proposals, "proposals").map((proposal, index) => {
    const inputProposal = normalizeRequiredObject(proposal, `proposals[${index}]`);
    const kind = normalizeRequiredText(inputProposal.kind, "proposal kind", "proposal kind is required");
    if (!PROPOSAL_KINDS.has(kind)) throw new Error(`unsupported proposal kind: ${kind}`);
    return {
      kind,
      title: normalizeRequiredText(inputProposal.title, "proposal title", "proposal title is required"),
      body: normalizeOptionalText(inputProposal.body, "proposal body"),
      sourceItemIds: cleanSourceIds(inputProposal.sourceItemIds, "proposal sourceItemIds"),
      sourceArtifactIds: cleanSourceIds(inputProposal.sourceArtifactIds, "proposal sourceArtifactIds"),
      estimateMinutes: Number.isFinite(inputProposal.estimateMinutes) ? inputProposal.estimateMinutes : null,
      confidence: Number.isFinite(inputProposal.confidence) ? inputProposal.confidence : null,
    };
  });

  const derivedArtifacts = optionalArray(input.derivedArtifacts, "derivedArtifacts").map((artifact, index) => {
    const inputArtifact = normalizeRequiredObject(artifact, `derivedArtifacts[${index}]`);
    return {
      kind: normalizeRequiredText(inputArtifact.kind, "derived artifact kind", "derived artifact kind is required"),
      body: normalizeOptionalText(inputArtifact.body, "derived artifact body"),
      sourceArtifactIds: cleanSourceIds(inputArtifact.sourceArtifactIds, "derived artifact sourceArtifactIds"),
    };
  });

  return { comments, proposals, derivedArtifacts };
}

function stagePrompt(stage, context) {
  return [
    `You are running Beep Notes pipeline stage: ${stage}.`,
    `Target item: ${context.targetItemId || "none"}.`,
    `Source artifact: ${context.sourceArtifactId || "none"}.`,
    "Return JSON only with optional arrays: comments, proposals, derivedArtifacts.",
    "Do not mutate original user content. Create comments and proposals only.",
  ].join("\n");
}

export class NotesBeepGateway {
  constructor({ mode = "replay", replay = {}, submitToAgent = null } = {}) {
    this.mode = mode;
    this.replay = replay;
    this.submitToAgent = submitToAgent;
  }

  async runStage(stage, context = {}) {
    if (this.mode === "replay") {
      return validateStageOutput(this.replay[stage]);
    }
    if (this.mode === "localAgent") {
      if (!this.submitToAgent) throw new Error("submitToAgent is required for localAgent mode");
      const result = await this.submitToAgent({ message: stagePrompt(stage, context), stage, context });
      return validateStageOutput(parseAgentJson(result));
    }
    throw new Error(`unsupported Beep gateway mode: ${this.mode}`);
  }
}

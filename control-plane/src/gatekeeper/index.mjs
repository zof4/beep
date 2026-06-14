import { APPROVALS_REVIEWER, GATEKEEPER_TIMEOUT_MS } from "../config.mjs";
import { collectGatekeeperContext } from "./context.mjs";
import { normalizeGatekeeperDecision } from "./decision-schema.mjs";
import { collectEvidenceForAction } from "./evidence.mjs";
import { buildGatekeeperPrompt } from "./prompt.mjs";

function nowIso() {
  return new Date().toISOString();
}

function includesAny(text, terms) {
  const haystack = String(text || "").toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

function normalizeText(text) {
  return String(text || "").toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizeReferencePath(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/u, "")
    .toLowerCase();
}

function authorizationUnits(text) {
  return String(text || "")
    .split(/[\r\n]+|(?<=[!?;])\s+|[.]\s+/u)
    .map((unit) => unit.trim())
    .filter(Boolean);
}

function pathReferencesForStaticPreview(args = {}) {
  const refs = new Set();
  const genericRefs = new Set(["app", "demo", "html", "public", "site", "static", "website", "web"]);
  const sourcePath = typeof args.sourcePath === "string" ? args.sourcePath.trim() : "";
  const siteName = typeof args.siteName === "string" ? args.siteName.trim() : "";
  const siteId = typeof args.siteId === "string" ? args.siteId.trim() : "";
  if (sourcePath) {
    refs.add(normalizeReferencePath(sourcePath));
    if (sourcePath.startsWith("/workspace/")) {
      const relativeSource = normalizeReferencePath(sourcePath.slice("/workspace/".length));
      if (relativeSource.includes("/") || !genericRefs.has(relativeSource)) refs.add(relativeSource);
    }
  }
  if (siteName && !genericRefs.has(siteName.toLowerCase())) refs.add(siteName.toLowerCase());
  if (siteId && !genericRefs.has(siteId.toLowerCase())) refs.add(siteId.toLowerCase());
  return [...refs].filter((ref) => ref.length >= 3);
}

function textContainsPathReference(text, ref) {
  const escaped = escapeRegExp(ref);
  const pathBoundary = "[^A-Za-z0-9_./-]";
  const sentencePeriod = "[.](?=\\s|$)";
  return new RegExp(`(^|${pathBoundary})${escaped}/?(?=$|${pathBoundary}|${sentencePeriod})`, "u").test(text);
}

function textReferencesRequestedPath(text, args) {
  const haystack = normalizeText(text);
  const refs = pathReferencesForStaticPreview(args);
  return refs.length > 0 && refs.some((ref) => textContainsPathReference(haystack, ref));
}

function textReferencesRequestedSiteId(text, args) {
  const siteId = normalizeReferencePath(args?.siteId);
  return siteId.length >= 3 && textContainsPathReference(normalizeText(text), siteId);
}

function textReferencesAnyWorkspacePath(text) {
  return /\/workspace(?:\/[^\s"'`,)]*)?/iu.test(String(text || ""));
}

function hasStrongStaticPreviewPhrase(text) {
  return includesAny(text, [
    "static preview container",
    "managed static",
    "preview_container_create_static_site",
    "preview_container_update_static_site",
  ]);
}

function hasStaticPreviewTargetAndOperation(text) {
  return (
    includesAny(text, ["static site", "website", "web page", "html"]) &&
    includesAny(text, [
      "preview",
      "container",
      "publish",
      "serve",
      "show it",
      "expose",
      "create",
      "update",
      "redeploy",
      "live url",
    ])
  );
}

function hasStaticPreviewIntent(text) {
  return hasStrongStaticPreviewPhrase(text) || hasStaticPreviewTargetAndOperation(text);
}

function hasExplicitStaticPreviewDenial(text, args = {}) {
  const haystack = normalizeText(text);
  const deniesAction = [
    /\bdo\s+not\b/u,
    /\bdon['’]?t\b/u,
    /\bdont\b/u,
    /\bnever\b/u,
    /\bnot\s+(?:create|start|run|serve|publish|expose|show|request|open|update|redeploy)\b/u,
    /\bno\b/u,
    /\bwithout\b/u,
    /\bdeny\b/u,
    /\brefuse\b/u,
  ].some((pattern) => pattern.test(haystack));
  if (!deniesAction) return false;

  const deniesPreviewTarget =
    hasStaticPreviewIntent(haystack) ||
    includesAny(haystack, [
      "static preview",
      "managed preview",
      "managed static",
      "preview",
      "container",
      "publish",
      "serve",
      "show",
      "expose",
    ]) ||
    (includesAny(haystack, ["update", "redeploy"]) && textReferencesRequestedPath(haystack, args));
  return deniesPreviewTarget;
}

function staticPreviewDeniedByUser({ authorizationText, args }) {
  return authorizationUnits(authorizationText).some(
    (unit) =>
      hasExplicitStaticPreviewDenial(unit, args) &&
      (textReferencesRequestedPath(unit, args) || !textReferencesAnyWorkspacePath(unit)),
  );
}

function authScoreForStaticPreview({ authorizationText, args }) {
  const units = authorizationUnits(authorizationText).filter(
    (unit) => textReferencesRequestedPath(unit, args) && !hasExplicitStaticPreviewDenial(unit, args),
  );
  if (units.length === 0) return "unknown";

  for (const unit of units) {
    if (
      hasStrongStaticPreviewPhrase(unit) ||
      hasStaticPreviewTargetAndOperation(unit) ||
      (textReferencesRequestedSiteId(unit, args) &&
        includesAny(unit, ["preview", "container", "publish", "serve", "show it", "expose", "redeploy", "live url"]))
    ) {
      return "medium";
    }
  }
  if (units.some((unit) => includesAny(unit, ["preview", "website", "site", "html", "update", "redeploy"]))) return "low";
  return "unknown";
}

function staticPreviewReviewText(action, args = {}) {
  if (action !== "preview.container.updateStaticSite") {
    return {
      deniedAuditRationale: "Recent trusted user context explicitly denied creating a static preview for the requested path.",
      deniedAgentMessage: "Static preview was denied because the recent user request explicitly said not to create it.",
      unclearAuditRationale:
        "Static preview container is bounded, but recent context does not clearly authorize creating it.",
      unclearAgentMessage:
        "Static preview requires user/operator approval because the recent request does not clearly authorize creating a managed preview container.",
      userPrompt: `Approve creating a managed static preview container for ${args.sourcePath}?`,
      allowAuditRationale:
        "Static preview container is bounded to an existing /workspace directory with index.html, within size limits, no suspicious files, and user authorization is sufficient.",
      allowAgentMessage: "Static preview container was approved by the control-plane gatekeeper.",
    };
  }

  const siteId = typeof args.siteId === "string" ? args.siteId.trim() : "";
  const siteLabel = siteId ? ` ${siteId}` : "";
  const updateTarget = siteId ? ` ${siteId}` : " it";
  return {
    deniedAuditRationale: `Recent trusted user context explicitly denied updating/redeploying the existing managed static preview${siteLabel} for the requested path.`,
    deniedAgentMessage: `Static preview update was denied because the recent user request explicitly said not to update/redeploy${updateTarget}.`,
    unclearAuditRationale: `Static preview update is bounded, but recent context does not clearly authorize updating/redeploying the existing managed static preview${siteLabel}.`,
    unclearAgentMessage: `Static preview update requires user/operator approval because the recent request does not clearly authorize updating/redeploying the existing managed static preview${siteLabel}.`,
    userPrompt: `Approve updating/redeploying existing managed static preview${siteLabel} from ${args.sourcePath}?`,
    allowAuditRationale:
      "Static preview update is bounded to an existing /workspace directory with index.html, within size limits, no suspicious files, and user authorization is sufficient.",
    allowAgentMessage: "Static preview update was approved by the control-plane gatekeeper.",
  };
}

function localReviewStaticPreview({ action, args, context, evidence }) {
  const userDenied = staticPreviewDeniedByUser({ authorizationText: context?.authorizationText, args });
  const userAuthorization = authScoreForStaticPreview({ authorizationText: context?.authorizationText, args });
  const reviewText = staticPreviewReviewText(action, args);
  const base = {
    scope: "once",
    riskLevel: "medium",
    userAuthorization,
  };

  if (!evidence.ok) {
    return {
      ...base,
      outcome: "deny",
      riskLevel: "low",
      auditRationale: `Static preview request is invalid: ${evidence.error}`,
      agentMessage: `Static preview was denied because the requested source path is invalid: ${evidence.error}`,
      userPrompt: null,
    };
  }
  if (userDenied) {
    return {
      ...base,
      outcome: "deny",
      riskLevel: "high",
      userAuthorization: "unknown",
      auditRationale: reviewText.deniedAuditRationale,
      agentMessage: reviewText.deniedAgentMessage,
      userPrompt: null,
    };
  }
  if (!evidence.hasIndexHtml) {
    return {
      ...base,
      outcome: "deny",
      riskLevel: "low",
      auditRationale: "Static preview source directory does not contain a root index.html.",
      agentMessage: "Static preview was denied because the source directory needs an index.html at its root.",
      userPrompt: null,
    };
  }
  if (evidence.limitExceeded) {
    return {
      ...base,
      outcome: "deny",
      riskLevel: "medium",
      auditRationale: `Static preview source exceeded configured ${evidence.limitExceeded} limit.`,
      agentMessage: `Static preview was denied because the source directory exceeded the configured ${evidence.limitExceeded} limit.`,
      userPrompt: null,
    };
  }
  if (Array.isArray(evidence.suspiciousFiles) && evidence.suspiciousFiles.length > 0) {
    return {
      ...base,
      outcome: "deny",
      riskLevel: "high",
      auditRationale: `Static preview source contains suspicious secret-like files: ${evidence.suspiciousFiles.join(", ")}`,
      agentMessage:
        "Static preview was denied because the source directory appears to contain sensitive files.",
      userPrompt: null,
    };
  }
  if (Array.isArray(evidence.symlinks) && evidence.symlinks.length > 0) {
    return {
      ...base,
      outcome: "deny",
      riskLevel: "medium",
      auditRationale: `Static preview source contains symlinks: ${evidence.symlinks.join(", ")}`,
      agentMessage: "Static preview was denied because managed static previews do not allow symlinks.",
      userPrompt: null,
    };
  }
  if (!["medium", "high"].includes(userAuthorization)) {
    return {
      ...base,
      outcome: "escalate_to_user",
      riskLevel: "medium",
      auditRationale: reviewText.unclearAuditRationale,
      agentMessage: reviewText.unclearAgentMessage,
      userPrompt: reviewText.userPrompt,
    };
  }

  return {
    ...base,
    outcome: "allow",
    auditRationale: reviewText.allowAuditRationale,
    agentMessage: reviewText.allowAgentMessage,
    userPrompt: null,
  };
}

function localPolicyReview({ action, args, context, evidence }) {
  if (action === "preview.container.createStaticSite" || action === "preview.container.updateStaticSite") {
    return localReviewStaticPreview({ action, args, context, evidence });
  }
  return {
    outcome: "escalate_to_user",
    scope: "once",
    riskLevel: "high",
    userAuthorization: "unknown",
    auditRationale: `No local gatekeeper policy is registered for ${action}.`,
    agentMessage: "This action requires user/operator approval because no gatekeeper policy is registered for it.",
    userPrompt: `Approve ${action}?`,
  };
}

async function withTimeout(promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("gatekeeper review timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export class Gatekeeper {
  constructor({
    store,
    mode = APPROVALS_REVIEWER,
    timeoutMs = GATEKEEPER_TIMEOUT_MS,
    collectContext = collectGatekeeperContext,
    collectEvidence = collectEvidenceForAction,
  } = {}) {
    this.store = store;
    this.mode = mode;
    this.timeoutMs = timeoutMs;
    this.collectContext = collectContext;
    this.collectEvidence = collectEvidence;
  }

  enabled() {
    return this.mode === "auto_review";
  }

  async review({ runtimeId, toolCallId, action, args = {}, definition = null, classification = {} }) {
    if (!this.enabled()) {
      return null;
    }

    const created = this.store.createGatekeeperReview({
      runtimeId,
      toolCallId,
      action,
      args,
      reviewer: "local_policy",
      status: "running",
      startedAt: nowIso(),
    });

    try {
      const result = await withTimeout(
        (async () => {
          const [context, evidence] = await Promise.all([
            this.collectContext({ store: this.store, runtimeId, toolCallId, action, args }),
            Promise.resolve(this.collectEvidence(action, args)),
          ]);
          const prompt = buildGatekeeperPrompt({ action, args, definition, classification, context, evidence });
          const decision = normalizeGatekeeperDecision(localPolicyReview({ action, args, context, evidence }));
          return {
            decision,
            evidence,
            context: {
              ok: context.ok,
              errors: context.errors,
              authorizationExcerpt: String(context.authorizationText || "").slice(0, 5000),
              excerpt: context.text.slice(0, 5000),
            },
            prompt,
          };
        })(),
        this.timeoutMs,
      );
      this.store.updateGatekeeperReview(created.reviewId, {
        status: result.decision.outcome,
        completedAt: nowIso(),
        decision: result.decision,
        evidence: result.evidence,
        context: result.context,
        prompt: result.prompt,
      });
      return {
        reviewId: created.reviewId,
        ...result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = /timed out/iu.test(message);
      const decision = timedOut
        ? {
            outcome: "timeout",
            scope: "once",
            riskLevel: "high",
            userAuthorization: "unknown",
            auditRationale: `Gatekeeper timed out: ${message}`,
            agentMessage: "This action requires user/operator approval because automatic review timed out.",
            userPrompt: null,
          }
        : {
            outcome: "escalate_to_user",
            scope: "once",
            riskLevel: "high",
            userAuthorization: "unknown",
            auditRationale: `Gatekeeper failed closed: ${message}`,
            agentMessage: "This action requires user/operator approval because automatic review failed closed.",
            userPrompt: `Approve ${action}? Automatic review failed closed: ${message}`,
          };
      this.store.updateGatekeeperReview(created.reviewId, {
        status: decision.outcome,
        completedAt: nowIso(),
        decision,
        error: message,
      });
      return {
        reviewId: created.reviewId,
        decision,
        evidence: null,
        context: null,
        prompt: null,
      };
    }
  }
}

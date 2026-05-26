import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveModelCredential } from "./model-credential.mjs";
import {
  API_SESSIONS_DIR,
  API_WORKSPACE_DIR,
  DEFAULT_MODEL,
  DEFAULT_PROMPT_TIMEOUT_MS,
  DEFAULT_RPC_TIMEOUT_MS,
  DEFAULT_THINKING,
  EVENT_MEMORY_LIMIT,
  CONTROL_PLANE_RUNTIME_ID,
  CONTROL_PLANE_RUNTIME_TOKEN,
  CONTROL_PLANE_TOOL_TIMEOUT_MS,
  CONTROL_PLANE_TOOLS_ENABLED,
  CONTROL_PLANE_TOOLS_EXTENSION_PATH,
  CONTROL_PLANE_URL,
  LCM_CONTEXT_ENABLED,
  LCM_CONTEXT_EXTENSION_PATH,
  LCM_CONTEXT_TIMEOUT_MS,
  LCM_CONTEXT_TOKEN,
  LCM_CONTEXT_TOKEN_BUDGET,
  LCM_CONTEXT_URL,
  LCM_LIFECYCLE_URL,
  LCM_RECALL_TOOL_TIMEOUT_MS,
  LCM_RECALL_TOOL_URL,
  LCM_RECALL_TOOLS_ENABLED,
  LCM_RECALL_TOOLS_EXTENSION_PATH,
  PI_ROOT,
  STATE_DIR,
  commandPath,
  ensureDir,
  listDirectory,
  listSessionFiles,
  loadRuntimeConfig,
  newSessionId,
  nowIso,
  parseJsonl,
  readJsonFile,
  readTextLines,
  safeNumber,
  summarizeEvents,
  textFromContent,
  validateRuntimeReady,
  validateThinking,
  writeJsonFile,
} from "./runtime-common.mjs";

export class PiRpcSession {
  constructor({
    id,
    model,
    thinking,
    rootDir,
    workspace,
    sessionDir,
    resumeLatest = false,
    lcmController,
    lcmRuntimeSessionId,
    envOverrides = {},
    toolAllowlist = null,
    noSession = false,
    noBuiltinTools = false,
    noContextFiles = false,
    noSkills = false,
    noPromptTemplates = false,
    noThemes = false,
    systemPrompt = "",
    loadLcmContextExtension = true,
    loadLcmRecallToolsExtension = true,
    loadControlPlaneToolsExtension = true,
  }) {
    this.id = id;
    this.model = model;
    this.thinking = thinking;
    this.rootDir = rootDir;
    this.workspace = workspace;
    this.sessionDir = sessionDir;
    this.resumeLatest = resumeLatest;
    this.lcmController = lcmController;
    this.lcmRuntimeSessionId = lcmRuntimeSessionId || id;
    this.envOverrides = envOverrides && typeof envOverrides === "object" ? envOverrides : {};
    this.toolAllowlist = Array.isArray(toolAllowlist) ? toolAllowlist.filter(Boolean).map(String) : null;
    this.noSession = Boolean(noSession);
    this.noBuiltinTools = Boolean(noBuiltinTools);
    this.noContextFiles = Boolean(noContextFiles);
    this.noSkills = Boolean(noSkills);
    this.noPromptTemplates = Boolean(noPromptTemplates);
    this.noThemes = Boolean(noThemes);
    this.systemPrompt = typeof systemPrompt === "string" ? systemPrompt : "";
    this.loadLcmContextExtension = loadLcmContextExtension !== false;
    this.loadLcmRecallToolsExtension = loadLcmRecallToolsExtension !== false;
    this.loadControlPlaneToolsExtension = loadControlPlaneToolsExtension !== false;
    this.eventsPath = join(rootDir, "events.jsonl");
    this.stdoutPath = join(rootDir, "stdout.log");
    this.stderrPath = join(rootDir, "stderr.log");
    this.statusPath = join(rootDir, "status.json");
    this.summaryPath = join(rootDir, "summary.json");
    this.lcmSummaryPath = join(rootDir, "lcm-summary.json");
    this.lcmContextInjectionPath = join(rootDir, "lcm-context-injection.json");
    const existingEvents = parseJsonl(this.eventsPath);
    const existingSummary = summarizeEvents(existingEvents);
    this.createdAt = nowIso();
    this.updatedAt = this.createdAt;
    this.phase = "starting";
    this.exitCode = null;
    this.signal = null;
    this.pid = null;
    this.lastError = null;
    this.lastAssistantText = existingSummary.finalAssistantText;
    this.eventCount = existingEvents.length;
    this.agentEndCount = existingSummary.byType.agent_end || 0;
    this.recentEvents = [];
    this.pendingResponses = new Map();
    this.agentEndWaiters = [];
    this.closed = false;
    this.stdoutBuffer = "";
    this.stderrTail = "";
  }

  static async start(options = {}) {
    validateRuntimeReady();
    const runtimeConfig = loadRuntimeConfig();
    const model = String(options.model || runtimeConfig.model || DEFAULT_MODEL);
    const thinking = String(options.thinking || runtimeConfig.thinking || DEFAULT_THINKING);
    validateThinking(thinking);

    const id = options.id || newSessionId(options.prefix || "sess");
    const rootDir = join(API_SESSIONS_DIR, id);
    const workspace = resolve(join(API_WORKSPACE_DIR, id));
    const sessionDir = join(rootDir, "pi-sessions");
    ensureDir(rootDir);
    ensureDir(workspace);
    ensureDir(sessionDir);

    const session = new PiRpcSession({
      id,
      model,
      thinking,
      rootDir,
      workspace,
      sessionDir,
      resumeLatest: Boolean(options.resumeLatest),
      lcmController: options.lcmController,
      lcmRuntimeSessionId: options.lcmRuntimeSessionId,
      envOverrides: options.envOverrides,
      toolAllowlist: options.toolAllowlist,
      noSession: options.noSession,
      noBuiltinTools: options.noBuiltinTools,
      noContextFiles: options.noContextFiles,
      noSkills: options.noSkills,
      noPromptTemplates: options.noPromptTemplates,
      noThemes: options.noThemes,
      systemPrompt: options.systemPrompt,
      loadLcmContextExtension: options.loadLcmContextExtension,
      loadLcmRecallToolsExtension: options.loadLcmRecallToolsExtension,
      loadControlPlaneToolsExtension: options.loadControlPlaneToolsExtension,
    });
    await session.spawn();
    options.sessions?.set(id, session);
    return session;
  }

  async spawn() {
    const credential = await resolveModelCredential({
      provider: "openai-codex",
      model: this.model,
      thinking: this.thinking,
      runtimeSessionId: this.id,
    });
    const { tsxBin, piCli } = commandPath();
    const args = [
      piCli,
      "--provider",
      "openai-codex",
      "--model",
      this.model,
      "--thinking",
      this.thinking,
      "--api-key",
      credential.apiKey,
      "--mode",
      "rpc",
      "--session-dir",
      this.sessionDir,
      "--no-extensions",
    ];
    if (this.systemPrompt) {
      args.push("--system-prompt", this.systemPrompt);
    }
    if (this.noSession) {
      args.push("--no-session");
    }
    if (this.noBuiltinTools) {
      args.push("--no-builtin-tools");
    }
    if (this.toolAllowlist?.length) {
      args.push("--tools", this.toolAllowlist.join(","));
    }
    if (this.noContextFiles) {
      args.push("--no-context-files");
    }
    if (this.noSkills) {
      args.push("--no-skills");
    }
    if (this.noPromptTemplates) {
      args.push("--no-prompt-templates");
    }
    if (this.noThemes) {
      args.push("--no-themes");
    }
    const resumedFrom = this.resumeLatest ? listSessionFiles(this.sessionDir)[0]?.path || null : null;
    if (resumedFrom) {
      args.push("--continue");
    }
    const lcmContextExtensionLoaded =
      this.loadLcmContextExtension && LCM_CONTEXT_ENABLED && existsSync(LCM_CONTEXT_EXTENSION_PATH);
    if (lcmContextExtensionLoaded) {
      args.push("--extension", LCM_CONTEXT_EXTENSION_PATH);
    }
    const lcmRecallToolsExtensionLoaded =
      this.loadLcmRecallToolsExtension && LCM_RECALL_TOOLS_ENABLED && existsSync(LCM_RECALL_TOOLS_EXTENSION_PATH);
    if (lcmRecallToolsExtensionLoaded) {
      args.push("--extension", LCM_RECALL_TOOLS_EXTENSION_PATH);
    }
    const controlPlaneToolsExtensionLoaded =
      CONTROL_PLANE_TOOLS_ENABLED &&
      this.loadControlPlaneToolsExtension &&
      Boolean(CONTROL_PLANE_URL) &&
      Boolean(CONTROL_PLANE_RUNTIME_TOKEN) &&
      existsSync(CONTROL_PLANE_TOOLS_EXTENSION_PATH);
    if (controlPlaneToolsExtensionLoaded) {
      args.push("--extension", CONTROL_PLANE_TOOLS_EXTENSION_PATH);
    }

    writeJsonFile(join(this.rootDir, "run-config.json"), {
      schemaVersion: 1,
      id: this.id,
      provider: "openai-codex",
      model: this.model,
      thinking: this.thinking,
      workspace: this.workspace,
      sessionDir: this.sessionDir,
      piRoot: PI_ROOT,
      resumeLatest: this.resumeLatest,
      resumedFrom,
      noSession: this.noSession,
      noBuiltinTools: this.noBuiltinTools,
      noContextFiles: this.noContextFiles,
      noSkills: this.noSkills,
      noPromptTemplates: this.noPromptTemplates,
      noThemes: this.noThemes,
      toolAllowlist: this.toolAllowlist,
      modelCredential: {
        source: credential.source,
        expiresAt: credential.expiresAt ?? null,
      },
      lcmContext: {
        enabled: LCM_CONTEXT_ENABLED,
        extensionPath: LCM_CONTEXT_EXTENSION_PATH,
        extensionLoaded: lcmContextExtensionLoaded,
        url: LCM_CONTEXT_URL,
        lifecycleUrl: LCM_LIFECYCLE_URL,
        tokenBudget: Number(LCM_CONTEXT_TOKEN_BUDGET),
        timeoutMs: Number(LCM_CONTEXT_TIMEOUT_MS),
      },
      lcmRecallTools: {
        enabled: LCM_RECALL_TOOLS_ENABLED,
        extensionPath: LCM_RECALL_TOOLS_EXTENSION_PATH,
        extensionLoaded: lcmRecallToolsExtensionLoaded,
        url: LCM_RECALL_TOOL_URL,
        timeoutMs: Number(LCM_RECALL_TOOL_TIMEOUT_MS),
      },
      controlPlaneTools: {
        enabled: CONTROL_PLANE_TOOLS_ENABLED,
        extensionPath: CONTROL_PLANE_TOOLS_EXTENSION_PATH,
        extensionLoaded: controlPlaneToolsExtensionLoaded,
        url: CONTROL_PLANE_URL || null,
        runtimeId: CONTROL_PLANE_RUNTIME_ID,
        timeoutMs: Number(CONTROL_PLANE_TOOL_TIMEOUT_MS),
      },
      createdAt: this.createdAt,
    });

    const env = {
      ...process.env,
      HOME: process.env.HOME || join(STATE_DIR, "home"),
      PI_CODING_AGENT_DIR: join(this.rootDir, "pi-agent"),
      PI_CODING_AGENT_SESSION_DIR: this.sessionDir,
      BEEP_LCM_CONTEXT_ENABLED: lcmContextExtensionLoaded ? "1" : "0",
      BEEP_LCM_CONTEXT_URL: LCM_CONTEXT_URL,
      BEEP_LCM_LIFECYCLE_URL: LCM_LIFECYCLE_URL,
      BEEP_LCM_CONTEXT_TOKEN: LCM_CONTEXT_TOKEN,
      BEEP_LCM_RUNTIME_SESSION_ID: this.lcmRuntimeSessionId,
      BEEP_LCM_CONTEXT_TOKEN_BUDGET: LCM_CONTEXT_TOKEN_BUDGET,
      BEEP_LCM_CONTEXT_TIMEOUT_MS: LCM_CONTEXT_TIMEOUT_MS,
      BEEP_LCM_RECALL_TOOLS_ENABLED: lcmRecallToolsExtensionLoaded ? "1" : "0",
      BEEP_LCM_RECALL_TOOL_URL: LCM_RECALL_TOOL_URL,
      BEEP_LCM_RECALL_TOOL_TOKEN: LCM_CONTEXT_TOKEN,
      BEEP_LCM_RECALL_TOOL_TIMEOUT_MS: LCM_RECALL_TOOL_TIMEOUT_MS,
      BEEP_CONTROL_PLANE_TOOLS_ENABLED: controlPlaneToolsExtensionLoaded ? "1" : "0",
      BEEP_CONTROL_PLANE_URL: CONTROL_PLANE_URL,
      BEEP_CONTROL_PLANE_RUNTIME_ID: CONTROL_PLANE_RUNTIME_ID,
      BEEP_CONTROL_PLANE_RUNTIME_TOKEN: CONTROL_PLANE_RUNTIME_TOKEN,
      BEEP_CONTROL_PLANE_TOOL_TIMEOUT_MS: CONTROL_PLANE_TOOL_TIMEOUT_MS,
      ...this.envOverrides,
    };

    this.stdoutStream = createWriteStream(this.stdoutPath, { flags: "a" });
    this.stderrStream = createWriteStream(this.stderrPath, { flags: "a" });
    this.eventsStream = createWriteStream(this.eventsPath, { flags: "a" });
    this.child = spawn(tsxBin, args, {
      cwd: this.workspace,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.pid = this.child.pid ?? null;
    this.phase = "running";
    this.updatedAt = nowIso();
    this.writeStatus();

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => this.handleStderr(chunk));
    this.child.on("error", (error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.phase = "failed";
      this.updatedAt = nowIso();
      this.writeStatus();
      this.rejectPending(error);
    });
    this.child.on("close", (code, signal) => {
      this.closed = true;
      this.exitCode = code;
      this.signal = signal;
      if (this.stdoutBuffer.trim()) {
        this.handleLine(this.stdoutBuffer.trim());
        this.stdoutBuffer = "";
      }
      this.phase = code === 0 ? "closed" : this.phase === "stopping" ? "closed" : "failed";
      this.updatedAt = nowIso();
      this.writeSummary();
      this.writeStatus();
      this.rejectPending(new Error(`Pi RPC session closed with code ${code ?? "null"} signal ${signal ?? "none"}.`));
      this.resolveAgentEndWaiters();
      this.stdoutStream?.end();
      this.stderrStream?.end();
      this.eventsStream?.end();
    });

    if (lcmContextExtensionLoaded) {
      try {
        const response = await this.send({ type: "set_auto_compaction", enabled: false }, DEFAULT_RPC_TIMEOUT_MS);
        this.recordLcmContextInjection({
          kind: "pi_auto_compaction",
          ok: response.success !== false,
          at: nowIso(),
          detail: "Pi native auto-compaction disabled so Beep LCM owns context assembly.",
        });
      } catch (error) {
        this.lastError = `Failed to disable Pi auto-compaction: ${error instanceof Error ? error.message : String(error)}`;
        this.recordLcmContextInjection({
          kind: "pi_auto_compaction",
          ok: false,
          at: nowIso(),
          error: this.lastError,
        });
      }
      this.writeStatus();
    }
  }

  handleStdout(chunk) {
    this.stdoutStream.write(chunk);
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.handleLine(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  handleStderr(chunk) {
    this.stderrStream.write(chunk);
    this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8_000);
    this.updatedAt = nowIso();
    this.writeStatus();
  }

  handleLine(line) {
    this.eventsStream.write(`${line}\n`);
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      event = {
        type: "parse_error",
        message: error instanceof Error ? error.message : String(error),
        raw: line,
      };
    }

    this.eventCount += 1;
    this.recentEvents.push(event);
    if (this.recentEvents.length > EVENT_MEMORY_LIMIT) this.recentEvents.shift();

    if (event.type === "agent_start") {
      this.phase = "agent_running";
    } else if (event.type === "agent_end") {
      this.agentEndCount += 1;
      this.phase = "idle";
      this.resolveAgentEndWaiters();
      this.writeSummary();
    } else if (event.type === "turn_start") {
      this.phase = "turn_running";
    } else if (event.type === "turn_end") {
      this.phase = "turn_complete";
    }

    if ((event.type === "message_end" || event.type === "turn_end") && event.message?.role === "assistant") {
      this.lastAssistantText = textFromContent(event.message.content) || this.lastAssistantText;
    }

    if (event.type === "response" && event.id && this.pendingResponses.has(event.id)) {
      const pending = this.pendingResponses.get(event.id);
      this.pendingResponses.delete(event.id);
      clearTimeout(pending.timeout);
      pending.resolve(event);
    }

    this.updatedAt = nowIso();
    this.writeStatus();
  }

  writeStatus() {
    writeJsonFile(this.statusPath, this.status());
  }

  writeSummary(extra = {}) {
    const events = parseJsonl(this.eventsPath);
    const summary = {
      ok: this.exitCode === null || this.exitCode === 0,
      sessionId: this.id,
      provider: "openai-codex",
      model: this.model,
      thinking: this.thinking,
      phase: this.phase,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      workspace: {
        path: this.workspace,
        entries: listDirectory(this.workspace),
      },
      events: {
        path: this.eventsPath,
        ...summarizeEvents(events),
      },
      lastAssistantText: this.lastAssistantText,
      lcm: readJsonFile(this.lcmSummaryPath, null),
      lcmContextInjection: this.readLcmContextInjection(),
      ...extra,
    };
    writeJsonFile(this.summaryPath, summary);
    return summary;
  }

  status() {
    return {
      id: this.id,
      provider: "openai-codex",
      model: this.model,
      thinking: this.thinking,
      phase: this.phase,
      pid: this.pid,
      closed: this.closed,
      exitCode: this.exitCode,
      signal: this.signal,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      workspace: this.workspace,
      rootDir: this.rootDir,
      sessionDir: this.sessionDir,
      eventsPath: this.eventsPath,
      summaryPath: this.summaryPath,
      lcmContextInjectionPath: this.lcmContextInjectionPath,
      lcmContextInjection: this.readLcmContextInjection(),
      eventCount: this.eventCount,
      agentEndCount: this.agentEndCount,
      pendingResponseCount: this.pendingResponses.size,
      lastAssistantText: this.lastAssistantText,
      lastError: this.lastError,
      stderrTail: this.stderrTail,
    };
  }

  readLcmContextInjection() {
    return readJsonFile(this.lcmContextInjectionPath, {
      schemaVersion: 1,
      enabled: LCM_CONTEXT_ENABLED,
      total: 0,
      failures: 0,
      history: [],
    });
  }

  recordLcmContextInjection(event) {
    const current = this.readLcmContextInjection();
    const history = Array.isArray(current.history) ? current.history : [];
    const nextEvent = {
      ...event,
      at: event.at || nowIso(),
    };
    const byKind = { ...(current.byKind && typeof current.byKind === "object" ? current.byKind : {}) };
    const kind = nextEvent.kind || "unknown";
    byKind[kind] = Number(byKind[kind] || 0) + 1;
    const next = {
      schemaVersion: 1,
      enabled: LCM_CONTEXT_ENABLED,
      extensionPath: LCM_CONTEXT_EXTENSION_PATH,
      total: Number(current.total || 0) + 1,
      byKind,
      failures: Number(current.failures || 0) + (nextEvent.ok === false ? 1 : 0),
      latest: nextEvent,
      history: [...history, nextEvent].slice(-50),
    };
    writeJsonFile(this.lcmContextInjectionPath, next);
    return next;
  }

  send(command, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
    if (this.closed || !this.child || !this.child.stdin.writable) {
      throw new Error(`Pi RPC session ${this.id} is not running.`);
    }
    const id = command.id || `cmd_${randomUUID()}`;
    const rpcCommand = { ...command, id };
    const line = `${JSON.stringify(rpcCommand)}\n`;
    return new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(id);
        rejectPromise(new Error(`Timed out waiting for Pi RPC response to ${rpcCommand.type}.`));
      }, timeoutMs);
      this.pendingResponses.set(id, { resolve: resolvePromise, reject: rejectPromise, timeout });
      this.child.stdin.write(line, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pendingResponses.delete(id);
        rejectPromise(error);
      });
    });
  }

  async prompt(message, options = {}) {
    if (typeof message !== "string" || message.trim().length === 0) {
      throw new Error("Prompt message is required.");
    }
    const waitForCompletion = Boolean(options.waitForCompletion);
    const timeoutMs = safeNumber(options.timeoutMs, DEFAULT_PROMPT_TIMEOUT_MS);
    const beforeAgentEndCount = this.agentEndCount;
    const response = await this.send(
      {
        type: "prompt",
        message,
        ...(options.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
      },
      Math.min(timeoutMs, DEFAULT_RPC_TIMEOUT_MS),
    );
    if (response.success === false) {
      return { response, completed: false, finalText: this.lastAssistantText, summary: this.writeSummary() };
    }
    if (waitForCompletion) {
      await this.waitForAgentEndAfter(beforeAgentEndCount, timeoutMs);
    }
    let finalText = this.lastAssistantText;
    if (waitForCompletion) {
      const finalResponse = await this.send({ type: "get_last_assistant_text" });
      finalText = finalResponse?.data?.text || finalText;
      this.lastAssistantText = finalText;
    }
    return {
      response,
      completed: waitForCompletion ? this.agentEndCount > beforeAgentEndCount || this.closed : null,
      finalText,
      summary: this.writeSummary(),
    };
  }

  waitForAgentEndAfter(agentEndCount, timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS) {
    if (this.agentEndCount > agentEndCount || this.closed) return Promise.resolve();
    return new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.agentEndWaiters = this.agentEndWaiters.filter((waiter) => waiter.resolve !== resolvePromise);
        rejectPromise(new Error(`Timed out waiting for Pi agent completion in session ${this.id}.`));
      }, timeoutMs);
      this.agentEndWaiters.push({
        after: agentEndCount,
        resolve: () => {
          clearTimeout(timeout);
          resolvePromise();
        },
        reject: (error) => {
          clearTimeout(timeout);
          rejectPromise(error);
        },
      });
    });
  }

  resolveAgentEndWaiters() {
    const remaining = [];
    for (const waiter of this.agentEndWaiters) {
      if (this.closed || this.agentEndCount > waiter.after) {
        waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }
    this.agentEndWaiters = remaining;
  }

  rejectPending(error) {
    for (const pending of this.pendingResponses.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingResponses.clear();
    for (const waiter of this.agentEndWaiters) {
      waiter.reject(error);
    }
    this.agentEndWaiters = [];
  }

  flushEvents() {
    if (!this.eventsStream || this.eventsStream.destroyed || this.eventsStream.closed) {
      return Promise.resolve();
    }
    return new Promise((resolvePromise, rejectPromise) => {
      this.eventsStream.write("", (error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
    });
  }

  async resolvePiSessionFile() {
    await this.flushEvents();
    const eventLineCount = readTextLines(this.eventsPath).map((line) => line.trim()).filter(Boolean).length;
    let sessionFile = null;
    let sessionStats = null;
    try {
      const statsResponse = await this.send({ type: "get_session_stats" });
      sessionStats = statsResponse?.data ?? null;
      sessionFile = typeof sessionStats?.sessionFile === "string" ? sessionStats.sessionFile : null;
    } catch {
      sessionStats = null;
    }
    if (!sessionFile) {
      sessionFile = listSessionFiles(this.sessionDir)[0]?.path || null;
    }
    if (!sessionFile) {
      throw new Error(`LCM operation failed: no Pi session file found in ${this.sessionDir}.`);
    }
    return { sessionFile, sessionStats, eventLineCount };
  }

  async recordLcm(options = {}) {
    if (!this.lcmController) {
      throw new Error("Pi RPC session has no LCM controller.");
    }
    return this.lcmController.recordPiSession(this, options);
  }

  async stop() {
    if (this.closed) return this.status();
    this.phase = "stopping";
    this.updatedAt = nowIso();
    this.writeStatus();
    this.child.stdin.end();
    await new Promise((resolvePromise) => {
      const timeout = setTimeout(() => {
        if (!this.closed) this.child.kill("SIGTERM");
        resolvePromise();
      }, 2_000);
      this.child.once("close", () => {
        clearTimeout(timeout);
        resolvePromise();
      });
    });
    return this.status();
  }
}

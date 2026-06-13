#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CONTROL_SCRIPT = join(ROOT_DIR, "scripts", "beep-control-plane.sh");
const WRAPPER_HOST = process.env.BEEP_CHAT_PAGE_HOST || "127.0.0.1";
const WRAPPER_PORT = Number.parseInt(process.env.BEEP_CHAT_PAGE_PORT || "8799", 10);
const CONTROL_HOST = process.env.BEEP_CONTROL_PLANE_HOST || "127.0.0.1";
const CONTROL_PORT = Number.parseInt(process.env.BEEP_CONTROL_PLANE_PORT || "8788", 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.BEEP_CHAT_PAGE_REQUEST_TIMEOUT_MS || "600000", 10);
const SHOULD_START_CONTROL_PLANE = !["0", "false", "no", "off"].includes(
  String(process.env.BEEP_CHAT_PAGE_START_CONTROL_PLANE || "1").toLowerCase(),
);

function controlPlaneUrl() {
  if (CONTROL_HOST === "::1") return `http://[::1]:${CONTROL_PORT}`;
  return `http://${CONTROL_HOST}:${CONTROL_PORT}`;
}

function runControlPlaneCommand(command) {
  return execFileSync("bash", [CONTROL_SCRIPT, command], {
    cwd: ROOT_DIR,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function ensureControlPlane() {
  if (!SHOULD_START_CONTROL_PLANE) return;
  runControlPlaneCommand("start");
}

function operatorToken() {
  return runControlPlaneCommand("operator-token");
}

async function readJsonBody(request, limitBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > limitBytes) {
      throw Object.assign(new Error("request body too large"), { statusCode: 413 });
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks, total).toString("utf8");
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch (error) {
    throw Object.assign(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`), {
      statusCode: 400,
    });
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendText(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
}

async function controlPlaneFetch(pathname, { method = "GET", body = null, auth = true, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {};
    if (auth) headers.authorization = `Bearer ${operatorToken()}`;
    if (body !== null) headers["content-type"] = "application/json";
    const result = await fetch(`${controlPlaneUrl()}${pathname}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await result.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { ok: false, error: text || `HTTP ${result.status}` };
    }
    return { status: result.status, ok: result.ok, payload };
  } finally {
    clearTimeout(timeout);
  }
}

function extractFinalText(payload) {
  return (
    payload?.result?.request?.finalText ||
    payload?.result?.request?.promptResult?.finalText ||
    payload?.request?.finalText ||
    payload?.finalText ||
    ""
  );
}

async function handleStatus(_request, response) {
  const [health, tools, capabilities] = await Promise.all([
    controlPlaneFetch("/health", { auth: false, timeoutMs: 15000 }).catch((error) => ({
      ok: false,
      status: 0,
      payload: { ok: false, error: error instanceof Error ? error.message : String(error) },
    })),
    controlPlaneFetch("/api/tools", { auth: false, timeoutMs: 15000 }).catch((error) => ({
      ok: false,
      status: 0,
      payload: { ok: false, error: error instanceof Error ? error.message : String(error) },
    })),
    controlPlaneFetch("/api/agent/capabilities", { timeoutMs: 30000 }).catch((error) => ({
      ok: false,
      status: 0,
      payload: { ok: false, error: error instanceof Error ? error.message : String(error) },
    })),
  ]);

  sendJson(response, 200, {
    ok: health.ok,
    controlPlaneUrl: controlPlaneUrl(),
    health,
    tools: {
      status: tools.status,
      ok: tools.ok,
      count: Array.isArray(tools.payload?.tools) ? tools.payload.tools.length : 0,
      legacyWebRunVisible: Boolean(tools.payload?.tools?.some((tool) => tool.action === "web.run")),
      names: Array.isArray(tools.payload?.tools) ? tools.payload.tools.map((tool) => tool.name || tool.action) : [],
      payload: tools.payload,
    },
    codexWebSearch: capabilities.payload?.codexWebSearch || null,
    capabilities,
  });
}

async function handleChat(request, response) {
  const body = await readJsonBody(request);
  const message = String(body.message || "").trim();
  if (!message) {
    sendJson(response, 400, { ok: false, error: "Message is required." });
    return;
  }

  const timeoutMs = Math.max(1000, Number.parseInt(String(body.timeoutMs || REQUEST_TIMEOUT_MS), 10) || REQUEST_TIMEOUT_MS);
  const result = await controlPlaneFetch("/api/requests", {
    method: "POST",
    body: {
      message,
      waitForCompletion: true,
      timeoutMs,
    },
    timeoutMs: timeoutMs + 10000,
  });
  const payload = result.payload || {};
  sendJson(response, result.ok ? 200 : result.status || 500, {
    ok: result.ok && payload.ok !== false,
    controlPlaneStatus: result.status,
    finalText: extractFinalText(payload),
    requestId: payload.requestId || null,
    runtimeRequestId: payload.result?.request?.id || null,
    payload,
  });
}

function pageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Beep Chat Test</title>
  <style>
    :root {
      color-scheme: light;
      --bg: oklch(0.965 0.006 165);
      --panel: oklch(0.992 0.004 165);
      --ink: oklch(0.205 0.015 185);
      --muted: oklch(0.47 0.018 185);
      --line: oklch(0.86 0.011 180);
      --accent: oklch(0.52 0.13 176);
      --accent-ink: oklch(0.985 0.006 176);
      --bad: oklch(0.56 0.16 28);
      --good: oklch(0.49 0.12 150);
      --shadow: 0 18px 48px color-mix(in oklch, var(--ink) 12%, transparent);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--ink);
    }
    main {
      width: min(1120px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 330px;
      gap: 18px;
    }
    header {
      grid-column: 1 / -1;
      display: flex;
      justify-content: space-between;
      align-items: end;
      gap: 16px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 18px;
    }
    h1 {
      margin: 0;
      font-size: clamp(26px, 4vw, 42px);
      line-height: 1;
      letter-spacing: 0;
    }
    .subtitle {
      margin: 8px 0 0;
      color: var(--muted);
      max-width: 68ch;
      line-height: 1.45;
    }
    .status-pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 8px 11px;
      font-size: 13px;
      color: var(--muted);
      white-space: nowrap;
      background: color-mix(in oklch, var(--panel) 78%, transparent);
    }
    .chat, aside {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      min-width: 0;
    }
    .chat {
      display: grid;
      grid-template-rows: minmax(420px, 1fr) auto;
      min-height: calc(100vh - 150px);
    }
    #messages {
      overflow: auto;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .message {
      max-width: min(760px, 100%);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px 13px;
      line-height: 1.48;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .message.user {
      align-self: flex-end;
      background: color-mix(in oklch, var(--accent) 9%, var(--panel));
      border-color: color-mix(in oklch, var(--accent) 35%, var(--line));
    }
    .message.agent {
      align-self: flex-start;
      background: oklch(0.975 0.006 190);
    }
    .message.system {
      align-self: stretch;
      max-width: 100%;
      background: oklch(0.95 0.01 95);
      color: var(--muted);
      font-size: 13px;
    }
    .meta {
      display: block;
      margin-bottom: 6px;
      font-size: 12px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0;
    }
    form {
      border-top: 1px solid var(--line);
      padding: 14px;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: end;
    }
    textarea {
      width: 100%;
      min-height: 86px;
      max-height: 220px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      font: inherit;
      line-height: 1.45;
      color: var(--ink);
      background: oklch(0.985 0.004 165);
    }
    textarea:focus, button:focus-visible {
      outline: 3px solid color-mix(in oklch, var(--accent) 30%, transparent);
      outline-offset: 2px;
    }
    button {
      border: 0;
      border-radius: 8px;
      padding: 12px 16px;
      min-height: 44px;
      font: inherit;
      font-weight: 700;
      color: var(--accent-ink);
      background: var(--accent);
      cursor: pointer;
    }
    button:disabled {
      cursor: wait;
      opacity: 0.65;
    }
    aside {
      padding: 14px;
      align-self: start;
      position: sticky;
      top: 18px;
    }
    aside h2 {
      margin: 2px 0 12px;
      font-size: 16px;
    }
    .facts {
      display: grid;
      gap: 9px;
    }
    .fact {
      border-top: 1px solid var(--line);
      padding-top: 9px;
    }
    .fact:first-child {
      border-top: 0;
      padding-top: 0;
    }
    .label {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 3px;
    }
    .value {
      font-size: 14px;
      overflow-wrap: anywhere;
    }
    .ok { color: var(--good); font-weight: 700; }
    .bad { color: var(--bad); font-weight: 700; }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }
    .chip {
      border: 1px solid var(--line);
      background: transparent;
      color: var(--ink);
      padding: 7px 9px;
      min-height: 34px;
      font-weight: 600;
    }
    details {
      margin-top: 14px;
      border-top: 1px solid var(--line);
      padding-top: 10px;
      color: var(--muted);
    }
    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 12px;
      line-height: 1.45;
      max-height: 260px;
      overflow: auto;
    }
    @media (max-width: 860px) {
      main {
        grid-template-columns: 1fr;
        width: min(100vw - 20px, 720px);
        padding: 18px 0;
      }
      header {
        align-items: start;
        flex-direction: column;
      }
      aside {
        position: static;
        order: -1;
      }
      .chat {
        min-height: 68vh;
      }
      form {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Beep Chat Test</h1>
        <p class="subtitle">Disposable local control surface for the host-loop agent. Messages go through the control plane using a server-side operator token.</p>
      </div>
      <div class="status-pill" id="topStatus">Checking runtime...</div>
    </header>

    <section class="chat" aria-label="Chat">
      <div id="messages">
        <div class="message system">
          <span class="meta">Ready</span>
          Try a web-backed question, for example: "Search the web for the latest OpenAI Codex release notes and summarize the tool changes."
        </div>
      </div>
      <form id="chatForm">
        <textarea id="messageInput" name="message" placeholder="Ask Beep something..." required></textarea>
        <button id="sendButton" type="submit">Send</button>
      </form>
    </section>

    <aside aria-label="Runtime status">
      <h2>Runtime</h2>
      <div class="facts" id="facts"></div>
      <div class="chips">
        <button class="chip" type="button" data-prompt="Say hello, then list the tools you can see.">Tools?</button>
        <button class="chip" type="button" data-prompt="Search the web for the latest OpenAI Codex release notes and summarize the search result sources.">Web search</button>
        <button class="chip" type="button" data-prompt="Create a tiny hello.txt file in your workspace, read it back, then tell me what happened.">Sandbox write</button>
      </div>
      <details>
        <summary>Raw status</summary>
        <pre id="rawStatus"></pre>
      </details>
    </aside>
  </main>
  <script>
    const messages = document.getElementById("messages");
    const form = document.getElementById("chatForm");
    const input = document.getElementById("messageInput");
    const button = document.getElementById("sendButton");
    const topStatus = document.getElementById("topStatus");
    const facts = document.getElementById("facts");
    const rawStatus = document.getElementById("rawStatus");

    function addMessage(kind, label, text) {
      const entry = document.createElement("div");
      entry.className = "message " + kind;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = label;
      entry.appendChild(meta);
      entry.append(document.createTextNode(text || "(no text)"));
      messages.appendChild(entry);
      messages.scrollTop = messages.scrollHeight;
    }

    function setFacts(status) {
      const search = status.codexWebSearch || {};
      const toolNames = status.tools?.names || [];
      const rows = [
        ["Control plane", status.controlPlaneUrl || "unknown"],
        ["Health", status.health?.ok ? "ok" : status.health?.payload?.error || "not ready", status.health?.ok],
        ["Codex web search", search.effectiveEnabled ? "effective on" : search.enabled === false ? "disabled" : "not effective", search.effectiveEnabled],
        ["Search mode", search.mode || "unknown"],
        ["Public tools", String(status.tools?.count ?? 0)],
        ["Legacy web.run visible", status.tools?.legacyWebRunVisible ? "yes" : "no", !status.tools?.legacyWebRunVisible],
        ["Tool names", toolNames.length ? toolNames.join(", ") : "none"],
      ];
      facts.replaceChildren(...rows.map(([label, value, ok]) => {
        const item = document.createElement("div");
        item.className = "fact";
        const labelNode = document.createElement("div");
        labelNode.className = "label";
        labelNode.textContent = label;
        const valueNode = document.createElement("div");
        valueNode.className = "value";
        if (typeof ok === "boolean") valueNode.className += ok ? " ok" : " bad";
        valueNode.textContent = value;
        item.append(labelNode, valueNode);
        return item;
      }));
    }

    async function refreshStatus() {
      const response = await fetch("/api/status");
      const status = await response.json();
      topStatus.textContent = status.health?.ok ? "Control plane online" : "Control plane issue";
      topStatus.className = "status-pill " + (status.health?.ok ? "ok" : "bad");
      setFacts(status);
      rawStatus.textContent = JSON.stringify(status, null, 2);
    }

    async function sendMessage(message) {
      addMessage("user", "You", message);
      button.disabled = true;
      input.disabled = true;
      const started = Date.now();
      addMessage("system", "Submitted", "Waiting for the runtime agent. This can take a while on first start.");
      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message, timeoutMs: 600000 }),
        });
        const payload = await response.json();
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        if (!response.ok || payload.ok === false) {
          addMessage("system", "Error", payload.error || payload.payload?.error || JSON.stringify(payload, null, 2));
          return;
        }
        addMessage("agent", "Beep " + seconds + "s", payload.finalText || JSON.stringify(payload.payload?.result?.request || payload.payload, null, 2));
      } catch (error) {
        addMessage("system", "Network error", error instanceof Error ? error.message : String(error));
      } finally {
        button.disabled = false;
        input.disabled = false;
        input.focus();
        refreshStatus().catch(() => {});
      }
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const message = input.value.trim();
      if (!message) return;
      input.value = "";
      sendMessage(message);
    });

    document.querySelectorAll("[data-prompt]").forEach((chip) => {
      chip.addEventListener("click", () => {
        input.value = chip.getAttribute("data-prompt") || "";
        input.focus();
      });
    });

    refreshStatus().catch((error) => {
      topStatus.textContent = "Status failed";
      topStatus.className = "status-pill bad";
      rawStatus.textContent = error instanceof Error ? error.message : String(error);
    });
  </script>
</body>
</html>`;
}

async function route(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || `${WRAPPER_HOST}:${WRAPPER_PORT}`}`);
  try {
    if (request.method === "GET" && url.pathname === "/") {
      sendText(response, 200, pageHtml(), "text/html; charset=utf-8");
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      await handleStatus(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/chat") {
      await handleChat(request, response);
      return;
    }
    sendJson(response, 404, { ok: false, error: "not found" });
  } catch (error) {
    sendJson(response, error?.statusCode || 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function listen(server, host, port, attempts = 20) {
  return new Promise((resolvePromise, rejectPromise) => {
    const tryPort = (nextPort, remaining) => {
      const onError = (error) => {
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE" && remaining > 0) {
          tryPort(nextPort + 1, remaining - 1);
          return;
        }
        rejectPromise(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolvePromise(nextPort);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(nextPort, host);
    };
    tryPort(port, attempts);
  });
}

ensureControlPlane();
const server = createServer((request, response) => {
  route(request, response);
});
const port = await listen(server, WRAPPER_HOST, WRAPPER_PORT);
console.log(`Beep chat page: http://${WRAPPER_HOST}:${port}`);
console.log(`Control plane: ${controlPlaneUrl()}`);
console.log("Press Ctrl-C to stop the chat page wrapper.");

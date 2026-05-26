import { createServer } from "node:http";
import { AgentSupervisor } from "./agent-supervisor.mjs";
import { createDispatcher, routeError } from "./beep-runtime-routes.mjs";
import { LcmController } from "./lcm-controller.mjs";
import {
  AGENT_AUTOSTART,
  API_HOST,
  API_PORT,
  API_AGENTS_DIR,
  API_SESSIONS_DIR,
  API_STATE_DIR,
  API_WORKSPACE_DIR,
  ensureDir,
  validateRuntimeReady,
} from "./runtime-common.mjs";

const sessions = new Map();
const lcmController = new LcmController();
const agentSupervisor = new AgentSupervisor({ sessions, lcmController });
const dispatch = createDispatcher({ sessions, agentSupervisor, lcmController });

async function main() {
  ensureDir(API_STATE_DIR);
  ensureDir(API_SESSIONS_DIR);
  ensureDir(API_AGENTS_DIR);
  ensureDir(API_WORKSPACE_DIR);
  validateRuntimeReady();

  if (AGENT_AUTOSTART) {
    agentSupervisor
      .start()
      .then(() => agentSupervisor.drainQueueSoon())
      .catch((error) => {
        agentSupervisor.state.lastError = error instanceof Error ? error.message : String(error);
        agentSupervisor.persistState();
      });
  }

  const server = createServer((req, res) => {
    dispatch(req, res).catch((error) => {
      const status = error?.statusCode || 500;
      routeError(res, status, error instanceof Error ? error.message : String(error));
    });
  });

  const shutdown = async () => {
    server.close();
    await agentSupervisor.stop().catch(() => {});
    await Promise.allSettled([...sessions.values()].map((session) => session.stop()));
    await lcmController.close().catch(() => {});
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  server.listen(API_PORT, API_HOST, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : API_PORT;
    console.log(
      JSON.stringify({
        ok: true,
        service: "beep-agentd",
        listening: `http://${API_HOST}:${port}`,
        agentId: agentSupervisor.id,
        agentAutostart: AGENT_AUTOSTART,
        stateDir: API_STATE_DIR,
        workspaceDir: API_WORKSPACE_DIR,
      }),
    );
  });
}

await main();

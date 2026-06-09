import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function intEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

export const CONTROL_PLANE_DIR = resolve(here, "..");
export const ROOT_DIR = resolve(CONTROL_PLANE_DIR, "..");
export const STATE_DIR = process.env.BEEP_CONTROL_PLANE_STATE_DIR || join(ROOT_DIR, ".beep-dev/control-plane");
export const RUNTIME_ID = process.env.BEEP_CONTROL_PLANE_RUNTIME_ID || "local";

export const HOST = process.env.BEEP_CONTROL_PLANE_HOST || "127.0.0.1";
export const PORT = intEnv("BEEP_CONTROL_PLANE_PORT", 8788);
export const PUBLIC_BASE_URL = process.env.BEEP_CONTROL_PLANE_PUBLIC_URL || `http://127.0.0.1:${PORT}`;
export const CONTAINER_BASE_URL = process.env.BEEP_CONTAINER_CONTROL_PLANE_URL || `http://host.docker.internal:${PORT}`;

export const COMPOSE_FILE = process.env.BEEP_RUNTIME_COMPOSE_FILE || join(ROOT_DIR, "docker/compose.runtime-dev.yml");
export const RUNTIME_COMPOSE_SERVICE = process.env.BEEP_RUNTIME_COMPOSE_SERVICE || "beep-host-loop";
export const RUNTIME_API_URL = process.env.BEEP_RUNTIME_API_URL || "http://127.0.0.1:8787";
export const RUNTIME_AUTH_PATH =
  process.env.BEEP_CONTROL_PLANE_CODEX_AUTH_PATH || join(ROOT_DIR, ".beep-dev/state/codex/auth.json");
export const RUNTIME_UPDATE_ENV_PATH =
  process.env.BEEP_RUNTIME_UPDATE_ENV_PATH || join(ROOT_DIR, ".beep-dev/update-state/runtime-update.env");
export const SANDBOX_DOCKER_WORKSPACE_ROOT =
  process.env.BEEP_SANDBOX_DOCKER_WORKSPACE_ROOT || join(ROOT_DIR, ".beep-dev/workspace/sandboxes");
export const SANDBOX_IMAGE = process.env.BEEP_SANDBOX_IMAGE || "beep-sandbox:local";
export const SANDBOX_DOCKERFILE = process.env.BEEP_SANDBOX_DOCKERFILE || "docker/sandbox.Dockerfile";

export const PREVIEW_CONTAINER_PORT_MIN = intEnv("BEEP_PREVIEW_CONTAINER_PORT_MIN", 3000);
export const PREVIEW_CONTAINER_PORT_MAX = intEnv("BEEP_PREVIEW_CONTAINER_PORT_MAX", 3099);
export const PREVIEW_HOST_PORT_BASE = intEnv("BEEP_PREVIEW_HOST_PORT_BASE", 13000);
export const STATIC_SITE_IMAGE = process.env.BEEP_STATIC_SITE_IMAGE || "docker-beep-runtime-api";
export const DEFAULT_REQUEST_TIMEOUT_MS = intEnv("BEEP_CONTROL_PLANE_REQUEST_TIMEOUT_MS", 10 * 60 * 1000);
export const RUNTIME_START_TIMEOUT_MS = intEnv("BEEP_RUNTIME_START_TIMEOUT_MS", 90 * 1000);

export const APPROVALS_REVIEWER = process.env.BEEP_APPROVALS_REVIEWER || "auto_review";
export const GATEKEEPER_TIMEOUT_MS = intEnv("BEEP_GATEKEEPER_TIMEOUT_MS", 90 * 1000);
export const GATEKEEPER_MAX_STATIC_SITE_FILES = intEnv("BEEP_GATEKEEPER_MAX_STATIC_SITE_FILES", 500);
export const GATEKEEPER_MAX_STATIC_SITE_BYTES = intEnv("BEEP_GATEKEEPER_MAX_STATIC_SITE_BYTES", 20 * 1024 * 1024);

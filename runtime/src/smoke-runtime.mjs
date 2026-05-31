import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const requiredDirs = ["/workspace", "/lcm", "/history", "/state", "/tmp"];
const vendorDirs = {
  codex: "/vendor/openai-codex",
};
const imageDirs = {
  pi: process.env.BEEP_PI_ROOT || "/opt/pi",
  lcm: process.env.BEEP_LCM_ROOT || "/opt/lossless-claw",
};
const hindsightConfig = {
  enabled: process.env.BEEP_HINDSIGHT_ENABLED === "1",
  apiUrl: process.env.BEEP_HINDSIGHT_API_URL || null,
  bankPrefix: process.env.BEEP_HINDSIGHT_BANK_ID_PREFIX || null,
};

function ensureDir(path) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function canWrite(path) {
  const marker = join(path, `.beep-smoke-${process.pid}`);
  try {
    writeFileSync(marker, "ok\n");
    unlinkSync(marker);
    return true;
  } catch {
    return false;
  }
}

for (const dir of requiredDirs) {
  ensureDir(dir);
}

const piPackage = readJson(join(imageDirs.pi, "packages/agent/package.json"));
const piAiPackage = readJson(join(imageDirs.pi, "packages/ai/package.json"));
const lcmPackage = readJson(join(imageDirs.lcm, "package.json"));

const result = {
  ok: true,
  runtime: {
    node: process.version,
    noApiKeyAssumption: process.env.BEEP_NO_API_KEY === "1",
  },
  hindsight: hindsightConfig,
  mounts: Object.fromEntries(
    requiredDirs.map((dir) => [
      dir,
      {
        exists: existsSync(dir),
        writable: canWrite(dir),
      },
    ]),
  ),
  vendor: {
    codex: existsSync(join(vendorDirs.codex, "codex-rs")),
    piAgentCore: piPackage.version,
    piAi: piAiPackage.version,
    losslessClaw: lcmPackage.version,
    losslessClawImageRoot: imageDirs.lcm,
    losslessClawImageRootExists: existsSync(join(imageDirs.lcm, "src/db/migration.ts")),
  },
};

console.log(JSON.stringify(result, null, 2));

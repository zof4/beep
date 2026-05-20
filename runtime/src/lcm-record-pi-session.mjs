import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { LcmService, writeLcmSummaryFile } from "./lcm-service.mjs";

const [sessionPath, workspacePath, runId, outputPath, proofDirArg, fromMessageCountArg] = process.argv.slice(2);

if (!sessionPath || !workspacePath || !runId || !outputPath) {
  console.error(
    "usage: lcm-record-pi-session.mjs <pi-session.jsonl> <workspace> <run-id> <output.json> [proof-dir] [from-message-count]",
  );
  process.exit(64);
}

if (!existsSync(sessionPath)) {
  console.error(`Pi session file does not exist: ${sessionPath}`);
  process.exit(66);
}

const service = new LcmService();

try {
  const summary = await service.ingestPiSession({
    sessionPath,
    workspacePath,
    runtimeSessionId: runId,
    proofDir: proofDirArg || dirname(sessionPath),
    fromMessageCount: fromMessageCountArg,
    compact:
      process.env.BEEP_LCM_FORCE_COMPACT === "1" || process.env.BEEP_LCM_FORCE_COMPACT === "true"
        ? {
            force: true,
            tokenBudget: process.env.BEEP_LCM_PROOF_TOKEN_BUDGET || 2048,
            currentTokenCount: process.env.BEEP_LCM_PROOF_CURRENT_TOKENS || 1_000_000,
            compactionTarget: "threshold",
          }
        : null,
    assemble:
      process.env.BEEP_LCM_ASSEMBLE_PROOF === "1" || process.env.BEEP_LCM_ASSEMBLE_PROOF === "true"
        ? {
            tokenBudget: process.env.BEEP_LCM_PROOF_TOKEN_BUDGET || 2048,
            prompt: "Prove Lossless Claw can assemble context from this Pi transcript.",
          }
        : null,
  });
  writeLcmSummaryFile(outputPath, summary);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await service.close();
}

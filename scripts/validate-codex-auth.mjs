#!/usr/bin/env node
import { formatCodexAuthValidationSuccess, validateCodexAuthFile } from "../runtime/src/codex-auth-file.mjs";

const args = process.argv.slice(2);
const options = {};
let authPath = "";

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--require-tokens-access-token") {
    options.requireTokensAccessToken = true;
  } else if (arg === "--usage") {
    index += 1;
    options.usage = args[index] || "";
  } else if (!authPath) {
    authPath = arg;
  } else {
    console.error(`unexpected argument: ${arg}`);
    process.exit(64);
  }
}

if (!authPath) {
  console.error("usage: node scripts/validate-codex-auth.mjs [--require-tokens-access-token] [--usage <name>] <path-to-auth.json>");
  process.exit(64);
}

try {
  console.log(formatCodexAuthValidationSuccess(validateCodexAuthFile(authPath, options)));
} catch (error) {
  console.error(error?.message || String(error));
  process.exit(1);
}

import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { readSandboxPortalConfig, registerSandboxPortalTools } from "./sandbox-tool-portal-runtime.mjs";

export default function beepSandboxToolPortalExtension(pi) {
  const config = readSandboxPortalConfig();
  registerSandboxPortalTools(pi, { Type, Text, config });
}

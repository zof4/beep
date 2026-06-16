import assert from "node:assert/strict";
import test from "node:test";
import { assistantFinalTextFromContent, lastAssistantTextFromSession } from "../runtime/src/pi-native-session.mjs";

test("assistantFinalTextFromContent excludes thinking blocks from final answer text", () => {
  const finalText = assistantFinalTextFromContent([
    { type: "thinking", thinking: "**Considering output format**" },
    { type: "text", text: "{\"derivedArtifacts\":[]}" },
  ]);

  assert.equal(finalText, "{\"derivedArtifacts\":[]}");
});

test("assistantFinalTextFromContent keeps string assistant content", () => {
  assert.equal(assistantFinalTextFromContent("plain answer"), "plain answer");
});

test("assistantFinalTextFromContent represents image-only content without leaking thinking", () => {
  assert.equal(assistantFinalTextFromContent([{ type: "thinking", thinking: "hidden" }, { type: "image" }]), "[image]");
});

test("lastAssistantTextFromSession uses final answer text without thinking blocks", () => {
  const piSession = {
    state: {
      messages: [
        { role: "user", content: [{ type: "text", text: "Return JSON" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "{\"ok\":true}" }] },
      ],
    },
  };

  assert.equal(lastAssistantTextFromSession(piSession), "{\"ok\":true}");
});

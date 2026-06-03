import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeRuntimeApiRequest,
  createRuntimeHealthProof,
  verifyRuntimeHealthProof,
} from "../runtime/src/runtime-api-auth.mjs";

test("runtime API token protects control routes while health and capabilities stay public", () => {
  for (const pathname of ["/health", "/capabilities", "/internal/lcm/context", "/unknown"]) {
    assert.deepEqual(
      authorizeRuntimeApiRequest({
        pathname,
        authorization: "",
        runtimeApiToken: "runtime-api-secret",
      }),
      { ok: true, required: false },
      `${pathname} should remain outside the runtime API token boundary`,
    );
  }

  for (const [method, pathname] of [
    ["GET", "/agent"],
    ["POST", "/agent/submit"],
    ["GET", "/sessions"],
    ["POST", "/sessions"],
    ["POST", "/sessions/sess_1/prompt"],
    ["POST", "/runs"],
  ]) {
    assert.deepEqual(
      authorizeRuntimeApiRequest({
        pathname,
        authorization: "",
        runtimeApiToken: "runtime-api-secret",
      }),
      {
        ok: false,
        required: true,
        status: 401,
        error: "Runtime API route requires bearer authorization.",
      },
      `${method} ${pathname} should reject missing runtime API auth`,
    );
  }

  assert.deepEqual(
    authorizeRuntimeApiRequest({
      pathname: "/agent",
      authorization: "Bearer runtime-api-secret",
      runtimeApiToken: "runtime-api-secret",
    }),
    { ok: true, required: true },
  );

  assert.deepEqual(
    authorizeRuntimeApiRequest({
      pathname: "/sessions",
      authorization: "Bearer wrong-token",
      runtimeApiToken: "runtime-api-secret",
    }),
    {
      ok: false,
      required: true,
      status: 401,
      error: "Runtime API route requires bearer authorization.",
    },
  );
});

test("runtime API protected routes fail closed when no runtime API token is configured", () => {
  assert.deepEqual(
    authorizeRuntimeApiRequest({
      pathname: "/agent",
      authorization: "",
      runtimeApiToken: "",
    }),
    {
      ok: false,
      required: true,
      status: 503,
      error: "Runtime API bearer token is not configured.",
    },
  );
});

test("runtime health proof validates a challenge without revealing the bearer token", () => {
  const proof = createRuntimeHealthProof({
    challenge: "managed-runtime-check",
    runtimeApiToken: "runtime-api-secret",
  });

  assert.match(proof, /^[a-f0-9]{64}$/u);
  assert.equal(
    verifyRuntimeHealthProof({
      challenge: "managed-runtime-check",
      runtimeApiToken: "runtime-api-secret",
      proof,
    }),
    true,
  );
  assert.equal(
    verifyRuntimeHealthProof({
      challenge: "managed-runtime-check",
      runtimeApiToken: "wrong-secret",
      proof,
    }),
    false,
  );
  assert.equal(proof.includes("runtime-api-secret"), false);
});

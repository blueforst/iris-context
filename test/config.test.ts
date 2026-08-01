import test from "node:test";

import assert from "node:assert/strict";

import { ConfigValidationError, defaultAgentConfig, parseAgentConfig } from "../src/config/load.js";

test("default agent config validates as config version 3", () => {
  const config = defaultAgentConfig();
  assert.equal(config.config_version, 3);
  assert.equal(
    config.model.main_agent.active_profile,
    "opencode-go-deepseek-v4-flash-dev-nonthinking-v1",
  );
  assert.equal(config.runtime_sessions.rollover.max_estimated_tokens, 80000);
});

test("unknown top-level config fields are rejected", () => {
  const config = defaultAgentConfig() as unknown as Record<string, unknown>;
  assert.throws(() => parseAgentConfig({ ...config, role_id: "iris" }), ConfigValidationError);
});

test("unsupported pi_input_persistence_mode is rejected", () => {
  const config = defaultAgentConfig() as unknown as Record<string, unknown>;
  const runtimeSessions = config["runtime_sessions"] as Record<string, unknown>;
  assert.throws(
    () =>
      parseAgentConfig({
        ...config,
        runtime_sessions: { ...runtimeSessions, ["pi_input_persistence_mode"]: "sidecar" },
      }),
    ConfigValidationError,
  );
});

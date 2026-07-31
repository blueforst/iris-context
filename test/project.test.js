import assert from "node:assert/strict";
import test from "node:test";

import { projectBoundary } from "../src/project.js";

test("bootstrap boundary excludes memory implementation internals", () => {
  assert.equal(projectBoundary.project, "iris-agent");
  assert.ok(projectBoundary.owns.includes("memory-client"));
  assert.ok(projectBoundary.excludes.includes("neo4j"));
  assert.ok(projectBoundary.excludes.includes("graphiti-sdk"));
});

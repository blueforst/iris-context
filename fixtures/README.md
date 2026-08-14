# Fixtures

`config/` contains valid and invalid `agent.json` v3 fixtures used by config
contract tests. `input/` contains origin-aware `AgentInput` fixtures.

The invalid fixture intentionally reintroduces the removed `role_id` field to
prove that unknown configuration fields fail validation.

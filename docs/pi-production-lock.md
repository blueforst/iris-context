# Pi Production Lock Candidate

Source: `04 Pi Compatibility Manifest` and `07 Roadmap & Implementation Status`
in the Iris Notion knowledge base, read via Notion MCP on 2026-08-01.

```text
repository: earendil-works/pi
commit: b4f293684bba718d59cc1157679bcf6157b3a7f5
packages:
  pi-agent-core: 0.82.1
  pi-ai: 0.82.1
  pi-storage-sqlite-node: 0.82.1
node_requirement: 22.19.0
patches: []
lock_status: candidate_selected_pending_contract_tests
```

The package versions are pinned exactly in `package.json` and `package-lock.json`.
This document records evidence; it does not by itself mark the Pi production
lock as accepted.

---
name: Workflow configuration validation
description: Replit-specific validation and lifecycle quirks for project workflows and ports.
---

Changes to project-level workflow or port TOML must be written to a temporary file and applied through `verifyAndReplaceDotReplit`, rather than patched directly.

**Why:** Direct edits to `.replit` were rejected even for removing an unused service port; the validator accepted the same updated TOML and checked its schema first.

**How to apply:** Use workflow management tools for start/stop/removal, then use the TOML validator if any remaining project configuration needs changing. Avoid creating duplicate service workflows.

A managed artifact workflow can report a failed restart with `EADDRINUSE` while its previous server process still owns the port and responds through the preview. A healthy HTTP response in that state does not mean the managed workflow is healthy.

**Why:** During workflow reconciliation after configuration changes, replacement service processes attempted to bind ports held by the previous instances; the workflow statuses became failed even though the routes still returned 200.

**How to apply:** If the managed status and routed HTTP disagree, inspect the port owners, stop the affected managed workflows, confirm their listeners exit, then start each once through its managed workflow. Do not add a second service workflow or infer readiness from HTTP alone.
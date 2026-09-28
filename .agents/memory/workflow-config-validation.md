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

When staging `.replit` from Git content for the validator, normalize line endings before writing the temporary file. The code-execution shell callback can return CRLF even when the Git blob is LF, making an otherwise identical file appear fully changed.

**Why:** A validated replacement contained the correct visible configuration but differed on every line until the staging content was normalized to LF.

**How to apply:** Compare the resulting file byte-for-byte with the intended Git blob, not just by reading the visible TOML or trusting successful schema validation.

In a mixed static-dashboard/API-artifact VM publish, a log line forwarding local port 0 to external port 80 can refer to the platform's static handler, not the API service. Check the adjacent static-handler registration and the separate API listener log before changing ports.

**Why:** A failed publish logged the static handler and port-0 forwarding together, while separately waiting for and starting the API artifact on its configured port 8080. Treating port 0 as the API listener would have led to an incorrect config edit.

**How to apply:** Correlate startup lines by service and distinguish a failed attempted build from the older successful build that may still serve the public URL.
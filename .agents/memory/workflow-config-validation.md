---
name: Workflow configuration validation
description: Replit-specific validation requirement for changing project workflow and port configuration.
---

Changes to project-level workflow or port TOML must be written to a temporary file and applied through `verifyAndReplaceDotReplit`, rather than patched directly.

**Why:** Direct edits to `.replit` were rejected even for removing an unused service port; the validator accepted the same updated TOML and checked its schema first.

**How to apply:** Use workflow management tools for start/stop/removal, then use the TOML validator if any remaining project configuration needs changing. Avoid creating duplicate service workflows.
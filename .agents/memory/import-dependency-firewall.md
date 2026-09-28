---
name: Import dependency firewall
description: A package firewall failure encountered while restoring this pnpm workspace.
---

A fresh locked install of this imported workspace was blocked by the package firewall on an older code-generation development dependency. Updating that direct dependency to the currently available release allowed installation without changing runtime dependencies.

**Why:** The original lockfile was internally consistent, so a frozen install alone could not resolve the registry block; bypassing the registry would have defeated the protection.

**How to apply:** If future installs fail with a package-firewall 403, check whether the blocked direct dependency has a newer compatible release before changing application code or replacing the registry.
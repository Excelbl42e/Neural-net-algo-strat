---
name: GitHub push authentication
description: Distinguish GitHub connector API access from command-line Git authentication.
---

Do not assume a connected GitHub integration authorizes `git push` from the shell in this workspace.

**Why:** GitHub API access was connected, but the shell's HTTPS push still returned an invalid-username-or-token error. The two authentication paths did not share credentials.

**How to apply:** Before attempting a requested push, confirm the branch and configuration diff. If shell authentication fails, do not treat API access as a transparent way to push existing local commits: creating a new commit through the API would change their history. Use an explicitly authorized Git transport path instead; never request credentials in chat.
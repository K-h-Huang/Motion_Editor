---
name: commit
description: Summarize current session changes using git status/diff, then propose 3 Conventional Commit messages with scope limited to model|motion|ui. Only run git commands that read state; never commit/push without approval.
---

# Motion Viewer Commit Helper

## Purpose
When invoked, summarize all current work based on the repository's git state (diff), then propose commit messages following the repo standard.

## Steps (always follow)
1) Collect git state (read-only)
   - Run:
     - `git status`
     - `git diff`
     - `git diff --staged`
   - Use these outputs as the source of truth.

2) Summarize changes (Chinese)
   - Summarize by file/module.
   - Highlight behavior changes vs refactors vs docs changes.
   - If changes are large, suggest whether splitting into multiple commits would improve clarity.

3) Propose commit messages (required)
   - Provide 3 candidate messages:
     - Conventional Commits: `<type>(<scope>): <subject>`
   - Allowed scopes: `model`, `motion`, `ui`
   - Types: feat, fix, refactor, perf, docs, test, build, ci, chore
   - Subject: English imperative, no trailing period, prefer <= 72 chars
   - For each candidate, add one Chinese sentence explaining why that type/scope fits.

4) Safety
   - Do NOT run `git commit`, `git push`, or `gh pr create`.
   - If the user asks to commit/push, first print the exact commands you would run and wait for explicit approval (per AGENTS.md).
---
name: agent-lock-guard
description: Use PROACTIVELY before running any command that starts services, modifies shared state, or uses shared infrastructure (e.g. make up, make down, docker compose, database migrations, deploy scripts). Coordinates multiple Claude Code instances so only one uses a shared resource at a time. Also use when you encounter port conflicts, "already running" errors, or resource contention that suggests another instance is active.
user-invocable: false
---

# Agent Lock Guard — Shared Resource Coordination

Multiple Claude Code instances may run simultaneously (in worktrees or separate sessions). When they access shared resources (Docker ports, databases, deploy pipelines), conflicts occur. This skill coordinates access using the agent-lock MCP tools.

## Before running any command that uses a shared resource

1. **List available resources** by calling the `agent_lock_resources` MCP tool. Read each resource description carefully — if your planned command matches any resource, you must lock it.

2. **Acquire the lock** by calling `agent_lock_acquire` with:
   - `resource`: the resource name from the list
   - `holder`: a unique identifier for this session (e.g. your worktree name or session ID)
   - `reason`: what you are about to do

3. **Check the result**:
   - If status is `acquired` — proceed with your command.
   - If status is `queued` — **STOP. Do NOT run the command.** Inform the user:
     > "Another agent holds the lock on `<resource>`. You are at queue position `<position>`. Wait for them to finish, or ask the user to check with `agent_lock_status`."

4. **After your command completes** (success or failure), immediately call `agent_lock_release` with the same `resource` and `holder`.

## When you encounter errors suggesting contention

If you see errors like "port already in use", "container name conflict", "address already in use", "resource busy", or similar:

1. Call `agent_lock_status` to check if another agent holds a relevant lock.
2. Do NOT try to force-fix the error (killing processes, changing ports, force-removing containers).
3. Inform the user about the conflict.

## Important rules

- **Always check before starting.** Never skip the lock check.
- **Always release when done.** Do not leave locks held after your task completes.
- **Never force-clear another agent's lock.** Only use `agent_lock_clear` if the user explicitly asks.
- If a lock acquire returns `queued`, do NOT proceed — wait or inform the user.

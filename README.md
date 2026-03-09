# agent-lock

File-based CLI tool for AI agent resource coordination using filesystem locks and FIFO queue.

## Features

- **Filesystem-based locks** — no database or external service required
- **FIFO wait queue** — agents queue up automatically when a resource is contended
- **Stale lock detection** — PID-based detection cleans up locks from dead processes
- **Re-entrant locking** — same holder can refresh an existing lock
- **Configurable TTL** — per-lock or global time-to-live prevents stuck locks
- **JSON output** — structured output on stdout for easy integration with agent toolchains

## Quick Start

```sh
npm install
npm run build
```

Acquire a lock, do work, then release it:

```sh
# Acquire a lock on "database"
agent-lock acquire database --holder agent-1 --reason "running migrations"

# Release when done
agent-lock release database --holder agent-1
```

## Commands

### `acquire <resource>`

Acquire a lock on a resource. If the resource is already locked, the holder is added to a FIFO wait queue.

**Options:**

| Option | Required | Description |
|---|---|---|
| `--holder <id>` | Yes | Identifier for the agent acquiring the lock |
| `--reason <reason>` | No | Reason for acquiring the lock |
| `--ttl <seconds>` | No | Time-to-live in seconds (overrides default) |

**Example — lock acquired:**

```sh
agent-lock acquire database --holder agent-1 --reason "running migrations" --ttl 3600
```

```json
{
  "ok": true,
  "action": "acquired",
  "resource": "database",
  "holder": "agent-1",
  "reason": "running migrations",
  "ttl": 3600
}
```

**Example — queued (exit code 1):**

```json
{
  "ok": false,
  "action": "queued",
  "resource": "database",
  "holder": "agent-2",
  "reason": "running migrations",
  "acquired_at": "2026-03-07T12:00:00.000Z",
  "queue_position": 1
}
```

### `release <resource>`

Release a lock on a resource. Only the current holder can release their lock.

**Options:**

| Option | Required | Description |
|---|---|---|
| `--holder <id>` | Yes | Identifier for the agent releasing the lock |

**Example — released:**

```sh
agent-lock release database --holder agent-1
```

```json
{
  "ok": true,
  "action": "released",
  "resource": "database",
  "holder": "agent-1",
  "held_for_ms": 15230
}
```

**Example — not found (exit code 1):**

```json
{
  "ok": false,
  "action": "release",
  "resource": "database",
  "message": "Resource 'database' is not locked"
}
```

### `status [resource]`

Get the status of a single resource or all active locks.

**Single resource:**

```sh
agent-lock status database
```

```json
{
  "resource": "database",
  "locked": true,
  "holder": "agent-1",
  "reason": "running migrations",
  "pid": 12345,
  "acquired_at": "2026-03-07T12:00:00.000Z",
  "held_for": "5m 30s",
  "ttl": 7200,
  "remaining_ttl": 6870,
  "queue": [
    {
      "holder": "agent-2",
      "pid": 12346,
      "enqueued_at": "2026-03-07T12:01:00.000Z",
      "position": 1
    }
  ]
}
```

**All resources (no argument):**

```sh
agent-lock status
```

```json
{
  "total": 2,
  "locks": [
    {
      "resource": "database",
      "holder": "agent-1",
      "reason": "running migrations",
      "held_for": "5m 30s",
      "remaining_ttl": 6870,
      "queue_length": 1
    },
    {
      "resource": "config-file",
      "holder": "agent-3",
      "reason": "updating settings",
      "held_for": "45s",
      "remaining_ttl": 7155,
      "queue_length": 0
    }
  ]
}
```

### `clear`

Clear stale locks (from dead processes), or all locks with `--force`.

**Options:**

| Option | Required | Description |
|---|---|---|
| `--force` | No | Remove all locks regardless of status |

**Example:**

```sh
agent-lock clear
```

```json
{
  "ok": true,
  "action": "clear",
  "cleared": 1,
  "mode": "stale-only",
  "message": "Cleared 1 lock(s)"
}
```

```sh
agent-lock clear --force
```

```json
{
  "ok": true,
  "action": "clear",
  "cleared": 3,
  "mode": "force",
  "message": "Cleared 3 lock(s)"
}
```

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Lock contention (queued) or resource not found |
| 2 | Usage or validation error |

## Configuration

| Environment Variable | Description | Default |
|---|---|---|
| `AGENT_LOCK_DIR` | Directory for lock files | `/tmp/agent-locks` |
| `AGENT_LOCK_TTL` | Default TTL in seconds | `7200` |

## How It Works

Each resource lock is a directory (`<resource>.lock/`) inside the lock directory. Locking uses atomic `mkdir` — if the directory already exists, the lock is contended.

Inside each lock directory:

- `meta.json` — lock holder, PID, reason, TTL, and acquisition timestamp
- `queue.json` — FIFO array of waiting agents

When a lock is released, the first entry in the queue is automatically promoted to holder. Stale locks are detected by checking whether the holder's PID is still alive, and are cleaned up during `acquire` and `clear` operations.

## Development

```sh
# Run directly with tsx (no build step)
npm run dev -- acquire myresource --holder dev-agent

# Build for production
npm run build

# Run tests
npm test
```

## License

MIT

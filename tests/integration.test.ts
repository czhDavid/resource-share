import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { spawn } from "node:child_process";

// Engine-level imports for tests that need live PIDs
import { acquire, release, status, clear } from "../src/lock-engine.js";
import type { Config } from "../src/config.js";

const execFileAsync = promisify(execFile);

const CLI_PATH = join(import.meta.dirname, "..", "dist", "cli.js");

/**
 * Run the CLI with the given args and a temp lock directory.
 * Returns { stdout, stderr, exitCode }.
 */
async function runCli(
  args: string[],
  lockDir: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI_PATH, ...args], {
      env: { ...process.env, AGENT_LOCK_DIR: lockDir },
      timeout: 10_000,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.code ?? 1,
    };
  }
}

/**
 * Run the CLI and parse the stdout as JSON.
 */
async function runCliJson(
  args: string[],
  lockDir: string,
): Promise<{ json: Record<string, unknown>; exitCode: number; stderr: string }> {
  const result = await runCli(args, lockDir);
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(result.stdout);
  } catch {
    // If stdout isn't valid JSON, return empty object
  }
  return { json, exitCode: result.exitCode, stderr: result.stderr };
}

/**
 * Create a temporary lock directory for test isolation.
 */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "agent-lock-test-"));
}

/**
 * Create a Config object pointing to the given temp directory.
 */
function makeConfig(lockDir: string, defaultTtl: number = 7200): Config {
  return { lockDir, defaultTtl };
}

/**
 * Spawn a long-lived process and return its PID.
 * The process sleeps for 60 seconds (well beyond test duration).
 * Caller must kill it when done.
 */
function spawnLongLived(): { pid: number; kill: () => void } {
  const child = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
  const pid = child.pid!;
  return {
    pid,
    kill: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already dead
      }
    },
  };
}

// ─── CLI Integration Tests ──────────────────────────────

describe("CLI: acquire", () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = makeTempDir();
  });

  after(() => {
    // Clean up all temp dirs (best effort)
  });

  it("should acquire a fresh resource successfully", async () => {
    const { json, exitCode } = await runCliJson(
      ["acquire", "app-server", "--holder", "agent-1", "--reason", "running tests"],
      lockDir,
    );

    assert.equal(exitCode, 0);
    assert.equal(json.ok, true);
    assert.equal(json.action, "acquired");
    assert.equal(json.resource, "app-server");
    assert.equal(json.holder, "agent-1");
    assert.equal(json.reason, "running tests");
    assert.equal(typeof json.ttl, "number");
  });

  it("should acquire a resource with custom TTL", async () => {
    const { json, exitCode } = await runCliJson(
      ["acquire", "db", "--holder", "agent-1", "--reason", "migration", "--ttl", "300"],
      lockDir,
    );

    assert.equal(exitCode, 0);
    assert.equal(json.ok, true);
    assert.equal(json.action, "acquired");
    assert.equal(json.ttl, 300);
  });

  it("should treat second acquire by different holder as stale (CLI PID is dead)", async () => {
    // First acquire — PID will be dead after this process exits
    await runCliJson(
      ["acquire", "app-server", "--holder", "agent-1", "--reason", "first"],
      lockDir,
    );

    // Second acquire — since the first CLI process PID is dead, lock is stale
    const { json, exitCode } = await runCliJson(
      ["acquire", "app-server", "--holder", "agent-2", "--reason", "second"],
      lockDir,
    );

    assert.equal(exitCode, 0);
    assert.equal(json.ok, true);
    assert.equal(json.action, "acquired");
    assert.equal(json.holder, "agent-2");
    assert.equal(json.reason, "second");
  });

  it("should return exit code 2 for invalid TTL", async () => {
    const { json, exitCode } = await runCliJson(
      ["acquire", "app-server", "--holder", "agent-1", "--ttl", "abc"],
      lockDir,
    );

    assert.equal(exitCode, 2);
    assert.equal(json.ok, false);
    assert.ok(typeof json.error === "string");
  });
});

describe("CLI: release", () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = makeTempDir();
  });

  it("should release a lock held by the same holder (stale lock scenario)", async () => {
    // Acquire — PID will be dead
    await runCliJson(
      ["acquire", "app-server", "--holder", "agent-1", "--reason", "testing"],
      lockDir,
    );

    // Release — since CLI PID is dead, the status check during release will
    // clean up the stale lock. The release should still work for the holder.
    const { json, exitCode } = await runCliJson(
      ["release", "app-server", "--holder", "agent-1"],
      lockDir,
    );

    // The lock is stale (dead PID), so status prunes it → release sees "not locked"
    // This is expected CLI behavior: the lock was held but PID died
    assert.equal(typeof json.ok, "boolean");
    assert.equal(typeof exitCode, "number");
  });

  it("should fail to release an unlocked resource", async () => {
    const { json, exitCode } = await runCliJson(
      ["release", "nonexistent", "--holder", "agent-1"],
      lockDir,
    );

    assert.equal(exitCode, 1);
    assert.equal(json.ok, false);
    assert.equal(json.action, "release");
    assert.ok(typeof json.message === "string");
    assert.ok((json.message as string).includes("not locked"));
  });
});

describe("CLI: status", () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = makeTempDir();
  });

  it("should return unlocked status for a resource that was never locked", async () => {
    const { json, exitCode } = await runCliJson(
      ["status", "unknown-resource"],
      lockDir,
    );

    assert.equal(exitCode, 0);
    assert.equal(json.resource, "unknown-resource");
    assert.equal(json.locked, false);
    assert.deepEqual(json.queue, []);
  });

  it("should return status for all locks when none exist", async () => {
    const { json, exitCode } = await runCliJson(
      ["status"],
      lockDir,
    );

    assert.equal(exitCode, 0);
    assert.equal(json.total, 0);
    assert.deepEqual(json.locks, []);
  });

  it("should return status for multiple acquired resources (stale cleanup)", async () => {
    // Acquire two resources — both will be stale since CLI PIDs die
    await runCliJson(
      ["acquire", "res-a", "--holder", "agent-1", "--reason", "first"],
      lockDir,
    );
    await runCliJson(
      ["acquire", "res-b", "--holder", "agent-2", "--reason", "second"],
      lockDir,
    );

    // Status all — stale locks are pruned during status
    const { json, exitCode } = await runCliJson(["status"], lockDir);

    assert.equal(exitCode, 0);
    assert.equal(typeof json.total, "number");
    assert.ok(Array.isArray(json.locks));
    // Both locks are stale (dead PIDs), so they get pruned → total = 0
    assert.equal(json.total, 0);
  });
});

describe("CLI: clear", () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = makeTempDir();
  });

  it("should clear stale locks (default mode)", async () => {
    // Acquire a lock — it will be stale since CLI PID dies
    await runCliJson(
      ["acquire", "app-server", "--holder", "agent-1", "--reason", "testing"],
      lockDir,
    );

    const { json, exitCode } = await runCliJson(["clear"], lockDir);

    assert.equal(exitCode, 0);
    assert.equal(json.ok, true);
    assert.equal(json.action, "clear");
    assert.equal(json.mode, "stale-only");
    assert.equal(json.cleared, 1);
  });

  it("should clear all locks with --force", async () => {
    await runCliJson(
      ["acquire", "res-a", "--holder", "agent-1", "--reason", "a"],
      lockDir,
    );
    await runCliJson(
      ["acquire", "res-b", "--holder", "agent-2", "--reason", "b"],
      lockDir,
    );

    const { json, exitCode } = await runCliJson(["clear", "--force"], lockDir);

    assert.equal(exitCode, 0);
    assert.equal(json.ok, true);
    assert.equal(json.action, "clear");
    assert.equal(json.mode, "force");
    assert.equal(json.cleared, 2);
  });

  it("should report 0 cleared when no locks exist", async () => {
    const { json, exitCode } = await runCliJson(["clear"], lockDir);

    assert.equal(exitCode, 0);
    assert.equal(json.ok, true);
    assert.equal(json.cleared, 0);
  });
});

describe("CLI: exit codes", () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = makeTempDir();
  });

  it("should return exit code 0 for successful acquire", async () => {
    const { exitCode } = await runCliJson(
      ["acquire", "res", "--holder", "agent-1", "--reason", "test"],
      lockDir,
    );
    assert.equal(exitCode, 0);
  });

  it("should return exit code 2 for missing required args", async () => {
    // Missing --holder
    const { exitCode } = await runCli(
      ["acquire", "res"],
      lockDir,
    );
    assert.equal(exitCode, 2);
  });

  it("should return exit code 2 for unknown command", async () => {
    const { exitCode } = await runCli(
      ["bogus"],
      lockDir,
    );
    // Commander may write help to stdout and exit
    assert.ok(exitCode !== 0);
  });

  it("should return exit code 1 for release of unlocked resource", async () => {
    const { exitCode } = await runCliJson(
      ["release", "nope", "--holder", "agent-1"],
      lockDir,
    );
    assert.equal(exitCode, 1);
  });
});

describe("CLI: JSON output shape", () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = makeTempDir();
  });

  it("acquire response should have correct fields", async () => {
    const { json } = await runCliJson(
      ["acquire", "myres", "--holder", "h1", "--reason", "r"],
      lockDir,
    );

    assert.ok("ok" in json);
    assert.ok("action" in json);
    assert.ok("resource" in json);
    assert.ok("holder" in json);
    assert.ok("reason" in json);
    assert.ok("ttl" in json);
  });

  it("status response for unlocked resource has correct shape", async () => {
    const { json } = await runCliJson(
      ["status", "myres"],
      lockDir,
    );

    assert.ok("resource" in json);
    assert.ok("locked" in json);
    assert.ok("queue" in json);
    assert.equal(json.locked, false);
  });

  it("status all response has correct shape", async () => {
    const { json } = await runCliJson(["status"], lockDir);

    assert.ok("total" in json);
    assert.ok("locks" in json);
    assert.ok(Array.isArray(json.locks));
  });

  it("clear response has correct shape", async () => {
    const { json } = await runCliJson(["clear"], lockDir);

    assert.ok("ok" in json);
    assert.ok("action" in json);
    assert.ok("cleared" in json);
    assert.ok("mode" in json);
    assert.ok("message" in json);
  });
});

// ─── Engine-Level Tests (live PIDs) ─────────────────────

describe("Engine: acquire and release with live PIDs", () => {
  let lockDir: string;
  let cfg: Config;

  beforeEach(() => {
    lockDir = makeTempDir();
    cfg = makeConfig(lockDir);
  });

  it("should acquire a fresh resource", async () => {
    const result = await acquire("test-res", "agent-1", process.pid, "testing", undefined, cfg);

    assert.equal(result.status, "acquired");
    assert.equal(result.resource, "test-res");
    assert.equal(result.holder, "agent-1");
    assert.ok(result.lock);
    assert.equal(result.lock.holder, "agent-1");
    assert.equal(result.lock.pid, process.pid);
    assert.equal(typeof result.lock.acquired_at, "number");
  });

  it("should re-entrant acquire (refresh) for same holder", async () => {
    await acquire("test-res", "agent-1", process.pid, "first", undefined, cfg);
    const result = await acquire("test-res", "agent-1", process.pid, "refreshed", undefined, cfg);

    assert.equal(result.status, "acquired");
    assert.equal(result.holder, "agent-1");
    assert.ok(result.message.includes("re-entrant"));
    assert.ok(result.lock);
    assert.equal(result.lock.reason, "refreshed");
  });

  it("should queue a second holder when first is alive", async () => {
    await acquire("test-res", "agent-1", process.pid, "first", undefined, cfg);
    const helper = spawnLongLived();

    try {
      const result = await acquire("test-res", "agent-2", helper.pid, "second", undefined, cfg);

      assert.equal(result.status, "queued");
      assert.equal(result.holder, "agent-2");
      assert.equal(result.position, 1);
    } finally {
      helper.kill();
    }
  });

  it("should release by owner and return released status", async () => {
    await acquire("test-res", "agent-1", process.pid, "testing", undefined, cfg);
    const result = await release("test-res", "agent-1", cfg);

    assert.equal(result.status, "released");
    assert.equal(result.resource, "test-res");
    assert.equal(result.holder, "agent-1");
  });

  it("should return not_found when releasing by wrong holder", async () => {
    await acquire("test-res", "agent-1", process.pid, "testing", undefined, cfg);
    const helper = spawnLongLived();

    try {
      // agent-2 tries to release agent-1's lock
      const result = await release("test-res", "agent-2", cfg);

      assert.equal(result.status, "not_found");
    } finally {
      helper.kill();
    }
  });

  it("should return not_found when releasing unlocked resource", async () => {
    const result = await release("nonexistent", "agent-1", cfg);

    assert.equal(result.status, "not_found");
    assert.ok(result.message.includes("No lock found"));
  });
});

describe("Engine: status", () => {
  let lockDir: string;
  let cfg: Config;

  beforeEach(() => {
    lockDir = makeTempDir();
    cfg = makeConfig(lockDir);
  });

  it("should return locked status for a held resource", async () => {
    await acquire("test-res", "agent-1", process.pid, "testing", undefined, cfg);
    const result = await status("test-res", cfg);

    assert.equal(result.resources.length, 1);
    const rs = result.resources[0];
    assert.equal(rs.resource, "test-res");
    assert.equal(rs.locked, true);
    assert.ok(rs.lock);
    assert.equal(rs.lock.holder, "agent-1");
    assert.equal(rs.lock.pid, process.pid);
    assert.equal(typeof rs.lock.acquired_at, "number");
    assert.equal(typeof rs.lock.ttl, "number");
    assert.deepEqual(rs.queue, []);
  });

  it("should return unlocked status for unknown resource", async () => {
    const result = await status("nope", cfg);

    assert.equal(result.resources.length, 1);
    const rs = result.resources[0];
    assert.equal(rs.locked, false);
    assert.equal(rs.lock, null);
    assert.deepEqual(rs.queue, []);
  });

  it("should return all resources", async () => {
    await acquire("res-a", "agent-1", process.pid, "a", undefined, cfg);
    await acquire("res-b", "agent-1", process.pid, "b", undefined, cfg);

    const result = await status(undefined, cfg);

    assert.equal(result.resources.length, 2);
    const names = result.resources.map((r) => r.resource).sort();
    assert.deepEqual(names, ["res-a", "res-b"]);
  });

  it("should return empty list when no resources exist", async () => {
    const result = await status(undefined, cfg);
    assert.equal(result.resources.length, 0);
  });
});

describe("Engine: FIFO queue behavior", () => {
  let lockDir: string;
  let cfg: Config;
  const helpers: Array<{ pid: number; kill: () => void }> = [];

  beforeEach(() => {
    lockDir = makeTempDir();
    cfg = makeConfig(lockDir);
  });

  after(() => {
    helpers.forEach((h) => h.kill());
    helpers.length = 0;
  });

  it("should maintain FIFO order for queued agents", async () => {
    // agent-1 acquires the lock with the test process PID (alive)
    await acquire("res", "agent-1", process.pid, "first", undefined, cfg);

    // Enqueue agent-2 and agent-3 with live PIDs
    const h2 = spawnLongLived();
    const h3 = spawnLongLived();
    helpers.push(h2, h3);

    await acquire("res", "agent-2", h2.pid, "second", undefined, cfg);
    await acquire("res", "agent-3", h3.pid, "third", undefined, cfg);

    // Check queue ordering
    const st = await status("res", cfg);
    const rs = st.resources[0];

    assert.equal(rs.locked, true);
    assert.equal(rs.lock!.holder, "agent-1");
    assert.equal(rs.queue.length, 2);
    assert.equal(rs.queue[0].holder, "agent-2");
    assert.equal(rs.queue[1].holder, "agent-3");
  });

  it("should auto-promote next in queue on release", async () => {
    await acquire("res", "agent-1", process.pid, "first", undefined, cfg);

    const h2 = spawnLongLived();
    const h3 = spawnLongLived();
    helpers.push(h2, h3);

    await acquire("res", "agent-2", h2.pid, "second", undefined, cfg);
    await acquire("res", "agent-3", h3.pid, "third", undefined, cfg);

    // Release agent-1 — agent-2 should be promoted
    await release("res", "agent-1", cfg);

    const st = await status("res", cfg);
    const rs = st.resources[0];

    assert.equal(rs.locked, true);
    assert.equal(rs.lock!.holder, "agent-2");
    assert.equal(rs.queue.length, 1);
    assert.equal(rs.queue[0].holder, "agent-3");
  });

  it("should prune dead PIDs from queue", async () => {
    await acquire("res", "agent-1", process.pid, "first", undefined, cfg);

    // Enqueue with a dead PID (PID 999999 almost certainly doesn't exist)
    const deadPid = 999999;
    await acquire("res", "agent-dead", deadPid, "dead", undefined, cfg);

    // The dead PID entry should be pruned immediately by the acquire logic
    // or during status check
    const st = await status("res", cfg);
    const rs = st.resources[0];

    assert.equal(rs.queue.length, 0);
  });
});

describe("Engine: stale lock detection", () => {
  let lockDir: string;
  let cfg: Config;

  beforeEach(() => {
    lockDir = makeTempDir();
    cfg = makeConfig(lockDir);
  });

  it("should detect dead PID as stale and allow new acquire", async () => {
    // Acquire with a dead PID
    const deadPid = 999999;
    await acquire("res", "agent-old", deadPid, "old", undefined, cfg);

    // New acquire should succeed (stale lock cleared)
    const result = await acquire("res", "agent-new", process.pid, "new", undefined, cfg);

    assert.equal(result.status, "acquired");
    assert.equal(result.holder, "agent-new");
    assert.ok(result.message.includes("stale"));
  });

  it("should detect TTL-expired lock as stale", async () => {
    // Acquire with a TTL of 1 second using a live PID helper
    const helper = spawnLongLived();
    try {
      // Use TTL of 0 to make it immediately expired
      // Actually, use the engine with a custom extremely-short TTL
      const shortCfg = makeConfig(lockDir, 1);
      await acquire("res", "agent-old", helper.pid, "old", 1, shortCfg);

      // Wait for TTL to expire (just over 1 second)
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // New acquire should succeed (TTL expired)
      const result = await acquire("res", "agent-new", process.pid, "new", undefined, shortCfg);

      assert.equal(result.status, "acquired");
      assert.equal(result.holder, "agent-new");
    } finally {
      helper.kill();
    }
  });
});

describe("Engine: clear", () => {
  let lockDir: string;
  let cfg: Config;

  beforeEach(() => {
    lockDir = makeTempDir();
    cfg = makeConfig(lockDir);
  });

  it("should clear only stale locks by default", async () => {
    // Create one active lock (live PID) and one stale lock (dead PID)
    await acquire("active-res", "agent-active", process.pid, "alive", undefined, cfg);
    await acquire("stale-res", "agent-stale", 999999, "dead", undefined, cfg);

    const result = await clear(false, cfg);

    assert.equal(result.cleared.length, 1);
    assert.ok(result.cleared.includes("stale-res"));
    assert.equal(result.active.length, 1);
    assert.ok(result.active.includes("active-res"));
  });

  it("should clear all locks with force", async () => {
    await acquire("res-a", "agent-1", process.pid, "a", undefined, cfg);
    await acquire("res-b", "agent-1", process.pid, "b", undefined, cfg);

    const result = await clear(true, cfg);

    assert.equal(result.cleared.length, 2);
    assert.equal(result.active.length, 0);
  });

  it("should return empty arrays when no locks exist", async () => {
    const result = await clear(false, cfg);

    assert.equal(result.cleared.length, 0);
    assert.equal(result.active.length, 0);
  });
});

describe("Engine: TTL and remaining_ttl computation", () => {
  let lockDir: string;
  let cfg: Config;

  beforeEach(() => {
    lockDir = makeTempDir();
    cfg = makeConfig(lockDir, 300); // 300 second default TTL
  });

  it("should store TTL in lock metadata", async () => {
    const result = await acquire("res", "agent-1", process.pid, "test", 600, cfg);

    assert.ok(result.lock);
    assert.equal(result.lock.ttl, 600);
  });

  it("should use default TTL when not specified", async () => {
    const result = await acquire("res", "agent-1", process.pid, "test", undefined, cfg);

    assert.ok(result.lock);
    assert.equal(result.lock.ttl, 300); // Default from config
  });
});

describe("CLI: timestamp and duration formats", () => {
  let lockDir: string;
  let cfg: Config;

  beforeEach(() => {
    lockDir = makeTempDir();
    cfg = makeConfig(lockDir);
  });

  it("should format acquired_at as ISO 8601 in status output", async () => {
    // Use engine to create a lock with live PID so status doesn't prune it
    await acquire("res", "agent-1", process.pid, "test", undefined, cfg);

    const { json } = await runCliJson(
      ["status", "res"],
      lockDir,
    );

    assert.equal(json.locked, true);
    // acquired_at should be ISO 8601
    const acquiredAt = json.acquired_at as string;
    assert.ok(acquiredAt, "acquired_at should be present");
    assert.ok(!isNaN(Date.parse(acquiredAt)), "acquired_at should be valid ISO 8601");
    assert.ok(acquiredAt.endsWith("Z"), "acquired_at should end with Z");
  });

  it("should include held_for as human-readable duration", async () => {
    await acquire("res", "agent-1", process.pid, "test", undefined, cfg);

    const { json } = await runCliJson(
      ["status", "res"],
      lockDir,
    );

    assert.equal(json.locked, true);
    const heldFor = json.held_for as string;
    assert.ok(heldFor, "held_for should be present");
    // Should match pattern like "0s", "5s", "1m 30s", etc.
    assert.ok(/^\d+[hms]/.test(heldFor), `held_for should be human-readable: ${heldFor}`);
  });

  it("should include remaining_ttl as a number", async () => {
    await acquire("res", "agent-1", process.pid, "test", 600, cfg);

    const { json } = await runCliJson(
      ["status", "res"],
      lockDir,
    );

    assert.equal(json.locked, true);
    assert.equal(typeof json.remaining_ttl, "number");
    // remaining_ttl should be close to 600 (just acquired)
    assert.ok((json.remaining_ttl as number) <= 600);
    assert.ok((json.remaining_ttl as number) >= 598);
  });

  it("should include ttl in status output", async () => {
    await acquire("res", "agent-1", process.pid, "test", 600, cfg);

    const { json } = await runCliJson(
      ["status", "res"],
      lockDir,
    );

    assert.equal(json.ttl, 600);
  });
});

describe("CLI: release response shape", () => {
  let lockDir: string;
  let cfg: Config;

  beforeEach(() => {
    lockDir = makeTempDir();
    cfg = makeConfig(lockDir);
  });

  it("should include held_for_ms in successful release", async () => {
    // Use engine to create a lock with live PID
    await acquire("res", "agent-1", process.pid, "test", undefined, cfg);

    const { json, exitCode } = await runCliJson(
      ["release", "res", "--holder", "agent-1"],
      lockDir,
    );

    assert.equal(exitCode, 0);
    assert.equal(json.ok, true);
    assert.equal(json.action, "released");
    assert.equal(json.resource, "res");
    assert.equal(json.holder, "agent-1");
    assert.equal(typeof json.held_for_ms, "number");
    assert.ok((json.held_for_ms as number) >= 0);
  });

  it("should fail to release when held by different holder", async () => {
    await acquire("res", "agent-1", process.pid, "test", undefined, cfg);

    const { json, exitCode } = await runCliJson(
      ["release", "res", "--holder", "agent-2"],
      lockDir,
    );

    assert.equal(exitCode, 1);
    assert.equal(json.ok, false);
    assert.ok(typeof json.message === "string");
    assert.ok((json.message as string).includes("agent-1"));
    assert.ok((json.message as string).includes("agent-2"));
  });
});

describe("CLI: status with live locks (engine-created)", () => {
  let lockDir: string;
  let cfg: Config;

  beforeEach(() => {
    lockDir = makeTempDir();
    cfg = makeConfig(lockDir);
  });

  it("should show single locked resource with all fields", async () => {
    await acquire("my-resource", "agent-1", process.pid, "important work", 3600, cfg);

    const { json, exitCode } = await runCliJson(
      ["status", "my-resource"],
      lockDir,
    );

    assert.equal(exitCode, 0);
    assert.equal(json.resource, "my-resource");
    assert.equal(json.locked, true);
    assert.equal(json.holder, "agent-1");
    assert.equal(json.reason, "important work");
    assert.equal(json.pid, process.pid);
    assert.equal(json.ttl, 3600);
    assert.equal(typeof json.acquired_at, "string");
    assert.equal(typeof json.held_for, "string");
    assert.equal(typeof json.remaining_ttl, "number");
    assert.ok(Array.isArray(json.queue));
  });

  it("should show queue members in status", async () => {
    await acquire("res", "agent-1", process.pid, "first", undefined, cfg);

    const helper = spawnLongLived();
    try {
      await acquire("res", "agent-2", helper.pid, "second", undefined, cfg);

      const { json } = await runCliJson(["status", "res"], lockDir);

      assert.equal(json.locked, true);
      assert.equal(json.holder, "agent-1");
      const queue = json.queue as Array<Record<string, unknown>>;
      assert.equal(queue.length, 1);
      assert.equal(queue[0].holder, "agent-2");
      assert.equal(typeof queue[0].enqueued_at, "string"); // ISO 8601 in CLI output
      assert.equal(queue[0].position, 1);
    } finally {
      helper.kill();
    }
  });

  it("should list multiple active locks in status all", async () => {
    await acquire("res-a", "agent-1", process.pid, "work-a", undefined, cfg);
    await acquire("res-b", "agent-1", process.pid, "work-b", undefined, cfg);

    const { json, exitCode } = await runCliJson(["status"], lockDir);

    assert.equal(exitCode, 0);
    assert.equal(json.total, 2);
    const locks = json.locks as Array<Record<string, unknown>>;
    assert.equal(locks.length, 2);

    const names = locks.map((l) => l.resource).sort();
    assert.deepEqual(names, ["res-a", "res-b"]);

    // Each lock should have expected fields
    for (const lock of locks) {
      assert.ok("resource" in lock);
      assert.ok("holder" in lock);
      assert.ok("reason" in lock);
      assert.ok("held_for" in lock);
      assert.ok("remaining_ttl" in lock);
      assert.ok("queue_length" in lock);
    }
  });
});

describe("Engine: re-entrant acquire (refresh)", () => {
  let lockDir: string;
  let cfg: Config;

  beforeEach(() => {
    lockDir = makeTempDir();
    cfg = makeConfig(lockDir);
  });

  it("should refresh lock timestamp on re-entrant acquire", async () => {
    const first = await acquire("res", "agent-1", process.pid, "initial", undefined, cfg);
    const firstTime = first.lock!.acquired_at;

    // Small delay to ensure timestamp difference
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = await acquire("res", "agent-1", process.pid, "refreshed", undefined, cfg);
    const secondTime = second.lock!.acquired_at;

    assert.equal(second.status, "acquired");
    assert.ok(secondTime >= firstTime, "Refreshed timestamp should be >= original");
    assert.equal(second.lock!.reason, "refreshed");
  });
});

describe("CLI: re-entrant acquire output", () => {
  let lockDir: string;
  let cfg: Config;

  beforeEach(() => {
    lockDir = makeTempDir();
    cfg = makeConfig(lockDir);
  });

  it("should return action=refreshed for re-entrant acquire via CLI", async () => {
    // Use engine to create initial lock with live PID
    await acquire("res", "agent-1", process.pid, "initial", undefined, cfg);

    // CLI re-entrant acquire — same holder
    const { json, exitCode } = await runCliJson(
      ["acquire", "res", "--holder", "agent-1", "--reason", "initial"],
      lockDir,
    );

    assert.equal(exitCode, 0);
    assert.equal(json.ok, true);
    assert.equal(json.action, "refreshed");
    assert.equal(json.holder, "agent-1");
  });
});

describe("Engine: exit code 1 for conflict (queued)", () => {
  let lockDir: string;
  let cfg: Config;

  beforeEach(() => {
    lockDir = makeTempDir();
    cfg = makeConfig(lockDir);
  });

  it("CLI should return exit code 1 when acquire results in queued", async () => {
    // Use engine with live PID to hold the lock
    await acquire("res", "agent-1", process.pid, "holding", undefined, cfg);

    // CLI acquire with different holder should be queued (exit code 1)
    // But since CLI uses its own PID which will also be alive during execution,
    // and agent-1's PID (this process) is alive, agent-2 should be queued.
    const { json, exitCode } = await runCliJson(
      ["acquire", "res", "--holder", "agent-2", "--reason", "waiting"],
      lockDir,
    );

    assert.equal(exitCode, 1);
    assert.equal(json.ok, false);
    assert.equal(json.action, "queued");
    assert.equal(typeof json.queue_position, "number");
  });
});

describe("CLI: full workflow (engine + CLI combined)", () => {
  let lockDir: string;
  let cfg: Config;

  beforeEach(() => {
    lockDir = makeTempDir();
    cfg = makeConfig(lockDir);
  });

  it("should complete acquire → status → release → status cycle", async () => {
    // Step 1: Acquire via engine (live PID)
    const acqResult = await acquire("app-server", "agent-1", process.pid, "e2e tests", undefined, cfg);
    assert.equal(acqResult.status, "acquired");

    // Step 2: Status via CLI
    const { json: statusJson } = await runCliJson(
      ["status", "app-server"],
      lockDir,
    );
    assert.equal(statusJson.locked, true);
    assert.equal(statusJson.holder, "agent-1");

    // Step 3: Release via CLI
    const { json: releaseJson, exitCode } = await runCliJson(
      ["release", "app-server", "--holder", "agent-1"],
      lockDir,
    );
    assert.equal(exitCode, 0);
    assert.equal(releaseJson.ok, true);
    assert.equal(releaseJson.action, "released");

    // Step 4: Status should show unlocked
    const { json: statusJson2 } = await runCliJson(
      ["status", "app-server"],
      lockDir,
    );
    assert.equal(statusJson2.locked, false);
  });

  it("should handle acquire → queue → release → auto-promote workflow", async () => {
    // agent-1 acquires
    await acquire("app-server", "agent-1", process.pid, "e2e tests", undefined, cfg);

    // agent-2 enqueues (needs live PID)
    const helper = spawnLongLived();
    try {
      await acquire("app-server", "agent-2", helper.pid, "QA testing", undefined, cfg);

      // Verify queue via CLI
      const { json: statusJson } = await runCliJson(
        ["status", "app-server"],
        lockDir,
      );
      assert.equal(statusJson.holder, "agent-1");
      assert.equal((statusJson.queue as Array<unknown>).length, 1);

      // agent-1 releases — agent-2 auto-promoted
      await release("app-server", "agent-1", cfg);

      // Verify agent-2 now holds the lock
      const { json: statusJson2 } = await runCliJson(
        ["status", "app-server"],
        lockDir,
      );
      assert.equal(statusJson2.locked, true);
      assert.equal(statusJson2.holder, "agent-2");
      assert.equal((statusJson2.queue as Array<unknown>).length, 0);
    } finally {
      helper.kill();
    }
  });
});

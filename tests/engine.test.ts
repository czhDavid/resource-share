import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, makeConfig, spawnLongLived, acquire, release, status, clear } from "./helpers.js";
import type { Config } from "./helpers.js";

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

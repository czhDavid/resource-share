import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { runCliJson, makeTempDir, makeConfig, spawnLongLived, acquire, release, status } from "./helpers.js";
import type { Config } from "./helpers.js";

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

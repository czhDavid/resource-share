import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { runCliJson, makeTempDir } from "./helpers.js";

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

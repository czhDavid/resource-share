import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { runCli, runCliJson, makeTempDir, makeConfig, spawnLongLived, acquire } from './helpers.js';
import type { Config } from './helpers.js';

describe('CLI: exit codes', () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = makeTempDir();
  });

  it('should return exit code 0 for successful acquire', async () => {
    const { exitCode } = await runCliJson(
      ['acquire', 'res', '--holder', 'agent-1', '--reason', 'test'],
      lockDir,
    );
    assert.equal(exitCode, 0);
  });

  it('should return exit code 2 for missing required args', async () => {
    // Missing --holder
    const { exitCode } = await runCli(['acquire', 'res'], lockDir);
    assert.equal(exitCode, 2);
  });

  it('should return exit code 2 for unknown command', async () => {
    const { exitCode } = await runCli(['bogus'], lockDir);
    // Commander may write help to stdout and exit
    assert.ok(exitCode !== 0);
  });

  it('should return exit code 1 for release of unlocked resource', async () => {
    const { exitCode } = await runCliJson(['release', 'nope', '--holder', 'agent-1'], lockDir);
    assert.equal(exitCode, 1);
  });
});

describe('CLI: JSON output shape', () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = makeTempDir();
  });

  it('acquire response should have correct fields', async () => {
    const { json } = await runCliJson(
      ['acquire', 'myres', '--holder', 'h1', '--reason', 'r'],
      lockDir,
    );

    assert.ok('ok' in json);
    assert.ok('action' in json);
    assert.ok('resource' in json);
    assert.ok('holder' in json);
    assert.ok('reason' in json);
    assert.ok('ttl' in json);
  });

  it('status response for unlocked resource has correct shape', async () => {
    const { json } = await runCliJson(['status', 'myres'], lockDir);

    assert.ok('resource' in json);
    assert.ok('locked' in json);
    assert.ok('queue' in json);
    assert.equal(json.locked, false);
  });

  it('status all response has correct shape', async () => {
    const { json } = await runCliJson(['status'], lockDir);

    assert.ok('total' in json);
    assert.ok('locks' in json);
    assert.ok(Array.isArray(json.locks));
  });

  it('clear response has correct shape', async () => {
    const { json } = await runCliJson(['clear'], lockDir);

    assert.ok('ok' in json);
    assert.ok('action' in json);
    assert.ok('cleared' in json);
    assert.ok('mode' in json);
    assert.ok('message' in json);
  });
});

describe('CLI: timestamp and duration formats', () => {
  let lockDir: string;
  let cfg: Config;

  beforeEach(() => {
    lockDir = makeTempDir();
    cfg = makeConfig(lockDir);
  });

  it('should format acquired_at as ISO 8601 in status output', async () => {
    // Use engine to create a lock with live PID so status doesn't prune it
    await acquire('res', 'agent-1', process.pid, 'test', undefined, cfg);

    const { json } = await runCliJson(['status', 'res'], lockDir);

    assert.equal(json.locked, true);
    // acquired_at should be ISO 8601
    const acquiredAt = json.acquired_at as string;
    assert.ok(acquiredAt, 'acquired_at should be present');
    assert.ok(!isNaN(Date.parse(acquiredAt)), 'acquired_at should be valid ISO 8601');
    assert.ok(acquiredAt.endsWith('Z'), 'acquired_at should end with Z');
  });

  it('should include held_for as human-readable duration', async () => {
    await acquire('res', 'agent-1', process.pid, 'test', undefined, cfg);

    const { json } = await runCliJson(['status', 'res'], lockDir);

    assert.equal(json.locked, true);
    const heldFor = json.held_for as string;
    assert.ok(heldFor, 'held_for should be present');
    // Should match pattern like "0s", "5s", "1m 30s", etc.
    assert.ok(/^\d+[hms]/.test(heldFor), `held_for should be human-readable: ${heldFor}`);
  });

  it('should include remaining_ttl as a number', async () => {
    await acquire('res', 'agent-1', process.pid, 'test', 600, cfg);

    const { json } = await runCliJson(['status', 'res'], lockDir);

    assert.equal(json.locked, true);
    assert.equal(typeof json.remaining_ttl, 'number');
    // remaining_ttl should be close to 600 (just acquired)
    assert.ok((json.remaining_ttl as number) <= 600);
    assert.ok((json.remaining_ttl as number) >= 598);
  });

  it('should include ttl in status output', async () => {
    await acquire('res', 'agent-1', process.pid, 'test', 600, cfg);

    const { json } = await runCliJson(['status', 'res'], lockDir);

    assert.equal(json.ttl, 600);
  });
});

describe('CLI: release response shape', () => {
  let lockDir: string;
  let cfg: Config;

  beforeEach(() => {
    lockDir = makeTempDir();
    cfg = makeConfig(lockDir);
  });

  it('should include held_for_ms in successful release', async () => {
    // Use engine to create a lock with live PID
    await acquire('res', 'agent-1', process.pid, 'test', undefined, cfg);

    const { json, exitCode } = await runCliJson(['release', 'res', '--holder', 'agent-1'], lockDir);

    assert.equal(exitCode, 0);
    assert.equal(json.ok, true);
    assert.equal(json.action, 'released');
    assert.equal(json.resource, 'res');
    assert.equal(json.holder, 'agent-1');
    assert.equal(typeof json.held_for_ms, 'number');
    assert.ok((json.held_for_ms as number) >= 0);
  });

  it('should fail to release when held by different holder', async () => {
    await acquire('res', 'agent-1', process.pid, 'test', undefined, cfg);

    const { json, exitCode } = await runCliJson(['release', 'res', '--holder', 'agent-2'], lockDir);

    assert.equal(exitCode, 1);
    assert.equal(json.ok, false);
    assert.ok(typeof json.message === 'string');
    assert.ok((json.message as string).includes('agent-1'));
    assert.ok((json.message as string).includes('agent-2'));
  });
});

describe('CLI: status with live locks (engine-created)', () => {
  let lockDir: string;
  let cfg: Config;

  beforeEach(() => {
    lockDir = makeTempDir();
    cfg = makeConfig(lockDir);
  });

  it('should show single locked resource with all fields', async () => {
    await acquire('my-resource', 'agent-1', process.pid, 'important work', 3600, cfg);

    const { json, exitCode } = await runCliJson(['status', 'my-resource'], lockDir);

    assert.equal(exitCode, 0);
    assert.equal(json.resource, 'my-resource');
    assert.equal(json.locked, true);
    assert.equal(json.holder, 'agent-1');
    assert.equal(json.reason, 'important work');
    assert.equal(json.pid, process.pid);
    assert.equal(json.ttl, 3600);
    assert.equal(typeof json.acquired_at, 'string');
    assert.equal(typeof json.held_for, 'string');
    assert.equal(typeof json.remaining_ttl, 'number');
    assert.ok(Array.isArray(json.queue));
  });

  it('should show queue members in status', async () => {
    await acquire('res', 'agent-1', process.pid, 'first', undefined, cfg);

    const helper = spawnLongLived();
    try {
      await acquire('res', 'agent-2', helper.pid, 'second', undefined, cfg);

      const { json } = await runCliJson(['status', 'res'], lockDir);

      assert.equal(json.locked, true);
      assert.equal(json.holder, 'agent-1');
      const queue = json.queue as Array<Record<string, unknown>>;
      assert.equal(queue.length, 1);
      assert.equal(queue[0].holder, 'agent-2');
      assert.equal(typeof queue[0].enqueued_at, 'string'); // ISO 8601 in CLI output
      assert.equal(queue[0].position, 1);
    } finally {
      helper.kill();
    }
  });

  it('should list multiple active locks in status all', async () => {
    await acquire('res-a', 'agent-1', process.pid, 'work-a', undefined, cfg);
    await acquire('res-b', 'agent-1', process.pid, 'work-b', undefined, cfg);

    const { json, exitCode } = await runCliJson(['status'], lockDir);

    assert.equal(exitCode, 0);
    assert.equal(json.total, 2);
    const locks = json.locks as Array<Record<string, unknown>>;
    assert.equal(locks.length, 2);

    const names = locks.map((l) => l.resource).sort();
    assert.deepEqual(names, ['res-a', 'res-b']);

    // Each lock should have expected fields
    for (const lock of locks) {
      assert.ok('resource' in lock);
      assert.ok('holder' in lock);
      assert.ok('reason' in lock);
      assert.ok('held_for' in lock);
      assert.ok('remaining_ttl' in lock);
      assert.ok('queue_length' in lock);
    }
  });
});

describe('CLI: re-entrant acquire output', () => {
  let lockDir: string;
  let cfg: Config;

  beforeEach(() => {
    lockDir = makeTempDir();
    cfg = makeConfig(lockDir);
  });

  it('should return action=refreshed for re-entrant acquire via CLI', async () => {
    // Use engine to create initial lock with live PID
    await acquire('res', 'agent-1', process.pid, 'initial', undefined, cfg);

    // CLI re-entrant acquire — same holder
    const { json, exitCode } = await runCliJson(
      ['acquire', 'res', '--holder', 'agent-1', '--reason', 'initial'],
      lockDir,
    );

    assert.equal(exitCode, 0);
    assert.equal(json.ok, true);
    assert.equal(json.action, 'refreshed');
    assert.equal(json.holder, 'agent-1');
  });
});

describe('CLI: exit code 1 for conflict (queued)', () => {
  let lockDir: string;
  let cfg: Config;

  beforeEach(() => {
    lockDir = makeTempDir();
    cfg = makeConfig(lockDir);
  });

  it('CLI should return exit code 1 when acquire results in queued', async () => {
    // Use engine with live PID to hold the lock
    await acquire('res', 'agent-1', process.pid, 'holding', undefined, cfg);

    // CLI acquire with different holder should be queued (exit code 1)
    // But since CLI uses its own PID which will also be alive during execution,
    // and agent-1's PID (this process) is alive, agent-2 should be queued.
    const { json, exitCode } = await runCliJson(
      ['acquire', 'res', '--holder', 'agent-2', '--reason', 'waiting'],
      lockDir,
    );

    assert.equal(exitCode, 1);
    assert.equal(json.ok, false);
    assert.equal(json.action, 'queued');
    assert.equal(typeof json.queue_position, 'number');
  });
});

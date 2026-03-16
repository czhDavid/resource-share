import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { acquire, release, status, clear } from './lock-engine.js';
import { init } from './init.js';

/**
 * Format a duration in milliseconds as a human-readable string.
 * Examples: "5m 30s", "1h 2m", "0s", "45s"
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds <= 0) return '0s';

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(' ');
}

/**
 * Print JSON to stdout and exit with the given code.
 */
function output(data: unknown, exitCode: number = 0): never {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  process.exit(exitCode);
}

const program = new Command();

program
  .name('agent-lock')
  .description('File-based locking tool for AI agent resource coordination')
  .version('0.1.0');

// Override commander's default exit behavior for errors to use exit code 2
program.exitOverride();
program.configureOutput({
  writeErr: (str) => {
    // Commander writes usage errors to stderr; we let that through
    process.stderr.write(str);
  },
  writeOut: (str) => {
    process.stdout.write(str);
  },
});

// ─── acquire ─────────────────────────────────────────────
program
  .command('acquire')
  .description('Acquire a lock on a resource')
  .argument('<resource>', 'Resource name to lock')
  .requiredOption('--holder <id>', 'Identifier for the agent acquiring the lock')
  .option('--reason <reason>', 'Reason for acquiring the lock', '')
  .option('--ttl <seconds>', 'Time-to-live in seconds')
  .action(async (resource: string, opts: { holder: string; reason: string; ttl?: string }) => {
    const ttl = opts.ttl ? parseInt(opts.ttl, 10) : undefined;
    if (opts.ttl && (isNaN(ttl!) || ttl! <= 0)) {
      return output(
        { ok: false, error: `Invalid --ttl value: "${opts.ttl}" — must be a positive integer` },
        2,
      );
    }

    const result = await acquire(resource, opts.holder, process.pid, opts.reason, ttl);

    if (result.status === 'acquired') {
      const lock = result.lock!;
      // Determine if this was a refresh (re-entrant) by checking the message
      const action =
        lock.reason === opts.reason && result.message.includes('re-entrant')
          ? 'refreshed'
          : 'acquired';

      output(
        {
          ok: true,
          action,
          resource: lock.resource,
          holder: lock.holder,
          reason: lock.reason,
          ttl: lock.ttl,
        },
        0,
      );
    } else {
      // Queued — need to read current holder info from status
      const statusResult = await status(resource);
      const rs = statusResult.resources[0];
      const currentLock = rs.lock!;

      output(
        {
          ok: false,
          action: 'queued',
          resource,
          holder: currentLock.holder,
          reason: currentLock.reason,
          acquired_at: new Date(currentLock.acquired_at).toISOString(),
          queue_position: result.position,
        },
        1,
      );
    }
  });

// ─── release ─────────────────────────────────────────────
program
  .command('release')
  .description('Release a lock on a resource')
  .argument('<resource>', 'Resource name to release')
  .requiredOption('--holder <id>', 'Identifier for the agent releasing the lock')
  .action(async (resource: string, opts: { holder: string }) => {
    // Read current lock state before releasing to compute held_for_ms
    const statusResult = await status(resource);
    const rs = statusResult.resources[0];

    const result = await release(resource, opts.holder);

    if (result.status === 'released') {
      const heldForMs =
        rs.lock && rs.lock.holder === opts.holder ? Date.now() - rs.lock.acquired_at : 0;

      output(
        {
          ok: true,
          action: 'released',
          resource,
          holder: opts.holder,
          held_for_ms: heldForMs,
        },
        0,
      );
    } else if (result.status === 'not_found') {
      // Distinguish between "not locked" and "locked by someone else"
      if (rs.locked) {
        output(
          {
            ok: false,
            action: 'release',
            resource,
            message: `Cannot release: lock held by '${rs.lock!.holder}', not '${opts.holder}'`,
          },
          1,
        );
      } else {
        output(
          {
            ok: false,
            action: 'release',
            resource,
            message: `Resource '${resource}' is not locked`,
          },
          1,
        );
      }
    }
  });

// ─── status ──────────────────────────────────────────────
program
  .command('status')
  .description('Get the status of one or all resources')
  .argument('[resource]', 'Resource name (omit for all)')
  .action(async (resource?: string) => {
    const result = await status(resource);

    if (resource) {
      // Single resource status
      const rs = result.resources[0];

      if (!rs || !rs.locked) {
        output(
          {
            resource: resource,
            locked: false,
            queue: [],
          },
          0,
        );
      } else {
        const lock = rs.lock!;
        const now = Date.now();
        const elapsedMs = now - lock.acquired_at;
        const elapsedSeconds = Math.floor(elapsedMs / 1000);
        const remainingTtl = Math.max(0, lock.ttl - elapsedSeconds);

        output(
          {
            resource: lock.resource,
            locked: true,
            holder: lock.holder,
            reason: lock.reason,
            pid: lock.pid,
            acquired_at: new Date(lock.acquired_at).toISOString(),
            held_for: formatDuration(elapsedMs),
            ttl: lock.ttl,
            remaining_ttl: remainingTtl,
            queue: rs.queue.map((entry, i) => ({
              holder: entry.holder,
              pid: entry.pid,
              enqueued_at: new Date(entry.enqueued_at).toISOString(),
              position: i + 1,
            })),
          },
          0,
        );
      }
    } else {
      // All locks
      const now = Date.now();
      const locks = result.resources
        .filter((rs) => rs.locked)
        .map((rs) => {
          const lock = rs.lock!;
          const elapsedMs = now - lock.acquired_at;
          const elapsedSeconds = Math.floor(elapsedMs / 1000);
          const remainingTtl = Math.max(0, lock.ttl - elapsedSeconds);

          return {
            resource: lock.resource,
            holder: lock.holder,
            reason: lock.reason,
            held_for: formatDuration(elapsedMs),
            remaining_ttl: remainingTtl,
            queue_length: rs.queue.length,
          };
        });

      output(
        {
          total: locks.length,
          locks,
        },
        0,
      );
    }
  });

// ─── clear ───────────────────────────────────────────────
program
  .command('clear')
  .description('Clear stale locks, or all locks with --force')
  .option('--force', 'Remove all locks regardless of status', false)
  .action(async (opts: { force: boolean }) => {
    const result = await clear(opts.force);

    output(
      {
        ok: true,
        action: 'clear',
        cleared: result.cleared.length,
        mode: opts.force ? 'force' : 'stale-only',
        message: `Cleared ${result.cleared.length} lock(s)`,
      },
      0,
    );
  });

// ─── init ───────────────────────────────────────────────
program
  .command('init')
  .description('Set up agent-lock skill and config in the current project')
  .option('--force', 'Overwrite existing files', false)
  .option('--dir <path>', 'Target project directory', process.cwd())
  .action((opts: { force: boolean; dir: string }) => {
    const result = init(opts.dir, opts.force);

    if (result.created.length === 0 && result.skipped.length > 0) {
      output(
        {
          ok: true,
          action: 'init',
          message: 'All files already exist. Use --force to overwrite.',
          skipped: result.skipped,
        },
        0,
      );
    } else {
      output(
        {
          ok: true,
          action: 'init',
          created: result.created,
          skipped: result.skipped,
          message:
            result.created.length > 0
              ? `Created ${result.created.length} file(s)`
              : 'Nothing to do',
        },
        0,
      );
    }
  });

// ─── mcp ────────────────────────────────────────────────
program
  .command('mcp')
  .description('Start the agent-lock MCP server (stdio transport)')
  .action(() => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const mcpServerPath = join(__dirname, 'mcp-server.js');

    try {
      execFileSync('node', [mcpServerPath], {
        stdio: 'inherit',
        env: process.env,
      });
    } catch {
      process.exit(1);
    }
  });

// ─── Parse and run ───────────────────────────────────────
try {
  await program.parseAsync(process.argv);
} catch (err: unknown) {
  // Commander throws on validation errors; ensure exit code 2
  if (err && typeof err === 'object' && 'exitCode' in err) {
    process.exit(2);
  }
  // Unexpected error
  const message = err instanceof Error ? err.message : String(err);
  output({ ok: false, error: message }, 2);
}

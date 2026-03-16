import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';

// Engine-level imports for tests that need live PIDs
import { acquire, release, status, clear } from '../src/lock-engine.js';
import type { Config } from '../src/config.js';

export { acquire, release, status, clear };
export type { Config };

const execFileAsync = promisify(execFile);

export const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli.js');

/**
 * Run the CLI with the given args and a temp lock directory.
 * Returns { stdout, stderr, exitCode }.
 */
export async function runCli(
  args: string[],
  lockDir: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI_PATH, ...args], {
      env: { ...process.env, AGENT_LOCK_DIR: lockDir },
      timeout: 10_000,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.code ?? 1,
    };
  }
}

/**
 * Run the CLI and parse the stdout as JSON.
 */
export async function runCliJson(
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
export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'agent-lock-test-'));
}

/**
 * Create a Config object pointing to the given temp directory.
 */
export function makeConfig(lockDir: string, defaultTtl: number = 7200): Config {
  return { lockDir, defaultTtl };
}

/**
 * Spawn a long-lived process and return its PID.
 * The process sleeps for 60 seconds (well beyond test duration).
 * Caller must kill it when done.
 */
export function spawnLongLived(): { pid: number; kill: () => void } {
  const child = spawn('sleep', ['60'], { stdio: 'ignore', detached: true });
  const pid = child.pid!;
  return {
    pid,
    kill: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already dead
      }
    },
  };
}

import type { LockMeta, QueueEntry } from './types.js';

/**
 * Check whether a process with the given PID is alive.
 * Uses `kill -0` which sends no signal but checks existence.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a lock has expired based on its TTL.
 * acquired_at + ttl < now → expired.
 */
export function isLockExpired(meta: LockMeta): boolean {
  const expiresAt = meta.acquired_at + meta.ttl * 1000;
  return Date.now() >= expiresAt;
}

/**
 * Check whether a lock is stale (holder process is dead OR TTL expired).
 * PID check is primary; TTL is the fallback.
 */
export function isLockStale(meta: LockMeta): boolean {
  if (!isPidAlive(meta.pid)) {
    return true;
  }
  return isLockExpired(meta);
}

/**
 * Filter out queue entries whose PIDs are no longer alive.
 * Returns only the entries with live processes.
 */
export function pruneDeadFromQueue(queue: QueueEntry[]): QueueEntry[] {
  return queue.filter((entry) => isPidAlive(entry.pid));
}

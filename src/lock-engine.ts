import type {
  LockMeta,
  QueueEntry,
  AcquireResult,
  ReleaseResult,
  ResourceStatus,
  StatusResult,
  ClearResult,
} from "./types.js";
import { resolveConfig, type Config } from "./config.js";
import { isLockStale, pruneDeadFromQueue } from "./pid.js";
import {
  atomicMkdir,
  ensureDir,
  readJson,
  writeJson,
  removeDir,
  resourceDir,
  metaPath,
  queuePath,
  listResources,
} from "./fs-utils.js";

/**
 * Read the queue for a resource, returning a bare array.
 * queue.json stores a bare JSON array: [entry1, entry2, ...]
 */
async function readQueue(lockDir: string, resource: string): Promise<QueueEntry[]> {
  const data = await readJson<QueueEntry[]>(queuePath(lockDir, resource));
  return data ?? [];
}

/**
 * Write the queue for a resource as a bare JSON array.
 */
async function writeQueue(lockDir: string, resource: string, queue: QueueEntry[]): Promise<void> {
  await writeJson(queuePath(lockDir, resource), queue);
}

/**
 * Promote the first live entry in the queue to lock holder.
 * Writes meta.json + queue.json into the (already-existing) resource dir.
 * Returns the new LockMeta if promoted, or null if queue was empty.
 */
async function promoteNextInQueue(
  lockDir: string,
  resource: string,
  queue: QueueEntry[],
  ttl: number,
): Promise<{ meta: LockMeta; remainingQueue: QueueEntry[] } | null> {
  const liveQueue = pruneDeadFromQueue(queue);
  if (liveQueue.length === 0) return null;

  const next = liveQueue[0];
  const remainingQueue = liveQueue.slice(1);

  const meta: LockMeta = {
    resource,
    holder: next.holder,
    pid: next.pid,
    reason: "",
    acquired_at: Date.now(),
    ttl,
  };
  await writeJson(metaPath(lockDir, resource), meta);
  await writeQueue(lockDir, resource, remainingQueue);

  return { meta, remainingQueue };
}

/**
 * Acquire a lock on a resource.
 *
 * Algorithm:
 * 1. Attempt atomic mkdir for the resource directory.
 * 2. If mkdir succeeds → write meta.json, initialize empty queue.json, return "acquired".
 * 3. If mkdir fails (lock exists):
 *    a. Read meta.json — check if holder is the same (re-entrant) → refresh lock, return "acquired".
 *    b. Check if current lock is stale (dead PID or TTL expired) →
 *       preserve queue, overwrite stale lock files in place, then check queue:
 *       - If queue has live entries and caller is NOT first → promote first, enqueue caller.
 *       - If queue is empty or caller IS first → grant lock to caller.
 *    c. Lock is valid and held by someone else → prune dead entries from queue, append this holder, return "queued".
 * 4. Return result with position in queue if queued.
 */
export async function acquire(
  resource: string,
  holder: string,
  pid: number,
  reason: string,
  ttlSeconds?: number,
  config?: Config,
): Promise<AcquireResult> {
  const cfg = config ?? resolveConfig();
  const ttl = ttlSeconds ?? cfg.defaultTtl;

  // Ensure base lock directory exists
  await ensureDir(cfg.lockDir);

  const resDir = resourceDir(cfg.lockDir, resource);

  // Step 1: Attempt atomic mkdir
  const created = await atomicMkdir(resDir);

  if (created) {
    // Step 2: We got the lock — write meta.json and empty queue
    const meta: LockMeta = {
      resource,
      holder,
      pid,
      reason,
      acquired_at: Date.now(),
      ttl,
    };
    await writeJson(metaPath(cfg.lockDir, resource), meta);
    await writeQueue(cfg.lockDir, resource, []);

    return {
      status: "acquired",
      resource,
      holder,
      message: `Lock acquired on "${resource}"`,
      lock: meta,
    };
  }

  // Step 3: Lock directory already exists
  const meta = await readJson<LockMeta>(metaPath(cfg.lockDir, resource));

  // 3a: Re-entrant acquire — same holder refreshes the lock
  if (meta && meta.holder === holder) {
    const refreshed: LockMeta = {
      ...meta,
      pid,
      reason,
      acquired_at: Date.now(),
      ttl,
    };
    await writeJson(metaPath(cfg.lockDir, resource), refreshed);

    return {
      status: "acquired",
      resource,
      holder,
      message: `Lock refreshed on "${resource}" (re-entrant)`,
      lock: refreshed,
    };
  }

  // 3b: Check if current lock is stale
  if (meta && isLockStale(meta)) {
    // Preserve the existing queue before overwriting the stale lock
    const existingQueue = pruneDeadFromQueue(await readQueue(cfg.lockDir, resource));

    // Overwrite stale lock files in place — no removeDir+ensureDir to avoid
    // a TOCTOU race where another agent could atomicMkdir in between.

    // Check if someone in the queue has priority over the caller
    const callerQueueIndex = existingQueue.findIndex((e) => e.holder === holder);

    if (existingQueue.length > 0 && (callerQueueIndex < 0 || callerQueueIndex > 0)) {
      // Someone else is first in queue — they get the lock, not the caller
      const promoted = await promoteNextInQueue(cfg.lockDir, resource, existingQueue, cfg.defaultTtl);

      if (promoted) {
        // Now enqueue the caller (remove from queue first if already there)
        const queueWithoutCaller = promoted.remainingQueue.filter((e) => e.holder !== holder);
        queueWithoutCaller.push({
          holder,
          pid,
          enqueued_at: Date.now(),
        });
        // Sort FIFO
        queueWithoutCaller.sort(
          (a, b) => a.enqueued_at - b.enqueued_at,
        );
        await writeQueue(cfg.lockDir, resource, queueWithoutCaller);

        const position = queueWithoutCaller.findIndex((e) => e.holder === holder) + 1;
        return {
          status: "queued",
          resource,
          holder,
          message: `Resource "${resource}" is locked by "${promoted.meta.holder}" (promoted from queue). Added to queue at position ${position}`,
          position,
        };
      }
    }

    // Queue is empty or caller is first in queue — grant lock to caller
    // Remove caller from queue if present
    const remainingQueue = existingQueue.filter((e) => e.holder !== holder);

    const newMeta: LockMeta = {
      resource,
      holder,
      pid,
      reason,
      acquired_at: Date.now(),
      ttl,
    };
    await writeJson(metaPath(cfg.lockDir, resource), newMeta);
    await writeQueue(cfg.lockDir, resource, remainingQueue);

    return {
      status: "acquired",
      resource,
      holder,
      message: `Lock acquired on "${resource}" (stale lock cleared)`,
      lock: newMeta,
    };
  }

  // 3c: Lock is valid and held by someone else — add to queue
  const queue = await readQueue(cfg.lockDir, resource);

  // Prune dead entries from queue
  const liveQueue = pruneDeadFromQueue(queue);

  // Check if this holder is already in the queue
  const existingIndex = liveQueue.findIndex((e) => e.holder === holder);
  if (existingIndex >= 0) {
    // Already queued — update PID in place, keep original enqueued_at
    liveQueue[existingIndex] = {
      holder,
      pid,
      enqueued_at: liveQueue[existingIndex].enqueued_at,
    };
  } else {
    // New queue entry
    liveQueue.push({
      holder,
      pid,
      enqueued_at: Date.now(),
    });
  }

  // Sort by enqueued_at for FIFO ordering
  liveQueue.sort(
    (a, b) => a.enqueued_at - b.enqueued_at,
  );

  await writeQueue(cfg.lockDir, resource, liveQueue);

  // Position is 1-indexed
  const position = liveQueue.findIndex((e) => e.holder === holder) + 1;

  return {
    status: "queued",
    resource,
    holder,
    message: `Resource "${resource}" is locked by "${meta!.holder}". Added to queue at position ${position}`,
    position,
  };
}

/**
 * Release a lock on a resource.
 *
 * - Only the current holder can release.
 * - On release, if there are queued agents, the next in FIFO order auto-acquires.
 * - If the holder is in the queue (not the lock holder), remove them from the queue.
 */
export async function release(
  resource: string,
  holder: string,
  config?: Config,
): Promise<ReleaseResult> {
  const cfg = config ?? resolveConfig();
  const resDir = resourceDir(cfg.lockDir, resource);
  const meta = await readJson<LockMeta>(metaPath(cfg.lockDir, resource));

  if (!meta) {
    return {
      status: "not_found",
      resource,
      holder,
      message: `No lock found for resource "${resource}"`,
    };
  }

  // If the holder is the current lock holder → release the lock
  if (meta.holder === holder) {
    // Read queue and prune dead entries
    const queue = pruneDeadFromQueue(await readQueue(cfg.lockDir, resource));

    if (queue.length > 0) {
      // Promote next in queue by overwriting files in place — avoids
      // a TOCTOU race from removeDir+ensureDir where another agent
      // could atomicMkdir in between.
      const next = queue[0];
      const remainingQueue = queue.slice(1);

      const newMeta: LockMeta = {
        resource,
        holder: next.holder,
        pid: next.pid,
        reason: "",
        acquired_at: Date.now(),
        ttl: cfg.defaultTtl,
      };
      await writeJson(metaPath(cfg.lockDir, resource), newMeta);
      await writeQueue(cfg.lockDir, resource, remainingQueue);
    } else {
      // No one waiting — remove the lock directory entirely
      await removeDir(resDir);
    }

    return {
      status: "released",
      resource,
      holder,
      message: `Lock on "${resource}" released by "${holder}"`,
    };
  }

  // If the holder is in the queue → remove them from the queue
  const queue = await readQueue(cfg.lockDir, resource);
  const filteredQueue = queue.filter((e) => e.holder !== holder);

  if (filteredQueue.length !== queue.length) {
    await writeQueue(cfg.lockDir, resource, filteredQueue);
    return {
      status: "released",
      resource,
      holder,
      message: `"${holder}" removed from queue for "${resource}"`,
    };
  }

  return {
    status: "not_found",
    resource,
    holder,
    message: `"${holder}" does not hold the lock on "${resource}" and is not in the queue`,
  };
}

/**
 * Get the status of one or all resources.
 *
 * - Prunes dead PIDs from queues during status checks.
 * - If a lock is stale, it is cleaned up and the next queued agent auto-acquires.
 */
export async function status(
  resource?: string,
  config?: Config,
): Promise<StatusResult> {
  const cfg = config ?? resolveConfig();

  if (resource) {
    const rs = await getResourceStatus(resource, cfg);
    return { resources: [rs] };
  }

  // All resources
  const resources = await listResources(cfg.lockDir);
  const results: ResourceStatus[] = [];
  for (const res of resources) {
    results.push(await getResourceStatus(res, cfg));
  }

  return { resources: results };
}

/**
 * Get status for a single resource, pruning stale locks and dead queue entries.
 */
async function getResourceStatus(
  resource: string,
  cfg: Config,
): Promise<ResourceStatus> {
  let meta = await readJson<LockMeta>(metaPath(cfg.lockDir, resource));
  let queue = pruneDeadFromQueue(await readQueue(cfg.lockDir, resource));

  // If the lock is stale, clean it up
  if (meta && isLockStale(meta)) {
    if (queue.length > 0) {
      // Auto-promote next in queue by overwriting files in place — avoids
      // a TOCTOU race from removeDir+ensureDir.
      const promoted = await promoteNextInQueue(cfg.lockDir, resource, queue, cfg.defaultTtl);
      if (promoted) {
        meta = promoted.meta;
        queue = promoted.remainingQueue;
      } else {
        // All queue entries were dead — remove the directory entirely
        await removeDir(resourceDir(cfg.lockDir, resource));
        meta = null;
      }
    } else {
      // No queue — remove the stale lock directory entirely
      await removeDir(resourceDir(cfg.lockDir, resource));
      meta = null;
    }
  } else {
    // Persist pruned queue if it changed
    const rawQueue = await readQueue(cfg.lockDir, resource);
    if (queue.length !== rawQueue.length) {
      await writeQueue(cfg.lockDir, resource, queue);
    }
  }

  if (!meta) {
    return {
      resource,
      locked: false,
      lock: null,
      queue: [],
    };
  }

  return {
    resource,
    locked: true,
    lock: meta,
    queue,
  };
}

/**
 * Clear all locks, or only stale ones.
 *
 * --force: Remove all locks regardless of status.
 * default: Only remove locks with dead PIDs or expired TTLs.
 */
export async function clear(
  force: boolean = false,
  config?: Config,
): Promise<ClearResult> {
  const cfg = config ?? resolveConfig();
  const resources = await listResources(cfg.lockDir);

  const cleared: string[] = [];
  const active: string[] = [];

  for (const resource of resources) {
    const meta = await readJson<LockMeta>(metaPath(cfg.lockDir, resource));

    if (force || !meta || isLockStale(meta)) {
      await removeDir(resourceDir(cfg.lockDir, resource));
      cleared.push(resource);
    } else {
      active.push(resource);
    }
  }

  if (active.length > 0 && !force) {
    return {
      status: "has_active_locks",
      cleared,
      active,
      message: `Cleared ${cleared.length} stale lock(s). ${active.length} active lock(s) remain. Use --force to clear all.`,
    };
  }

  return {
    status: "cleared",
    cleared,
    active: [],
    message: `Cleared ${cleared.length} lock(s)`,
  };
}

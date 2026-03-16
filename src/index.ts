/**
 * agent-lock — core library exports
 */
export { acquire, release, status, clear } from './lock-engine.js';
export type {
  LockMeta,
  QueueEntry,
  AcquireResult,
  ReleaseResult,
  ResourceStatus,
  StatusResult,
  ClearResult,
} from './types.js';
export { resolveConfig, type Config } from './config.js';
export { isPidAlive, isLockExpired, isLockStale, pruneDeadFromQueue } from './pid.js';

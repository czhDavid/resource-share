/**
 * Lock metadata stored in <lock-dir>/<resource>.lock/meta.json
 */
export interface LockMeta {
  resource: string;
  holder: string;
  pid: number;
  reason: string;
  acquired_at: number; // Unix millisecond timestamp
  ttl: number;
}

/**
 * A single entry in the FIFO wait queue.
 * Stored as a bare array in <lock-dir>/<resource>.lock/queue.json
 */
export interface QueueEntry {
  holder: string;
  pid: number;
  enqueued_at: number; // Unix millisecond timestamp
}

/**
 * Result of an acquire operation.
 */
export interface AcquireResult {
  status: 'acquired' | 'queued';
  resource: string;
  holder: string;
  message: string;
  position?: number; // present when status is "queued"
  lock?: LockMeta; // present when status is "acquired"
}

/**
 * Result of a release operation.
 */
export interface ReleaseResult {
  status: 'released' | 'not_found';
  resource: string;
  holder: string;
  message: string;
}

/**
 * Status of a single resource.
 */
export interface ResourceStatus {
  resource: string;
  locked: boolean;
  lock: LockMeta | null;
  queue: QueueEntry[];
}

/**
 * Result of a status query.
 */
export interface StatusResult {
  resources: ResourceStatus[];
}

/**
 * Result of a clear operation.
 */
export interface ClearResult {
  status: 'cleared' | 'has_active_locks';
  cleared: string[];
  active: string[];
  message: string;
}

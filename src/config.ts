/**
 * Configuration resolution from environment variables with defaults.
 *
 * AGENT_LOCK_DIR — base directory for lock files (default: /tmp/agent-locks)
 * AGENT_LOCK_TTL — default TTL in seconds (default: 7200)
 */

export interface Config {
  lockDir: string;
  defaultTtl: number;
}

const DEFAULT_LOCK_DIR = "/tmp/agent-locks";
const DEFAULT_TTL = 7200;

export function resolveConfig(): Config {
  const lockDir = process.env.AGENT_LOCK_DIR || DEFAULT_LOCK_DIR;
  const ttlStr = process.env.AGENT_LOCK_TTL;
  const defaultTtl = ttlStr ? parseInt(ttlStr, 10) : DEFAULT_TTL;

  if (ttlStr && (isNaN(defaultTtl) || defaultTtl <= 0)) {
    throw new Error(`Invalid AGENT_LOCK_TTL: "${ttlStr}" — must be a positive integer`);
  }

  return { lockDir, defaultTtl };
}

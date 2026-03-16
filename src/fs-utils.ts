import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Attempt to atomically create a lock directory.
 * Uses mkdir which fails if the directory already exists — this is the
 * atomic primitive for lock creation.
 *
 * Returns true if the directory was created (lock acquired),
 * false if it already exists (lock held by someone).
 */
export async function atomicMkdir(dirPath: string): Promise<boolean> {
  try {
    await mkdir(dirPath, { recursive: false });
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw err;
  }
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

/**
 * Read and parse a JSON file. Returns null if the file does not exist.
 */
export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const data = await readFile(filePath, 'utf-8');
    return JSON.parse(data) as T;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Write an object as JSON to a file.
 */
export async function writeJson<T>(filePath: string, data: T): Promise<void> {
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Remove a directory and all its contents recursively.
 */
export async function removeDir(dirPath: string): Promise<void> {
  await rm(dirPath, { recursive: true, force: true });
}

/**
 * Get the path to a resource's lock directory.
 * Uses .lock suffix per spec: <lock-dir>/<resource>.lock/
 */
export function resourceDir(lockDir: string, resource: string): string {
  return join(lockDir, `${resource}.lock`);
}

/**
 * Get the path to a resource's meta.json.
 */
export function metaPath(lockDir: string, resource: string): string {
  return join(lockDir, `${resource}.lock`, 'meta.json');
}

/**
 * Get the path to a resource's queue.json.
 */
export function queuePath(lockDir: string, resource: string): string {
  return join(lockDir, `${resource}.lock`, 'queue.json');
}

/**
 * List all resource directories in the lock dir.
 * Strips the .lock suffix to return clean resource names.
 * Returns an empty array if the lock dir does not exist.
 */
export async function listResources(lockDir: string): Promise<string[]> {
  if (!existsSync(lockDir)) {
    return [];
  }
  const entries = await readdir(lockDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && e.name.endsWith('.lock'))
    .map((e) => e.name.replace(/\.lock$/, ''));
}

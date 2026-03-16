import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { acquire, release, status, clear } from './lock-engine.js';
import { loadResourceConfig, isValidResource, type ResourceConfig } from './resource-config.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── Logging ────────────────────────────────────────────
const logDir = process.env.AGENT_LOCK_LOG_DIR ?? '/tmp/agent-lock-logs';
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, `mcp-server-${process.pid}.log`);

function log(level: 'INFO' | 'ERROR', message: string): void {
  const line = `${new Date().toISOString()} [${level}] [pid:${process.pid}] ${message}\n`;
  console.error(line.trimEnd());
  try {
    appendFileSync(logFile, line);
  } catch {
    /* ignore write failures */
  }
}

const configPath = process.env.AGENT_LOCK_CONFIG;
if (!configPath) {
  log('ERROR', 'AGENT_LOCK_CONFIG environment variable is required');
  process.exit(1);
}

let resourceConfig: ResourceConfig;
try {
  resourceConfig = loadResourceConfig(configPath);
  log(
    'INFO',
    `Loaded ${Object.keys(resourceConfig.resources).length} resource(s) from ${configPath}`,
  );
} catch (err) {
  log('ERROR', `Config load failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

function validateResource(resource: string): string | null {
  if (!isValidResource(resourceConfig, resource)) {
    const available = Object.keys(resourceConfig.resources).join(', ');
    return `Unknown resource "${resource}". Available resources: ${available}`;
  }
  return null;
}

const server = new McpServer(
  {
    name: 'agent-lock',
    version: '0.1.0',
  },
  {
    instructions:
      'This server coordinates shared resource access between multiple Claude Code instances. ' +
      'On startup, call agent_lock_resources to load the list of shared resources. ' +
      'Before running any command that uses a shared resource, you MUST acquire the lock first and release it when done.',
  },
);

server.registerTool(
  'agent_lock_resources',
  {
    description:
      'IMPORTANT: Call this BEFORE running any command that starts services, modifies shared state, or uses shared infrastructure (e.g. make up, docker compose, database migrations, deploy scripts). Returns the list of shared resources and when each must be locked. If your planned action matches a resource description, you MUST acquire the lock first.',
    inputSchema: {},
  },
  async () => {
    log('INFO', 'tool=resources');
    const lines = Object.entries(resourceConfig.resources).map(
      ([name, def]) => `- ${name}: ${def.description}`,
    );
    const text = [
      'Shared resources — you MUST lock before use:',
      '',
      ...lines,
      '',
      '## Required workflow',
      '1. Call agent_lock_acquire BEFORE running any command related to a resource above.',
      "2. If status is 'queued', STOP — do NOT run the command. Inform the user another agent holds the lock.",
      "3. If status is 'acquired', proceed with your command.",
      '4. Call agent_lock_release as soon as you are done.',
      '5. If you encounter errors (port conflicts, resource busy), call agent_lock_status to check if another agent holds the lock.',
      '',
      "Use your session ID or a unique name as the holder (e.g. 'claude-session-1').",
    ].join('\n');
    return {
      content: [{ type: 'text' as const, text }],
    };
  },
);

server.registerTool(
  'agent_lock_acquire',
  {
    description:
      "Acquire a lock on a shared resource. Call agent_lock_resources first to check which resources need locking. If the result status is 'queued', do NOT proceed with your command — inform the user that another agent holds the lock and they must wait. If 'acquired', proceed. Always call agent_lock_release when done.",
    inputSchema: {
      resource: z.string().describe('Resource name to lock'),
      holder: z.string().describe('Your unique agent identifier'),
      reason: z.string().optional().describe('Why you need this lock'),
      ttl: z.number().positive().optional().describe('Time-to-live in seconds (default: 7200)'),
    },
  },
  async ({ resource, holder, reason, ttl }) => {
    log(
      'INFO',
      `tool=acquire resource=${resource} holder=${holder} reason="${reason ?? ''}" ttl=${ttl ?? 'default'}`,
    );
    const err = validateResource(resource);
    if (err) {
      log('ERROR', `tool=acquire validation failed: ${err}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: err }) }],
      };
    }

    try {
      const result = await acquire(resource, holder, process.pid, reason ?? '', ttl);
      log('INFO', `tool=acquire result=${result.status} resource=${resource} holder=${holder}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('ERROR', `tool=acquire error: ${msg}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: msg }) }],
      };
    }
  },
);

server.registerTool(
  'agent_lock_release',
  {
    description:
      'Release a lock when you are done using a shared resource. ALWAYS call this after completing work on a locked resource — do not leave locks held. If other agents are queued, the next one is automatically promoted.',
    inputSchema: {
      resource: z.string().describe('Resource name to release'),
      holder: z.string().describe('Your unique agent identifier'),
    },
  },
  async ({ resource, holder }) => {
    log('INFO', `tool=release resource=${resource} holder=${holder}`);
    const err = validateResource(resource);
    if (err) {
      log('ERROR', `tool=release validation failed: ${err}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: err }) }],
      };
    }

    try {
      const result = await release(resource, holder);
      log('INFO', `tool=release result=${result.status} resource=${resource} holder=${holder}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('ERROR', `tool=release error: ${msg}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: msg }) }],
      };
    }
  },
);

server.registerTool(
  'agent_lock_status',
  {
    description:
      "Check who holds a lock and who is waiting. Use this when you encounter errors that suggest resource contention (port conflicts, 'already running', permission denied on shared files). Also useful to check before acquiring.",
    inputSchema: {
      resource: z.string().optional().describe('Resource name to check (omit for all resources)'),
    },
  },
  async ({ resource }) => {
    log('INFO', `tool=status resource=${resource ?? 'all'}`);
    if (resource) {
      const err = validateResource(resource);
      if (err) {
        log('ERROR', `tool=status validation failed: ${err}`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: err }) }],
        };
      }
    }

    try {
      const result = await status(resource);
      log('INFO', `tool=status result: ${result.resources.length} resource(s)`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('ERROR', `tool=status error: ${msg}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: msg }) }],
      };
    }
  },
);

server.registerTool(
  'agent_lock_clear',
  {
    description:
      'Clear stale locks (from dead processes). Use force to clear all locks regardless of status.',
    inputSchema: {
      force: z
        .boolean()
        .optional()
        .describe('Remove all locks, not just stale ones (default: false)'),
    },
  },
  async ({ force }) => {
    log('INFO', `tool=clear force=${force ?? false}`);
    try {
      const result = await clear(force ?? false);
      log('INFO', `tool=clear cleared=${result.cleared.length}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('ERROR', `tool=clear error: ${msg}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: msg }) }],
      };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('INFO', `server started, log file: ${logFile}`);
}

main().catch((error) => {
  log('ERROR', `Fatal: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSkillMd(): string {
  // In dist/, the skill file is at ../skills/SKILL.md relative to the compiled JS
  const skillSrc = join(__dirname, '..', 'skills', 'SKILL.md');
  return readFileSync(skillSrc, 'utf-8');
}

const CONFIG_YAML = `# agent-lock resource configuration
# Define the resources that agents can lock.
# Only resources listed here can be acquired.

resources:
  application:
    description: "Before you run an application using make up or docker compose, you need to acquire the application lock. This ensures that only one instance of the application is running at a time."
`;

interface McpJsonConfig {
  mcpServers: Record<
    string,
    {
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  >;
}

interface InitResult {
  created: string[];
  skipped: string[];
}

export function init(targetDir: string, force: boolean): InitResult {
  const created: string[] = [];
  const skipped: string[] = [];

  const skillDir = join(targetDir, '.claude', 'skills', 'agent-lock-guard');
  const skillPath = join(skillDir, 'SKILL.md');
  const configPath = join(targetDir, 'agent-lock.config.yaml');
  const mcpJsonPath = join(targetDir, '.mcp.json');

  // Write SKILL.md
  if (force || !existsSync(skillPath)) {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, readSkillMd(), 'utf-8');
    created.push('.claude/skills/agent-lock-guard/SKILL.md');
  } else {
    skipped.push('.claude/skills/agent-lock-guard/SKILL.md');
  }

  // Write config
  if (force || !existsSync(configPath)) {
    writeFileSync(configPath, CONFIG_YAML, 'utf-8');
    created.push('agent-lock.config.yaml');
  } else {
    skipped.push('agent-lock.config.yaml');
  }

  // Write or merge .mcp.json
  const agentLockEntry = {
    command: 'npx',
    args: ['-y', 'agent-lock', 'mcp'],
    env: {
      AGENT_LOCK_CONFIG: './agent-lock.config.yaml',
    },
  };

  if (force || !existsSync(mcpJsonPath)) {
    const mcpConfig: McpJsonConfig = {
      mcpServers: {
        'agent-lock': agentLockEntry,
      },
    };
    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf-8');
    created.push('.mcp.json');
  } else {
    // Merge into existing .mcp.json
    try {
      const existing: McpJsonConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      if (!existing.mcpServers) {
        existing.mcpServers = {};
      }
      if (!existing.mcpServers['agent-lock']) {
        existing.mcpServers['agent-lock'] = agentLockEntry;
        writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
        created.push('.mcp.json (merged)');
      } else {
        skipped.push('.mcp.json');
      }
    } catch {
      skipped.push('.mcp.json (parse error, not modified)');
    }
  }

  return { created, skipped };
}

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export interface ResourceDef {
  description: string;
}

export interface ResourceConfig {
  resources: Record<string, ResourceDef>;
}

/**
 * Load and validate the resource config from a YAML file.
 * Path is resolved from AGENT_LOCK_CONFIG env var.
 */
export function loadResourceConfig(configPath: string): ResourceConfig {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw);

  if (!parsed || typeof parsed !== "object" || !parsed.resources) {
    throw new Error(`Invalid config: missing "resources" key in ${configPath}`);
  }

  const resources: Record<string, ResourceDef> = {};

  for (const [name, value] of Object.entries(parsed.resources)) {
    if (!value || typeof value !== "object" || !("description" in (value as object))) {
      throw new Error(`Invalid config: resource "${name}" must have a "description" field`);
    }
    resources[name] = { description: (value as { description: string }).description };
  }

  if (Object.keys(resources).length === 0) {
    throw new Error(`Invalid config: no resources defined in ${configPath}`);
  }

  return { resources };
}

/**
 * Check if a resource name is defined in the config.
 */
export function isValidResource(config: ResourceConfig, resource: string): boolean {
  return resource in config.resources;
}

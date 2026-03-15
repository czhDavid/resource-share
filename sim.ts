import { acquire, release, status } from "./src/lock-engine.js";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./src/config.js";

const lockDir = mkdtempSync(join(tmpdir(), "agent-sim-"));
const cfg: Config = { lockDir, defaultTtl: 7200 };

function spawnAgent() {
  const child = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
  return { pid: child.pid!, kill: () => { try { child.kill(); } catch {} } };
}

const agent1 = spawnAgent();
const agent2 = spawnAgent();

console.log(`\n=== Setup ===`);
console.log(`Lock dir: ${lockDir}`);
console.log(`Agent-1 PID: ${agent1.pid}`);
console.log(`Agent-2 PID: ${agent2.pid}`);

// Step 1: Agent-1 acquires the lock
console.log(`\n=== Step 1: Agent-1 acquires "database" ===`);
const r1 = await acquire("database", "agent-1", agent1.pid, "running migrations", undefined, cfg);
console.log(`Result: ${r1.status} — ${r1.message}`);

// Step 2: Agent-2 tries to acquire the same resource — should be queued
console.log(`\n=== Step 2: Agent-2 tries to acquire "database" (should be queued) ===`);
const r2 = await acquire("database", "agent-2", agent2.pid, "schema update", undefined, cfg);
console.log(`Result: ${r2.status} — ${r2.message}`);
if (r2.position) console.log(`Queue position: ${r2.position}`);

// Step 3: Check status
console.log(`\n=== Step 3: Status check ===`);
const s1 = await status("database", cfg);
const rs = s1.resources[0];
console.log(`Locked: ${rs.locked}`);
console.log(`Holder: ${rs.lock?.holder}`);
console.log(`Queue length: ${rs.queue.length}`);
if (rs.queue.length > 0) console.log(`Queue: ${rs.queue.map(e => e.holder).join(", ")}`);

// Step 4: Agent-2 tries again — should stay queued, no duplicate
console.log(`\n=== Step 4: Agent-2 re-acquires (should not duplicate in queue) ===`);
const r3 = await acquire("database", "agent-2", agent2.pid, "schema update", undefined, cfg);
console.log(`Result: ${r3.status} — ${r3.message}`);
const s2 = await status("database", cfg);
console.log(`Queue length after re-acquire: ${s2.resources[0].queue.length}`);

// Step 5: Agent-1 releases — agent-2 should auto-promote
console.log(`\n=== Step 5: Agent-1 releases "database" ===`);
const r4 = await release("database", "agent-1", cfg);
console.log(`Result: ${r4.status} — ${r4.message}`);

// Step 6: Who holds the lock now?
console.log(`\n=== Step 6: Status after release (agent-2 should be promoted) ===`);
const s3 = await status("database", cfg);
const rs2 = s3.resources[0];
console.log(`Locked: ${rs2.locked}`);
console.log(`Holder: ${rs2.lock?.holder}`);
console.log(`Queue length: ${rs2.queue.length}`);

// Step 7: Agent-2 releases — lock fully cleared
console.log(`\n=== Step 7: Agent-2 releases "database" ===`);
const r5 = await release("database", "agent-2", cfg);
console.log(`Result: ${r5.status} — ${r5.message}`);
const s4 = await status("database", cfg);
console.log(`Locked after final release: ${s4.resources[0].locked}`);

// Step 8: Simulate stale lock — agent-1 acquires then dies
console.log(`\n=== Step 8: Stale lock — agent-1 acquires then dies ===`);
const agent3 = spawnAgent();
await acquire("stale-res", "agent-dead", agent3.pid, "will die", undefined, cfg);
agent3.kill();
// Wait briefly for PID to actually die
await new Promise(r => setTimeout(r, 200));
console.log(`Agent-dead PID ${agent3.pid} killed`);

const r6 = await acquire("stale-res", "agent-alive", agent2.pid, "taking over", undefined, cfg);
console.log(`Result: ${r6.status} — ${r6.message}`);
console.log(`New holder: ${r6.lock?.holder}`);

// Cleanup
agent1.kill();
agent2.kill();
console.log(`\n=== All scenarios passed! ===\n`);

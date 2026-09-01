/**
 * CLI for the bootstrap (design §10.2).
 *
 *   npm run seed              apply
 *   npm run seed -- --dry-run print the plan and write nothing
 *
 * The work is in seed.ts; this file is argument parsing and printing.
 */

import { closePool, inTransaction } from '../db.ts';
import { applySeed, buildPlan } from './seed.ts';
import { IMPORT_EXCLUSIONS, IMPORT_RENAMES } from './grandfathered.ts';

const dryRun = process.argv.includes('--dry-run');
const plan = buildPlan();

if (dryRun) {
  console.log(
    `\nBootstrap plan — ${plan.all.length} allocations (${plan.observed.length} observed on cp.padi.io, ${plan.infrastructure.length} withheld with no records)\n`,
  );
  for (const p of plan.all) {
    const claimant = p.pendingClaimant ? `  → pending: ${p.pendingClaimant}` : '';
    const closed = p.closedToRegistration ? '  [closed to registration]' : '';
    console.log(
      `  ${p.tlp.padEnd(12)} ${p.disposition.padEnd(17)} ${String(p.records).padStart(2)} rec${claimant}${closed}`,
    );
  }
  for (const tlp of plan.reserved) {
    console.log(`  ${tlp.padEnd(12)} spec-reserved     no allocation row is created, ever`);
  }

  console.log('\nImport exclusions:');
  for (const e of IMPORT_EXCLUSIONS) console.log(`  ${e.name} — ${e.reason}`);
  console.log('\nImport renames:');
  for (const r of IMPORT_RENAMES) console.log(`  ${r.from} → ${r.to}`);
  console.log('\nNothing written (--dry-run).\n');
} else {
  try {
    const result = await inTransaction((db) => applySeed(db, plan));
    console.log(`Bootstrap: ${result.created} allocations created, ${result.skipped} already present.`);
  } finally {
    await closePool();
  }
}

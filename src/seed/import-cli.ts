/**
 * CLI for the Phase 0 Profile import (design §10.4).
 *
 *   npm run import -- --file ../cp-padi-io-profiles.json
 *   npm run import -- --file <path> --dry-run
 *
 * Requires the bootstrap seed to have run first: every imported name needs the
 * allocation of its Prefix to exist (§12.1).
 */

import { readFileSync } from 'node:fs';
import { closePool, inTransaction } from '../db.ts';
import { parseCorpus } from '../profile/legacy.ts';
import { planImport } from '../profile/import.ts';
import { runImport } from './import-profiles.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fileIndex = args.indexOf('--file');
const file = fileIndex === -1 ? undefined : args[fileIndex + 1];

if (!file) {
  console.error('usage: npm run import -- --file <corpus.json> [--dry-run]');
  process.exit(2);
}

const corpus = parseCorpus(JSON.parse(readFileSync(file, 'utf8')));
const plan = planImport(corpus);

console.log(`\nImport plan — ${corpus.length} source records\n`);
console.log(`  ${String(plan.registeredNames.length).padStart(3)} names registered`);
console.log(`  ${String(plan.imported.length).padStart(3)} versions published`);
console.log(`  ${String(plan.conforming).padStart(3)} versions meet §9.4 (${plan.conformingNames} distinct names)`);
console.log(`  ${String(plan.nonConforming).padStart(3)} versions publish recorded shortfalls`);
console.log(`  ${String(plan.registeredWithoutVersions.length).padStart(3)} names registered with nothing published`);
console.log(`  ${String(plan.excluded.length).padStart(3)} excluded\n`);

if (Object.keys(plan.shortfalls).length > 0) {
  console.log('  Missing REQUIRED Header fields, recorded not filled (§10.4):');
  for (const [field, count] of Object.entries(plan.shortfalls).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${field.padEnd(14)} ${count}`);
  }
  console.log();
}

for (const excluded of plan.excluded) console.log(`  EXCLUDED  ${excluded.name} — ${excluded.reason}`);
for (const renamed of plan.renamed) console.log(`  RENAMED   ${renamed.from} → ${renamed.to}`);
console.log();

if (dryRun) {
  console.log('Nothing written (--dry-run).\n');
} else {
  try {
    const result = await inTransaction((db) => runImport(db, corpus, plan));
    console.log(
      `Imported: ${result.namesRegistered} names registered, ${result.versionsPublished} versions published, ${result.namesSkipped} already present.\n`,
    );
  } finally {
    await closePool();
  }
}

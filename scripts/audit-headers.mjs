#!/usr/bin/env node
/**
 * Audit every published version's Header identity (spec §6.4).
 *
 * A frozen document must say which version it is: Header.Version, Pub Date
 * and Status, agreeing with the Registry's own row. Two early versions were
 * frozen without them (the publish path stamped nothing before 10 Sept 2026);
 * this reports any version in that or a similar state, so the defect list is
 * measured rather than remembered.
 *
 * Read-only. Run: npm run audit:headers   (DATABASE_URL from .env)
 */

import pg from 'pg';

/** Order-insensitive serialization, for comparing documents as documents. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const { rows } = await pool.query(`
  SELECT p.name, v.version, v.status AS row_status, v.published_at,
         v.content, v.served_bytes, v.missing_header_fields
    FROM profile_version v
    JOIN profile p ON p.id = v.profile_id
   ORDER BY p.name, v.version
`);

let clean = 0;
const findings = [];

for (const row of rows) {
  const header = (row.content ?? {}).Header ?? {};
  const problems = [];

  if (header['Version'] === undefined) problems.push('no Version');
  else if (header['Version'] !== String(row.version)) {
    problems.push(`Version says "${header['Version']}", row says ${row.version}`);
  }

  if (header['Pub Date'] === undefined) problems.push('no Pub Date');
  if (header['Status'] === undefined) problems.push('no Status');
  // A deprecated row still says Published in the frozen document — deprecation
  // is additive metadata (§19), never a mutation. Only absence is a problem.

  // The stored bytes are what resolution replays; they must be the SAME
  // DOCUMENT as the structured copy. Compare canonically (sorted keys):
  // JSONB does not preserve key order, so a byte comparison would flag every
  // row over ordering alone — order is presentation here, not content.
  if (row.served_bytes) {
    const replayed = JSON.parse(Buffer.from(row.served_bytes).toString('utf8'));
    if (canonical(replayed) !== canonical(row.content)) {
      problems.push('served_bytes disagree with content');
    }
  }

  if (problems.length === 0) clean++;
  else findings.push({ ref: `${row.name}:${row.version}`, problems });
}

console.log(`${rows.length} published versions · ${clean} carry full Header identity`);

if (findings.length === 0) {
  console.log('OK    every frozen document says which version it is (§6.4).');
} else {
  console.log(`\n${findings.length} version(s) frozen without full identity (immutable — recorded, not fixable):\n`);
  for (const f of findings) console.log(`  ${f.ref.padEnd(32)} ${f.problems.join(' · ')}`);
  console.log('\nRemedy per spec §6.2: publish the same content as a new version and deprecate the old.');
}

await pool.end();

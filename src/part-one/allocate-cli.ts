/**
 * CLI for allocating a new Top Level Prefix — the §9.2 operator act, Phase 0.
 *
 *   npm run allocate -- --tlp cimetrics --org "Cimetrics Inc." \
 *     --website https://cimetrics.com --evidence "operator verified control of cimetrics.com" \
 *     --term-years 2 --member-me [--dry-run]
 *
 * The work is in allocate.ts; this file is argument parsing and printing.
 * The audit actor is the operator: --principal or CP_AUTHOR_PRINCIPAL names
 * the human making the ruling (§4.3).
 */

import { parseArgs } from 'node:util';
import { closePool, inTransaction } from '../db.ts';
import { allocateTlp, checkAllocatable, type AllocateRequest } from './allocate.ts';

const { values } = parseArgs({
  options: {
    'tlp': { type: 'string' },
    'org': { type: 'string' },
    'website': { type: 'string' },
    'email': { type: 'string' },
    'evidence': { type: 'string' },
    'term-years': { type: 'string' },
    'notes': { type: 'string' },
    'member-user-id': { type: 'string' },
    'member-me': { type: 'boolean' },
    'principal': { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
});

function usage(problem: string): never {
  console.error(`${problem}\n`);
  console.error('Usage: npm run allocate -- --tlp <prefix> --org "<holder>" --evidence "<§8.1 evidence>"');
  console.error('  [--website <url>] [--email <contact>] [--term-years <n>] [--notes "<published note>"]');
  console.error('  [--member-user-id <app_user uuid> | --member-me] [--principal <who rules>] [--dry-run]');
  process.exit(1);
}

if (!values.tlp) usage('--tlp is required.');
if (!values.org) usage('--org is required.');
if (!values.evidence) usage('--evidence is required: an allocation ruling names what was verified, and how (§8.1).');

const principal = values.principal ?? process.env['CP_AUTHOR_PRINCIPAL'];
if (!principal) usage('--principal (or CP_AUTHOR_PRINCIPAL in .env) is required: the ruling is a human decision (§4.3).');

const memberUserId = values['member-me'] ? process.env['CP_AUTHOR_USER_ID'] : values['member-user-id'];
if (values['member-me'] && !memberUserId) usage('--member-me needs CP_AUTHOR_USER_ID in .env.');

let termYears: number | undefined;
if (values['term-years'] !== undefined) {
  termYears = Number(values['term-years']);
  if (!Number.isInteger(termYears) || termYears < 1 || termYears > 100) {
    usage('--term-years is a whole number of years, 1 to 100 (§8.2).');
  }
}

const request: AllocateRequest = {
  tlp: values.tlp,
  organization: {
    name: values.org,
    ...(values.website ? { website: values.website } : {}),
    ...(values.email ? { contactEmail: values.email } : {}),
  },
  evidence: values.evidence,
  ...(termYears !== undefined ? { termYears } : {}),
  ...(values.notes ? { notes: values.notes } : {}),
  ...(memberUserId ? { memberUserId } : {}),
  actor: { id: 'cli:allocate', kind: 'operator', principal },
};

try {
  if (values['dry-run']) {
    const refusal = await inTransaction((db) => checkAllocatable(db, request));
    if (refusal) {
      console.error(`REFUSED  ${refusal.code}\n         ${refusal.message}`);
      process.exit(1);
    }
    console.log(`OK       "${request.tlp}" → ${request.organization.name}`);
    console.log(`         evidence: ${request.evidence}`);
    if (termYears) console.log(`         term: ${termYears} year(s)`);
    if (memberUserId) console.log(`         day-one admin: ${memberUserId}`);
    console.log('         Nothing written (--dry-run).');
  } else {
    const outcome = await inTransaction((db) => allocateTlp(db, request));
    if (!outcome.allocated) {
      console.error(`REFUSED  ${outcome.code}\n         ${outcome.message}`);
      process.exit(1);
    }
    console.log(`Allocated "${outcome.tlp}" to ${outcome.organization.name}` +
      `${outcome.organization.created ? ' (organization created)' : ' (existing organization)'}.`);
    if (outcome.expiresAt) console.log(`  expires ${outcome.expiresAt} (§8.2 term; renewal is Phase 2)`);
    if (outcome.membership) console.log(`  day-one admin: ${outcome.membership.userId}`);
    console.log(`  the allocation page: GET /${outcome.tlp}`);
  }
} finally {
  await closePool();
}

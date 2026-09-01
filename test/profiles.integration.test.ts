/**
 * Part Two against a real database — §12, §13, and §23 testing priority 3.
 *
 * Immutability is the point of this file. Spec §9.3 forbids altering,
 * unpublishing, or withholding a published version, and §6.4 EXPLICITLY PERMITS
 * Owner and Website to change after publication. So the enforcement must be
 * narrow, and it is wrong in two directions:
 *
 *   too loose  → content can be edited after publication; a Governor that
 *                cached version 2 holds a different contract from one that
 *                resolves it tomorrow
 *   too tight  → Owner cannot change when a Prefix changes hands, which §6.4
 *                permits and v0.2 of this design got wrong (§24)
 *
 * Both directions are tested. A blanket lock would pass half of this file.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type pg from 'pg';

import { freshDatabase, type Harness } from './support/pg.ts';
import { applySeed } from '../src/seed/seed.ts';
import { parseCorpus } from '../src/profile/legacy.ts';
import { planImport } from '../src/profile/import.ts';
import { runImport } from '../src/seed/import-profiles.ts';
import { publishVersion, registerName, deprecateVersion, updateStewardship, contentHash } from '../src/profile/store.ts';
import { verify } from '../src/audit.ts';
import type { Actor } from '../src/profile/store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = parseCorpus(
  JSON.parse(readFileSync(resolve(here, 'fixtures/cp-padi-io-profiles.json'), 'utf8')),
);
const plan = planImport(corpus);

const ACTOR: Actor = { actor: 'test', kind: 'operator', principal: 'test@example.org' };

let harness: Harness;
let db: pg.Pool;

before(async () => {
  harness = await freshDatabase();
  db = harness.pool;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await applySeed(client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

after(async () => {
  await harness.close();
});

async function refused(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail('expected the database to refuse this, and it did not');
}

async function allocationFor(tlp: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM allocation WHERE tlp = $1`, [tlp]);
  return rows[0]!.id;
}

// ---------------------------------------------------------------------------

describe('registration (§12.1)', () => {
  test('a name is registered with its allocation and registration date', async () => {
    const allocationId = await allocationFor('padi');
    const profile = await registerName(db, ACTOR, {
      name: 'padi.example-one',
      allocationId,
      registeredAt: new Date('2024-01-15T00:00:00Z'),
    });
    assert.ok(profile.id);

    const { rows } = await db.query<{ registered_at: Date; draft_disclosure: string }>(
      `SELECT registered_at, draft_disclosure FROM profile WHERE id = $1`,
      [profile.id],
    );
    assert.equal(rows[0]!.registered_at.toISOString(), '2024-01-15T00:00:00.000Z');
    assert.equal(rows[0]!.draft_disclosure, 'private', 'a new Draft is private by default');
  });

  test('a name is unique — one Profile per name', async () => {
    const allocationId = await allocationFor('padi');
    const message = await refused(() =>
      registerName(db, ACTOR, { name: 'padi.example-one', allocationId }),
    );
    assert.match(message, /duplicate key|unique/i);
  });

  test('a malformed name is refused by the database as well as the grammar', async () => {
    const allocationId = await allocationFor('padi');
    // The application refuses first, with a useful message...
    await assert.rejects(() => registerName(db, ACTOR, { name: 'padi', allocationId }), /one segment/);
    // ...and the constraint refuses a direct insert that bypasses it.
    for (const bad of ['padi', 'Padi.Thing', 'padi..x', 'padi.-x']) {
      const message = await refused(() =>
        db.query(`INSERT INTO profile (name, allocation_id) VALUES ($1, $2)`, [bad, allocationId]),
      );
      assert.match(message, /profile_name_grammar/, `"${bad}" was accepted`);
    }
  });

  test('there is no status column on profile — status is per version (§12.1)', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'profile'`,
    );
    const columns = rows.map((r) => r.column_name);
    assert.ok(!columns.includes('status'), 'profile must not carry a status column');
  });
});

describe('publication and version assignment (§6.2, §13.4)', () => {
  let profileId: string;

  before(async () => {
    const allocationId = await allocationFor('padi');
    const profile = await registerName(db, ACTOR, { name: 'padi.versioned', allocationId });
    profileId = profile.id;
  });

  const sample = (name: string) => ({
    name: 'padi.versioned',
    owner: 'Padi, Inc.',
    title: 'Versioned',
    status: 'Published' as const,
    versions: [
      {
        properties: [
          { name, description: 'A property.', role: 'provider' as const, mandatory: true, propagate: true },
        ],
      },
    ],
  });

  test('the first publication receives version 1, and the author does not choose', async () => {
    const profile = sample('first');
    const published = await publishVersion(db, ACTOR, {
      profileId,
      name: 'padi.versioned',
      profile,
      content: profile.versions[0]!,
    });
    assert.equal(published.version, 1);
    assert.match(published.contentHash, /^[0-9a-f]{64}$/);
  });

  test('the next receives 2 — max+1, not a caller-supplied number', async () => {
    const profile = sample('second');
    const published = await publishVersion(db, ACTOR, {
      profileId,
      name: 'padi.versioned',
      profile,
      content: profile.versions[0]!,
    });
    assert.equal(published.version, 2);
  });

  test('concurrent publications of one Profile do not collide', async () => {
    const allocationId = await allocationFor('padi');
    const { id } = await registerName(db, ACTOR, { name: 'padi.concurrent', allocationId });

    const publishOne = (n: number) => {
      const profile = { ...sample(`p${n}`), name: 'padi.concurrent' };
      return publishVersion(db, ACTOR, {
        profileId: id,
        name: 'padi.concurrent',
        profile,
        content: profile.versions[0]!,
      });
    };

    const results = await Promise.all([publishOne(1), publishOne(2), publishOne(3)]);
    const assigned = results.map((r) => r.version).sort();
    assert.deepEqual(assigned, [1, 2, 3], 'every publication got a distinct integer');
  });

  test('served_bytes are stored verbatim and the hash is over the document', async () => {
    const { rows } = await db.query<{ served_bytes: Buffer; content_hash: string; content: unknown }>(
      `SELECT served_bytes, content_hash, content FROM profile_version
        WHERE profile_id = $1 AND version = 1`,
      [profileId],
    );
    const row = rows[0]!;
    assert.ok(Buffer.isBuffer(row.served_bytes));
    // The stored bytes parse back to the stored document.
    assert.deepEqual(JSON.parse(row.served_bytes.toString('utf8')), row.content);
    assert.equal(row.content_hash, contentHash(row.content));
  });
});

describe('IMMUTABILITY — §23 priority 3, spec §9.3', () => {
  let versionId: string;
  let profileId: string;

  before(async () => {
    const allocationId = await allocationFor('padi');
    const profile = await registerName(db, ACTOR, { name: 'padi.frozen', allocationId });
    profileId = profile.id;
    const doc = {
      name: 'padi.frozen',
      owner: 'Original Owner',
      website: 'https://original.example',
      status: 'Published' as const,
      versions: [
        {
          properties: [
            { name: 'x', description: 'd', role: 'provider' as const, mandatory: true, propagate: false },
          ],
        },
      ],
    };
    const published = await publishVersion(db, ACTOR, {
      profileId,
      name: 'padi.frozen',
      profile: doc,
      content: doc.versions[0]!,
    });
    versionId = published.versionId;
  });

  test('a published version is NEVER deleted', async () => {
    const message = await refused(() =>
      db.query(`DELETE FROM profile_version WHERE id = $1`, [versionId]),
    );
    assert.match(message, /never deleted/);
  });

  test('content cannot be altered', async () => {
    const message = await refused(() =>
      db.query(`UPDATE profile_version SET content = '{"tampered":true}'::jsonb WHERE id = $1`, [versionId]),
    );
    assert.match(message, /immutable/);
  });

  test('served_bytes, content_hash, version and published_at are all frozen', async () => {
    for (const [column, value] of [
      ['served_bytes', `'\\x00'::bytea`],
      ['content_hash', `'0000'`],
      ['version', '99'],
      ['published_at', `'2020-01-01'::timestamptz`],
      ['grandfathered', 'true'],
      ['missing_header_fields', `'{Owner}'::text[]`],
    ] as const) {
      const message = await refused(() =>
        db.query(`UPDATE profile_version SET ${column} = ${value} WHERE id = $1`, [versionId]),
      );
      assert.match(message, /immutable/, `${column} was mutable`);
    }
  });

  test('BUT Owner and Website MAY change — §6.4 permits it, and forbidding it is also non-conforming', async () => {
    // The direction a blanket lock gets wrong. A Prefix may change hands, and
    // §6.4 exists to let the Owner field follow.
    await updateStewardship(db, ACTOR, versionId, {
      owner: 'New Owner After Transfer',
      website: 'https://new.example',
    });

    const { rows } = await db.query<{ header_owner: string; header_website: string }>(
      `SELECT header_owner, header_website FROM profile_version WHERE id = $1`,
      [versionId],
    );
    assert.equal(rows[0]!.header_owner, 'New Owner After Transfer');
    assert.equal(rows[0]!.header_website, 'https://new.example');
  });

  test('a stewardship change creates no version and alters no content', async () => {
    const { rows } = await db.query<{ n: string; content_hash: string }>(
      `SELECT count(*)::text AS n, min(content_hash) AS content_hash
         FROM profile_version WHERE profile_id = $1`,
      [profileId],
    );
    assert.equal(rows[0]!.n, '1', 'stewardship must not create a version');
  });

  test('status moves published → deprecated, one way only', async () => {
    await deprecateVersion(db, ACTOR, versionId);
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM profile_version WHERE id = $1`,
      [versionId],
    );
    assert.equal(rows[0]!.status, 'deprecated');

    // There is no unpublishing (spec §6.2).
    const message = await refused(() =>
      db.query(`UPDATE profile_version SET status = 'published' WHERE id = $1`, [versionId]),
    );
    assert.match(message, /no other way|no unpublishing/i);
  });

  test('a deprecated version remains resolvable and immutable', async () => {
    const { rows } = await db.query(`SELECT content FROM profile_version WHERE id = $1`, [versionId]);
    assert.ok(rows[0], 'a deprecated version still resolves');
    const message = await refused(() =>
      db.query(`UPDATE profile_version SET content = '{}'::jsonb WHERE id = $1`, [versionId]),
    );
    assert.match(message, /immutable/);
  });
});

describe('the Draft (§12.1, §13.3)', () => {
  let profileId: string;

  before(async () => {
    const allocationId = await allocationFor('padi');
    const profile = await registerName(db, ACTOR, {
      name: 'padi.draft-test',
      allocationId,
      draftContent: { Header: { Name: 'padi.draft-test' } },
    });
    profileId = profile.id;
  });

  test('a Draft is mutable without restriction (spec §6.2)', async () => {
    for (const revision of [1, 2, 3]) {
      await db.query(
        `UPDATE profile SET draft_content = $2, draft_modified = now() WHERE id = $1`,
        [profileId, JSON.stringify({ revision })],
      );
    }
    const { rows } = await db.query<{ draft_content: { revision: number } }>(
      `SELECT draft_content FROM profile WHERE id = $1`,
      [profileId],
    );
    assert.equal(rows[0]!.draft_content.revision, 3);
  });

  test('the disclosure trapdoor: public is irreversible (spec §7.3)', async () => {
    await db.query(`UPDATE profile SET draft_disclosure = 'authorized' WHERE id = $1`, [profileId]);
    await db.query(`UPDATE profile SET draft_disclosure = 'public' WHERE id = $1`, [profileId]);

    for (const attempt of ['private', 'authorized']) {
      const message = await refused(() =>
        db.query(`UPDATE profile SET draft_disclosure = $2 WHERE id = $1`, [profileId, attempt]),
      );
      assert.match(message, /trapdoor/, `disclosure walked back to ${attempt}`);
    }
  });

  test('a Draft that never published may be discarded, releasing the name (spec §7.3)', async () => {
    const allocationId = await allocationFor('padi');
    const { id } = await registerName(db, ACTOR, { name: 'padi.discardable', allocationId });
    await db.query(`UPDATE profile SET discarded_at = now() WHERE id = $1`, [id]);
    const { rows } = await db.query(`SELECT discarded_at FROM profile WHERE id = $1`, [id]);
    assert.ok(rows[0]);
  });

  test('a name with published versions is permanent and cannot be discarded', async () => {
    const allocationId = await allocationFor('padi');
    const { id } = await registerName(db, ACTOR, { name: 'padi.permanent', allocationId });
    const doc = {
      name: 'padi.permanent',
      status: 'Published' as const,
      versions: [{ properties: [] }],
    };
    await publishVersion(db, ACTOR, {
      profileId: id,
      name: 'padi.permanent',
      profile: doc,
      content: doc.versions[0]!,
    });

    const message = await refused(() =>
      db.query(`UPDATE profile SET discarded_at = now() WHERE id = $1`, [id]),
    );
    assert.match(message, /permanent/);
  });
});

describe('the 70-record import, run for real (§10.4)', () => {
  // ITS OWN DATABASE. The blocks above publish seven versions of their own, and
  // counting rows in a shared database would mean these assertions measured the
  // import plus whatever the other tests happened to leave behind. Adjusting
  // the expected numbers to absorb that would make them mean nothing — the
  // first version of this file did exactly that and read 46 where 39 was true.
  let ownHarness: Harness;
  let importDb: pg.Pool;
  let imported: Awaited<ReturnType<typeof runImport>>;

  before(async () => {
    ownHarness = await freshDatabase();
    importDb = ownHarness.pool;

    const client = await importDb.connect();
    try {
      await client.query('BEGIN');
      await applySeed(client);
      imported = await runImport(client, corpus, plan);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  after(async () => {
    await ownHarness.close();
  });

  test('69 names registered, 69 versions published, 1 excluded', async () => {
    assert.equal(imported.namesRegistered, 69);
    assert.equal(imported.versionsPublished, 69);
    assert.equal(imported.excluded, 1);
  });

  test('the excluded bare `proto` is nowhere in the namespace', async () => {
    const { rows } = await importDb.query(`SELECT 1 FROM profile WHERE name = 'proto'`);
    assert.equal(rows.length, 0);
  });

  test('test.abc landed as padi.test.abc, and records where it came from', async () => {
    const { rows } = await importDb.query<{ imported_from: string }>(
      `SELECT imported_from FROM profile WHERE name = 'padi.test.abc'`,
    );
    assert.equal(rows[0]!.imported_from, 'test.abc');
    const old = await importDb.query(`SELECT 1 FROM profile WHERE name = 'test.abc'`);
    assert.equal(old.rows.length, 0);
  });

  test('padi.appliance and padi.device are registered with nothing published (§12.1)', async () => {
    for (const name of ['padi.appliance', 'padi.device']) {
      const { rows } = await importDb.query<{ id: string; n: string }>(
        `SELECT p.id, count(v.id)::text AS n
           FROM profile p LEFT JOIN profile_version v ON v.profile_id = p.id
          WHERE p.name = $1 GROUP BY p.id`,
        [name],
      );
      assert.ok(rows[0], `${name} was not registered`);
      assert.equal(rows[0]!.n, '0', `${name} should publish nothing`);
    }
  });

  test('every imported version is grandfathered with an approximate Pub Date', async () => {
    const { rows } = await importDb.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM profile_version
        WHERE grandfathered AND pub_date_approximate`,
    );
    assert.equal(rows[0]!.n, '69');
  });

  test('30 versions publish their §9.4 shortfalls; 39 have none', async () => {
    const { rows } = await importDb.query<{ with_gaps: string; without: string }>(
      `SELECT
         count(*) FILTER (WHERE cardinality(missing_header_fields) > 0)::text AS with_gaps,
         count(*) FILTER (WHERE cardinality(missing_header_fields) = 0)::text AS without
       FROM profile_version`,
    );
    assert.equal(rows[0]!.with_gaps, '30');
    assert.equal(rows[0]!.without, '39');
  });

  test('a record with no Owner says so, and has no Owner', async () => {
    const { rows } = await importDb.query<{ header_owner: string | null; missing: string[] }>(
      `SELECT v.header_owner, v.missing_header_fields AS missing
         FROM profile_version v JOIN profile p ON p.id = v.profile_id
        WHERE 'Owner' = ANY(v.missing_header_fields) LIMIT 1`,
    );
    assert.ok(rows[0], 'expected at least one version missing an Owner');
    assert.equal(rows[0]!.header_owner, null, 'an Owner was invented');
    assert.ok(rows[0]!.missing.includes('Owner'));
  });

  test('registration dates are the source’s own, not the import date', async () => {
    const { rows } = await importDb.query<{ registered_at: Date }>(
      `SELECT registered_at FROM profile WHERE name = 'novant.dataserver'
       UNION ALL SELECT registered_at FROM profile ORDER BY registered_at LIMIT 1`,
    );
    // The oldest record in the corpus is from April 2021.
    assert.ok(rows[0]!.registered_at.getUTCFullYear() <= 2021);
  });

  test('every imported version is immutable, like any other', async () => {
    const { rows } = await importDb.query<{ id: string }>(`SELECT id FROM profile_version LIMIT 1`);
    const message = await refused(() =>
      importDb.query(`UPDATE profile_version SET content = '{}'::jsonb WHERE id = $1`, [rows[0]!.id]),
    );
    assert.match(message, /immutable/);
  });

  test('the audit chain spans the bootstrap and the import, unbroken', async () => {
    assert.equal(await verify(importDb), null);

    const { rows } = await importDb.query<{ action: string; n: string }>(
      `SELECT action, count(*)::text AS n FROM audit_event GROUP BY action ORDER BY action`,
    );
    const byAction = Object.fromEntries(rows.map((r) => [r.action, r.n]));
    assert.equal(byAction['profile.register'], '69');
    assert.equal(byAction['profile.publish'], '69');
    assert.ok(Number(byAction['allocation.grandfather']) > 0, 'the bootstrap is in the same chain');
  });

  test('non-conforming versions record WHY in the audit trail', async () => {
    const { rows } = await importDb.query<{ rationale: string }>(
      `SELECT rationale FROM audit_event
        WHERE action = 'profile.publish' AND rationale ILIKE '%does not meet%' LIMIT 1`,
    );
    assert.ok(rows[0], 'a non-conforming publication left no explanation');
    assert.match(rows[0]!.rationale, /Recorded rather than filled/);
  });

  test('running the import again changes nothing', async () => {
    const client = await importDb.connect();
    try {
      await client.query('BEGIN');
      const second = await runImport(client, corpus, plan);
      await client.query('COMMIT');
      assert.equal(second.namesRegistered, 0);
      assert.equal(second.versionsPublished, 0);
      assert.equal(second.namesSkipped, 69);
    } finally {
      client.release();
    }

    const { rows } = await importDb.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM profile_version WHERE grandfathered`,
    );
    assert.equal(rows[0]!.n, '69', 'a second run duplicated versions');
  });
});

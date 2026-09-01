/**
 * Part Two data model — design §12, spec §6.2 and §6.4.
 *
 * Two tables, and the split between them is the specification's own: a Profile
 * name has exactly one Draft (mutable, unnumbered, permanent) and any number of
 * versions (immutable, numbered, never deleted). The Draft therefore lives on
 * the `profile` row rather than in a table of its own.
 *
 * THERE IS DELIBERATELY NO STATUS COLUMN ON `profile`. Spec §6.4 puts Status in
 * the version Header, and a name with zero published versions is a legitimate
 * state — "a registered name with a Draft and nothing else" (§12.1), which is
 * exactly what `padi.appliance` and `padi.device` are at import.
 */

export const shorthands = undefined;

export async function up(pgm) {
  pgm.createType('draft_disclosure', ['private', 'authorized', 'public']);
  pgm.createType('version_status', ['published', 'deprecated']);

  pgm.createTable('profile', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: {
      type: 'text',
      notNull: true,
      unique: true,
      comment: 'The registered name, >= 2 segments; never changes (spec §7.3)',
    },
    allocation_id: {
      type: 'uuid',
      notNull: true,
      references: 'allocation',
      onDelete: 'RESTRICT',
      comment: 'Owner chain root, as returned by authorizes() at registration',
    },
    registered_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
      comment: 'Public fact (spec §7.3); confers nothing',
    },

    // The Draft. Mutable without restriction (spec §6.2), and it PERSISTS after
    // publication as the author's continuing workspace — publication copies it,
    // it does not consume it.
    draft_content: { type: 'jsonb' },
    draft_modified: { type: 'timestamptz' },
    draft_disclosure: { type: 'draft_disclosure', notNull: true, default: 'private' },

    discarded_at: {
      type: 'timestamptz',
      comment: 'Set only if never published; releases the name (spec §7.3)',
    },

    // §10.4: imported records are grandfathered, and their §9.4 shortfalls are
    // recorded rather than filled. Kept on the profile because it is a fact
    // about how the name entered the namespace, not about any one version.
    imported_from: {
      type: 'text',
      comment: 'The name this record was served under on cp.padi.io, where it differs',
    },

    created: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    modified: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('profile', 'allocation_id');
  pgm.createIndex('profile', 'draft_disclosure');

  // The grammar again, at the database layer. src/names.ts gives the useful
  // message; this makes a malformed name unstorable by any path. At least two
  // segments, lowercase, no leading or trailing hyphen in any segment.
  pgm.addConstraint('profile', 'profile_name_grammar', {
    check:
      "name ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' AND length(name) <= 128",
  });

  // A name is discarded only if it never published (spec §7.3). Enforced as a
  // trigger below, where the version count is visible.

  pgm.createTable('profile_version', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    profile_id: { type: 'uuid', notNull: true, references: 'profile', onDelete: 'RESTRICT' },
    version: { type: 'integer', notNull: true, comment: 'max+1 within the profile; the author does not choose (spec §6.2)' },

    content: { type: 'jsonb', notNull: true, comment: 'Frozen copy of the Draft: Header + Properties' },
    served_bytes: {
      type: 'bytea',
      comment:
        'The serialization actually served, stored VERBATIM. Spec §9.3 requires one name and version never be answered with differing content; that comes from replaying these bytes, not from a canonical serializer (§19.2).',
    },
    content_hash: {
      type: 'text',
      notNull: true,
      comment: 'SHA-256 over the canonical form — the detection mechanism spec §9.3 requires',
    },

    status: { type: 'version_status', notNull: true, default: 'published' },
    published_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },

    // Spec §6.4: the two stewardship fields, and the ONLY Header content that
    // may change after publication. Owner because a Prefix may change hands;
    // Website because the document it points to may move.
    header_owner: { type: 'text' },
    header_website: { type: 'text' },

    // §10.4. Recorded, published on the version's page, and never filled in.
    grandfathered: { type: 'boolean', notNull: true, default: false },
    pub_date_approximate: {
      type: 'boolean',
      notNull: true,
      default: false,
      comment: 'The legacy format has no publication date; Pub Date is the record’s created date',
    },
    missing_header_fields: {
      type: 'text[]',
      notNull: true,
      default: pgm.func("'{}'::text[]"),
      comment: 'REQUIRED §6.4 fields the source could not supply. Published as-is (§10.4).',
    },
  });

  pgm.addConstraint('profile_version', 'profile_version_unique', { unique: ['profile_id', 'version'] });
  pgm.addConstraint('profile_version', 'profile_version_positive', { check: 'version >= 1' });
  pgm.createIndex('profile_version', 'profile_id');
  pgm.createIndex('profile_version', 'content_hash');

  // --- THE IMMUTABILITY TRIGGER (§23 testing priority 3) --------------------
  //
  // The most consequential rule in the system. Spec §9.3: a conforming Registry
  // "SHALL NOT delete a published version, and SHALL NOT alter one", and
  // "permits a version's Header to change only as §6.4 provides".
  //
  // It must be NARROWER THAN A BLANKET LOCK, and that is the part which is easy
  // to get wrong in the safe-looking direction. Spec §6.4 explicitly PERMITS
  // Owner and Website to change after publication, so forbidding them would be
  // non-conforming too — v0.2 of this design had exactly that bug (§24).
  //
  // Movable: status, published → deprecated, ONE WAY (spec §6.2: "A version
  // SHALL NOT return to the Draft state — there is no unpublishing").
  // Movable: header_owner, header_website.
  // Everything else: frozen. DELETE: never.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION profile_version_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
          'a published version is never deleted (spec §6.2, §7.3, §9.3)'
          USING ERRCODE = 'insufficient_privilege';
      END IF;

      -- Identity and content are the contract.
      IF NEW.id            IS DISTINCT FROM OLD.id
      OR NEW.profile_id    IS DISTINCT FROM OLD.profile_id
      OR NEW.version       IS DISTINCT FROM OLD.version
      OR NEW.content       IS DISTINCT FROM OLD.content
      OR NEW.served_bytes  IS DISTINCT FROM OLD.served_bytes
      OR NEW.content_hash  IS DISTINCT FROM OLD.content_hash
      OR NEW.published_at  IS DISTINCT FROM OLD.published_at
      OR NEW.grandfathered IS DISTINCT FROM OLD.grandfathered
      OR NEW.pub_date_approximate  IS DISTINCT FROM OLD.pub_date_approximate
      OR NEW.missing_header_fields IS DISTINCT FROM OLD.missing_header_fields
      THEN
        RAISE EXCEPTION
          'a published version is immutable; only status (forward) and the Owner and Website stewardship fields may change (spec §6.4, §9.3)'
          USING ERRCODE = 'insufficient_privilege';
      END IF;

      -- Status moves one way only.
      IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (OLD.status = 'published' AND NEW.status = 'deprecated') THEN
          RAISE EXCEPTION
            'status moves published -> deprecated and no other way; there is no unpublishing (spec §6.2)'
            USING ERRCODE = 'insufficient_privilege';
        END IF;
      END IF;

      -- header_owner and header_website are deliberately absent from the frozen
      -- list. Spec §6.4 permits them to change; refusing would be the opposite
      -- non-conformance.
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER profile_version_immutable_trigger
      BEFORE UPDATE OR DELETE ON profile_version
      FOR EACH ROW EXECUTE FUNCTION profile_version_immutable();
  `);

  // A name with published versions is permanent and can never be discarded;
  // only a Draft that never published may be (spec §7.3).
  pgm.sql(`
    CREATE OR REPLACE FUNCTION profile_discard_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      published_count integer;
    BEGIN
      IF NEW.discarded_at IS NULL OR OLD.discarded_at IS NOT NULL THEN
        RETURN NEW;
      END IF;

      SELECT count(*) INTO published_count FROM profile_version WHERE profile_id = NEW.id;

      IF published_count > 0 THEN
        RAISE EXCEPTION
          'name % has % published version(s) and is permanent; only a Draft never published may be discarded (spec §7.3)',
          NEW.name, published_count
          USING ERRCODE = 'insufficient_privilege';
      END IF;

      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER profile_discard_guard_trigger
      BEFORE UPDATE ON profile
      FOR EACH ROW EXECUTE FUNCTION profile_discard_guard();
  `);

  // The disclosure trapdoor (§13.3, spec §7.3). Once public, never anything
  // else — "there is no transition back". Enforced here so that no API path,
  // present or future, can walk it back.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION draft_disclosure_trapdoor()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.draft_disclosure = 'public' AND NEW.draft_disclosure <> 'public' THEN
        RAISE EXCEPTION
          'draft disclosure is a trapdoor: once public it is answerable to any party thereafter, irreversibly (spec §7.3, §13.3)'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER draft_disclosure_trapdoor_trigger
      BEFORE UPDATE ON profile
      FOR EACH ROW EXECUTE FUNCTION draft_disclosure_trapdoor();
  `);

  /**
   * Assign the next version number and insert, atomically.
   *
   * Spec §6.2: "each publication SHALL receive the next integer after the
   * highest already assigned, and the author does not choose it."
   *
   * Two writers publishing the same Profile concurrently must not both read the
   * same max. A row lock on the parent profile serialises them without needing
   * SERIALIZABLE isolation across the whole transaction — and the unique
   * constraint on (profile_id, version) is the backstop if this is ever
   * bypassed.
   */
  pgm.sql(`
    CREATE OR REPLACE FUNCTION publish_version(
      p_profile_id uuid,
      p_content jsonb,
      p_served_bytes bytea,
      p_content_hash text,
      p_header_owner text DEFAULT NULL,
      p_header_website text DEFAULT NULL,
      p_grandfathered boolean DEFAULT false,
      p_pub_date_approximate boolean DEFAULT false,
      p_missing_header_fields text[] DEFAULT '{}',
      p_published_at timestamptz DEFAULT now()
    ) RETURNS TABLE (version_id uuid, assigned_version integer)
    LANGUAGE plpgsql AS $$
    DECLARE
      next_version integer;
      new_id uuid;
    BEGIN
      -- Lock the parent. Concurrent publications of the SAME profile queue;
      -- publications of different profiles do not contend.
      PERFORM 1 FROM profile WHERE id = p_profile_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'profile % does not exist', p_profile_id;
      END IF;

      SELECT coalesce(max(version), 0) + 1 INTO next_version
      FROM profile_version WHERE profile_id = p_profile_id;

      INSERT INTO profile_version (
        profile_id, version, content, served_bytes, content_hash,
        header_owner, header_website, grandfathered, pub_date_approximate,
        missing_header_fields, published_at
      ) VALUES (
        p_profile_id, next_version, p_content, p_served_bytes, p_content_hash,
        p_header_owner, p_header_website, p_grandfathered, p_pub_date_approximate,
        p_missing_header_fields, p_published_at
      ) RETURNING id INTO new_id;

      version_id := new_id;
      assigned_version := next_version;
      RETURN NEXT;
    END;
    $$;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP FUNCTION IF EXISTS publish_version(uuid, jsonb, bytea, text, text, text, boolean, boolean, text[], timestamptz);
    DROP TRIGGER IF EXISTS draft_disclosure_trapdoor_trigger ON profile;
    DROP TRIGGER IF EXISTS profile_discard_guard_trigger ON profile;
    DROP TRIGGER IF EXISTS profile_version_immutable_trigger ON profile_version;
    DROP FUNCTION IF EXISTS draft_disclosure_trapdoor();
    DROP FUNCTION IF EXISTS profile_discard_guard();
    DROP FUNCTION IF EXISTS profile_version_immutable();
  `);
  pgm.dropTable('profile_version');
  pgm.dropTable('profile');
  pgm.dropType('version_status');
  pgm.dropType('draft_disclosure');
}

/**
 * Design §6.4, §8.3 — sub-name authorization.
 *
 * Spec §7.3 requires the Registry to check that the owner's authorization
 * EXISTS, while deliberately declining to define its form. This table is this
 * design's supplied form, and it is optional by construction: an owner with
 * simple needs creates no rows at all, because membership in the owning
 * organization is authorization enough.
 *
 * `scope` is a STRING PREFIX, not a tree. `ashrae.135` covers that exact name
 * and any name beginning `ashrae.135.`. Nothing requires `ashrae.135` itself to
 * be registered and no interior name need exist — spec §7.1 places no
 * requirement on the shape or depth of a name below its Prefix, so enforcing a
 * tree here would breach it.
 */

export const shorthands = undefined;

export async function up(pgm) {
  pgm.createType('authorization_status', ['offered', 'active', 'revoked', 'expired']);

  pgm.createTable('authorization_record', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    allocation_id: { type: 'uuid', notNull: true, references: 'allocation', onDelete: 'RESTRICT' },
    scope: {
      type: 'text',
      notNull: true,
      comment: 'A name or sub-name scope, e.g. `ashrae.135`. String prefix, not a tree.',
    },
    grantee_org_id: { type: 'uuid', notNull: true, references: 'organization', onDelete: 'RESTRICT' },
    status: { type: 'authorization_status', notNull: true, default: 'offered' },
    granted_by: { type: 'uuid', references: 'app_user' },
    granted_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz' },
    created: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    modified: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('authorization_record', 'allocation_id');
  pgm.createIndex('authorization_record', 'grantee_org_id');
  pgm.createIndex('authorization_record', 'scope');

  // A scope is a name-shaped string: lowercase, at least two segments. Without
  // this, `scope = 'ashrae'` would silently delegate an entire Prefix, which
  // §6.4's "a name or sub-name scope" does not contemplate.
  pgm.addConstraint('authorization_record', 'authorization_record_scope_grammar', {
    check: "scope ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' AND length(scope) <= 128",
  });

  // Scopes may not overlap (§8.3). Two live scopes overlap when either is a
  // string prefix of the other at a segment boundary, so the exclusion is
  // written on the prefix relation rather than on equality. Only `offered` and
  // `active` rows participate: a revoked scope must not block a re-grant.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION authorization_scopes_overlap(a text, b text)
    RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
      SELECT a = b OR a LIKE b || '.%' OR b LIKE a || '.%'
    $$;

    CREATE UNIQUE INDEX authorization_record_live_scope
      ON authorization_record (allocation_id, scope)
      WHERE status IN ('offered', 'active');
  `);

  // The prefix-overlap case the unique index cannot express. A trigger is the
  // honest tool here: the condition is relational, not a value constraint.
  //
  // Scoped to the allocation. A global scan would let a row on allocation A
  // carrying a scope under B's Prefix permanently block B's own owner from
  // granting it — cross-tenant denial of service through a table B does not
  // control. The `scope_under_allocation` trigger below makes that row
  // impossible anyway, but the two must not depend on each other.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION authorization_record_no_overlap()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      conflict text;
    BEGIN
      IF NEW.status NOT IN ('offered', 'active') THEN
        RETURN NEW;
      END IF;

      -- Serialise checks per allocation, or two concurrent transactions can
      -- both read "no conflict" and both commit overlapping scopes. The
      -- partial unique index catches exact equality; this catches the rest.
      PERFORM pg_advisory_xact_lock(hashtext('authz_scope:' || NEW.allocation_id::text));

      SELECT scope INTO conflict
      FROM authorization_record
      WHERE id <> NEW.id
        AND allocation_id = NEW.allocation_id
        AND status IN ('offered', 'active')
        AND authorization_scopes_overlap(scope, NEW.scope)
      LIMIT 1;

      IF conflict IS NOT NULL THEN
        RAISE EXCEPTION
          'authorization scope % overlaps live scope % (design §8.3: scopes may not overlap)',
          NEW.scope, conflict
          USING ERRCODE = 'unique_violation';
      END IF;

      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER authorization_record_no_overlap_trigger
      BEFORE INSERT OR UPDATE ON authorization_record
      FOR EACH ROW EXECUTE FUNCTION authorization_record_no_overlap();
  `);

  // Two integrity rules that have nothing to do with each other and are kept
  // apart so neither can be read as the other:
  //
  //   (a) A scope must lie beneath the Prefix of the allocation it belongs to.
  //       Without this, an owner could grant scopes over somebody else's
  //       namespace. `authorizes()` would not honour such a row — it matches
  //       the TLP independently — but the row should not exist.
  //
  //   (b) The holder needs no record beneath its own Prefix; membership is
  //       already authorization (§5, §6.4).
  //
  // NEITHER of these is the "no re-delegation" rule of §8.3. That rule needs a
  // `granted_by_org` column to enforce and does not have one — see §25 Q7.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION authorization_record_integrity()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      holder uuid;
      prefix text;
    BEGIN
      SELECT org_id, tlp INTO holder, prefix FROM allocation WHERE id = NEW.allocation_id;
      IF holder IS NULL THEN
        RAISE EXCEPTION 'allocation % does not exist', NEW.allocation_id;
      END IF;

      IF NEW.scope <> prefix AND NEW.scope NOT LIKE prefix || '.%' THEN
        RAISE EXCEPTION
          'authorization scope % does not lie beneath the Prefix % of its allocation',
          NEW.scope, prefix
          USING ERRCODE = 'check_violation';
      END IF;

      IF NEW.grantee_org_id = holder THEN
        RAISE EXCEPTION
          'the holder organization needs no authorization record beneath its own Prefix (design §5, §6.4)'
          USING ERRCODE = 'check_violation';
      END IF;

      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER authorization_record_integrity_trigger
      BEFORE INSERT OR UPDATE ON authorization_record
      FOR EACH ROW EXECUTE FUNCTION authorization_record_integrity();
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TRIGGER IF EXISTS authorization_record_integrity_trigger ON authorization_record;
    DROP TRIGGER IF EXISTS authorization_record_no_overlap_trigger ON authorization_record;
    DROP FUNCTION IF EXISTS authorization_record_integrity();
    DROP FUNCTION IF EXISTS authorization_record_no_overlap();
    DROP FUNCTION IF EXISTS authorization_scopes_overlap(text, text);
  `);
  pgm.dropTable('authorization_record');
  pgm.dropType('authorization_status');
}

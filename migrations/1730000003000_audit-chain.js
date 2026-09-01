/**
 * Design §4.3 — one append-only, hash-chained log spanning Parts One and Two.
 *
 * Written in the SAME TRANSACTION as the change it records. That is the whole
 * point: an audit log written afterwards can be skipped, and one written in a
 * separate transaction can be lost while the change survives.
 *
 * `actor_kind` distinguishes human / service / agent, and `principal` names the
 * human on whose behalf a service or agent acted — so "who published this"
 * always has an answer that ends in a person (§15.1).
 *
 * The operator periodically publishes a signed anchor of the chain head. Part
 * Three distributes the anchor but writes nothing; together with per-version
 * content hashes it is how independent parties detect whether the copies they
 * hold agree — the mechanism spec §9.3 requires without defining.
 */

export const shorthands = undefined;

export async function up(pgm) {
  pgm.createType('actor_kind', ['human', 'service', 'agent', 'operator']);

  pgm.createTable('audit_event', {
    seq: { type: 'bigserial', primaryKey: true },
    at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },

    actor: { type: 'text', notNull: true, comment: 'Identifier of the acting party' },
    actor_kind: { type: 'actor_kind', notNull: true },
    principal: {
      type: 'text',
      comment: 'The human on whose behalf a service or agent acted. Required unless actor_kind = human.',
    },
    org_id: { type: 'uuid', references: 'organization' },

    action: { type: 'text', notNull: true, comment: 'e.g. allocation.create, authorization.revoke' },
    subject_type: { type: 'text', notNull: true },
    subject_id: { type: 'text', notNull: true },

    before_hash: { type: 'text', comment: 'SHA-256 of the subject before the change; null on create' },
    after_hash: { type: 'text', comment: 'SHA-256 of the subject after the change; null on delete' },

    rationale: { type: 'text', comment: 'Recorded reason, published where the act is published' },
    request_id: { type: 'text' },

    prev_event_hash: { type: 'text', comment: 'event_hash of seq-1; null for the genesis event' },
    event_hash: { type: 'text', notNull: true },
  });

  pgm.createIndex('audit_event', 'subject_id');
  pgm.createIndex('audit_event', ['subject_type', 'subject_id']);
  pgm.createIndex('audit_event', 'org_id');
  pgm.createIndex('audit_event', 'at');

  // A service or agent acted for someone. Say who.
  pgm.addConstraint('audit_event', 'audit_event_principal_required', {
    check: "actor_kind = 'human' OR principal IS NOT NULL",
  });

  // Compute the chain link in the database rather than the application, so that
  // no writer — including one bypassing the application entirely — can append
  // an event that is not chained.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION audit_event_chain()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      prev_hash text;
      payload text;
    BEGIN
      -- Serialise appends. The chain is a sequence; concurrent writers must not
      -- both read the same head. This lock is held only to end of transaction
      -- and the write volume on Part One is administrative, so the cost is nil.
      PERFORM pg_advisory_xact_lock(hashtext('audit_event_chain'));

      SELECT event_hash INTO prev_hash
      FROM audit_event
      ORDER BY seq DESC
      LIMIT 1;

      NEW.prev_event_hash := prev_hash;

      payload := concat_ws(chr(31),
        coalesce(prev_hash, ''),
        to_char(NEW.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.USOF'),
        NEW.actor,
        NEW.actor_kind::text,
        coalesce(NEW.principal, ''),
        coalesce(NEW.org_id::text, ''),
        NEW.action,
        NEW.subject_type,
        NEW.subject_id,
        coalesce(NEW.before_hash, ''),
        coalesce(NEW.after_hash, ''),
        coalesce(NEW.rationale, ''),
        coalesce(NEW.request_id, '')
      );

      NEW.event_hash := encode(sha256(convert_to(payload, 'UTF8')), 'hex');
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER audit_event_chain_trigger
      BEFORE INSERT ON audit_event
      FOR EACH ROW EXECUTE FUNCTION audit_event_chain();
  `);

  // Append-only, enforced at the database layer. §23 testing priority 3 is
  // about published versions, but the principle is the same and the log is
  // where it matters most: an audit trail that can be edited is decoration.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION audit_event_append_only()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'audit_event is append-only (design §4.3); % is not permitted', TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END;
    $$;

    CREATE TRIGGER audit_event_no_update
      BEFORE UPDATE OR DELETE ON audit_event
      FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();
  `);

  // Verify the chain from any point. Returns the first seq at which the stored
  // hash disagrees with the recomputed one, or null if the chain is intact.
  pgm.sql(`
    -- NOTE the output column names. \`found\` is NOT available: plpgsql defines
    -- FOUND as a built-in boolean, and an OUT parameter of that name silently
    -- shadows it — assigning a hash then fails with "invalid input syntax for
    -- type boolean". \`expected\` is legal but renamed alongside it for symmetry.
    CREATE OR REPLACE FUNCTION audit_chain_verify(from_seq bigint DEFAULT 1)
    RETURNS TABLE (broken_at bigint, expected_hash text, stored_hash text)
    LANGUAGE plpgsql AS $$
    DECLARE
      r record;
      prev_hash text;
      payload text;
      computed text;
    BEGIN
      SELECT event_hash INTO prev_hash
      FROM audit_event WHERE seq < from_seq ORDER BY seq DESC LIMIT 1;

      FOR r IN SELECT * FROM audit_event WHERE seq >= from_seq ORDER BY seq LOOP
        IF r.prev_event_hash IS DISTINCT FROM prev_hash THEN
          broken_at := r.seq; expected_hash := prev_hash; stored_hash := r.prev_event_hash;
          RETURN NEXT; RETURN;
        END IF;

        payload := concat_ws(chr(31),
          coalesce(prev_hash, ''),
          to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.USOF'),
          r.actor, r.actor_kind::text, coalesce(r.principal, ''),
          coalesce(r.org_id::text, ''), r.action, r.subject_type, r.subject_id,
          coalesce(r.before_hash, ''), coalesce(r.after_hash, ''),
          coalesce(r.rationale, ''), coalesce(r.request_id, '')
        );
        computed := encode(sha256(convert_to(payload, 'UTF8')), 'hex');

        IF computed <> r.event_hash THEN
          broken_at := r.seq; expected_hash := computed; stored_hash := r.event_hash;
          RETURN NEXT; RETURN;
        END IF;

        prev_hash := r.event_hash;
      END LOOP;

      RETURN;
    END;
    $$;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP FUNCTION IF EXISTS audit_chain_verify(bigint);
    DROP TRIGGER IF EXISTS audit_event_no_update ON audit_event;
    DROP TRIGGER IF EXISTS audit_event_chain_trigger ON audit_event;
    DROP FUNCTION IF EXISTS audit_event_append_only();
    DROP FUNCTION IF EXISTS audit_event_chain();
  `);
  pgm.dropTable('audit_event');
  pgm.dropType('actor_kind');
}

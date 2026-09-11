/**
 * Design §20.1 — the distribution feed, Phase 1.
 *
 * Three additions, none of which touches the chain function of migration 3:
 *
 * 1. `audit_event.after_payload` / `before_payload`. The chain has always
 *    committed to the subject of each act through `after_hash`, but the log
 *    kept only the hash — so the journal could not carry the payload an
 *    independent party would recompute it from. From here on `record()` stores
 *    the payload beside its hash. The hash preimage is unchanged (it never
 *    included the payload, only its digest), so no existing event_hash moves
 *    and `audit_chain_verify()` is untouched. Earlier events keep NULL: the
 *    journal serves what it can read from the rows they created, and says so.
 *
 * 2. `instance_state` — the one row a local instance (§20) keeps about its
 *    upstream: where it follows from, the cursor it has verified up to, and
 *    what happened last. A singleton by constraint.
 *
 * 3. `journal_entry` — an instance's verbatim copy of every journal entry it
 *    has verified and applied, so it can re-serve the journal downstream
 *    (§20.1) and so the evidence for what it holds is on disk, not in memory.
 *    Append-only like the log it mirrors.
 *
 * On the authoritative store, tables 2 and 3 stay empty.
 */

export const shorthands = undefined;

export async function up(pgm) {
  pgm.addColumns('audit_event', {
    before_payload: {
      type: 'jsonb',
      comment: 'The subject before the change, as hashed into before_hash. NULL for events written before migration 7.',
    },
    after_payload: {
      type: 'jsonb',
      comment: 'The subject after the change, as hashed into after_hash. NULL for events written before migration 7.',
    },
  });

  pgm.createTable('instance_state', {
    singleton: { type: 'boolean', primaryKey: true, default: true },
    upstream: { type: 'text', notNull: true, comment: 'Origin of the authoritative host, e.g. https://cp.cnscp.io' },
    journal_format: { type: 'integer', notNull: true },
    cursor_seq: { type: 'bigint', notNull: true, comment: 'Highest journal seq verified and applied' },
    head_hash: { type: 'text', comment: 'event_hash at cursor_seq; the link the next page must continue from' },
    upstream_head_seq: { type: 'bigint', comment: 'The upstream chain head as of the last successful sync; cursor_seq lags it by what is not yet applied' },
    bootstrapped_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_sync_at: { type: 'timestamptz' },
    last_error: { type: 'text' },
    last_error_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('instance_state', 'instance_state_singleton', { check: 'singleton' });

  pgm.createTable('journal_entry', {
    seq: { type: 'bigint', primaryKey: true },
    event_hash: { type: 'text', notNull: true },
    prev_event_hash: { type: 'text' },
    entry: { type: 'jsonb', notNull: true, comment: 'The entry exactly as the upstream served it' },
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.sql(`
    CREATE OR REPLACE FUNCTION journal_entry_append_only()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'journal_entry is append-only (design §20.1); % is not permitted', TG_OP
        USING ERRCODE = 'insufficient_privilege';
    END;
    $$;

    CREATE TRIGGER journal_entry_no_update
      BEFORE UPDATE OR DELETE ON journal_entry
      FOR EACH ROW EXECUTE FUNCTION journal_entry_append_only();
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TRIGGER IF EXISTS journal_entry_no_update ON journal_entry;
    DROP FUNCTION IF EXISTS journal_entry_append_only();
  `);
  pgm.dropTable('journal_entry');
  pgm.dropTable('instance_state');
  pgm.dropColumns('audit_event', ['before_payload', 'after_payload']);
}

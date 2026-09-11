/**
 * Spec §7.3: a name never published may be released by its author, and
 * release "releases the name". The original schema made `profile.name`
 * unique outright, so a released row — kept, with `discarded_at` set, as the
 * record that the claim once existed — blocked anyone from registering the
 * name again. Released in name only.
 *
 * Uniqueness now holds among LIVE registrations: one live row per name, any
 * number of released ones beneath it. Every lookup by name filters on
 * `discarded_at IS NULL` (and the partial index serves exactly those). A
 * released row can never acquire versions (the discard guard refuses to
 * release a published name, and nothing publishes onto a released one), so
 * joins through profile_version reach live rows only.
 */

export const shorthands = undefined;

export async function up(pgm) {
  pgm.dropConstraint('profile', 'profile_name_key');
  pgm.createIndex('profile', 'name', {
    name: 'profile_name_live',
    unique: true,
    where: 'discarded_at IS NULL',
  });
  // Released rows are still looked up (the journal names them); keep them reachable.
  pgm.createIndex('profile', ['name', 'discarded_at'], { name: 'profile_name_released' });
}

export async function down(pgm) {
  pgm.dropIndex('profile', ['name', 'discarded_at'], { name: 'profile_name_released' });
  pgm.dropIndex('profile', 'name', { name: 'profile_name_live' });
  // Fails if a name has been re-registered after release — which is the point of this migration.
  pgm.addConstraint('profile', 'profile_name_key', { unique: ['name'] });
}

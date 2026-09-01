/**
 * The deployed serialization — what `cp.padi.io` serves today (design §19.2).
 *
 * Flat metadata; `versions[].properties[]`; role, requiredness and propagation
 * encoded by KEY PRESENCE with a null value. Measured across all 70 deployed
 * records on 31 August 2026:
 *
 *   property key   present   absent   value when present
 *   ------------   -------   ------   ------------------
 *   server           186       117    always null   → provider supplies it
 *   required         171       132    always null   → Mandatory
 *   propagate        278        25    always null   → Propagate
 *   name             303         0    the string
 *   description      303         0    the string
 *
 * There is NO `client` key on any property in the corpus. Absent `server`
 * means consumer. The role is one key's presence, not a choice between two —
 * so a parser that looks for `client` finds nothing and must not conclude the
 * role is unknown.
 *
 * `null` IS THE SIGNAL, NOT THE ABSENCE OF ONE. `JSON.parse` preserves the
 * distinction (`'server' in p` is true for a null value, false for a missing
 * key) and every read below uses `in` for exactly that reason. `p.server`
 * would be `undefined` in both cases and would lose 186 provider flags in one
 * stroke.
 */

import type { Profile, ProfileVersion, Property, Role } from './model.ts';

export class LegacyParseError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'LegacyParseError';
    this.path = path;
  }
}

type Json = Record<string, unknown>;

function optionalString(source: Json, key: string, path: string): string | undefined {
  if (!(key in source)) return undefined;
  const value = source[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new LegacyParseError(`${path}.${key}`, `expected a string, got ${typeof value}`);
  }
  return value;
}

/** A field that is present-and-null in the corpus, where null is a real value. */
function nullableString(source: Json, key: string, path: string): string | null | undefined {
  if (!(key in source)) return undefined;
  const value = source[key];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new LegacyParseError(`${path}.${key}`, `expected a string or null, got ${typeof value}`);
  }
  return value;
}

// --- Parse ------------------------------------------------------------------

export function parseProperty(raw: Json, path: string): Property {
  const name = raw['name'];
  if (typeof name !== 'string') {
    throw new LegacyParseError(path, 'property has no name');
  }
  const description = raw['description'];
  if (typeof description !== 'string') {
    throw new LegacyParseError(`${path}[${name}]`, 'property has no description');
  }

  // The three presence checks. `in`, never truthiness.
  const role: Role = 'server' in raw ? 'provider' : 'consumer';
  const mandatory = 'required' in raw;
  const propagate = 'propagate' in raw;

  return { name, description, role, mandatory, propagate };
}

export function parseVersion(raw: Json, path: string): ProfileVersion {
  const properties = raw['properties'];
  if (properties === undefined) return { properties: [] };
  if (!Array.isArray(properties)) {
    throw new LegacyParseError(`${path}.properties`, 'expected an array');
  }
  return {
    properties: properties.map((p, i) => parseProperty(p as Json, `${path}.properties[${i}]`)),
  };
}

export function parseProfile(raw: Json, path = '<profile>'): Profile {
  const name = raw['name'];
  if (typeof name !== 'string') {
    throw new LegacyParseError(path, 'record has no name');
  }

  const profile: Profile = { name };

  // Each assignment is conditional on the KEY, so an absent key stays absent
  // and is not re-emitted as null on the way out.
  const title = optionalString(raw, 'title', name);
  if (title !== undefined) profile.title = title;

  const description = optionalString(raw, 'comment', name);
  if (description !== undefined) profile.description = description;

  const owner = optionalString(raw, 'company', name);
  if (owner !== undefined) profile.owner = owner;

  const website = optionalString(raw, 'website', name);
  if (website !== undefined) profile.website = website;

  // `server` and `client` at the TOP level are capability titles, not flags.
  // Same key name, entirely different meaning one level down — which is the
  // trap this format sets for a careless reader.
  const providerTitle = optionalString(raw, 'server', name);
  if (providerTitle !== undefined) profile.providerTitle = providerTitle;

  const consumerTitle = optionalString(raw, 'client', name);
  if (consumerTitle !== undefined) profile.consumerTitle = consumerTitle;

  const created = optionalString(raw, 'created', name);
  if (created !== undefined) profile.created = created;

  const modified = optionalString(raw, 'modified', name);
  if (modified !== undefined) profile.modified = modified;

  const used = optionalString(raw, 'used', name);
  if (used !== undefined) profile.used = used;

  if ('approved' in raw) profile.approved = nullableString(raw, 'approved', name) ?? null;
  if ('active' in raw) profile.active = nullableString(raw, 'active', name) ?? null;

  if ('versions' in raw) {
    const versions = raw['versions'];
    if (!Array.isArray(versions)) {
      throw new LegacyParseError(`${name}.versions`, 'expected an array');
    }
    profile.versions = versions.map((v, i) => parseVersion(v as Json, `${name}.versions[${i}]`));
  }

  return profile;
}

export function parseCorpus(raw: unknown): Profile[] {
  if (!Array.isArray(raw)) throw new LegacyParseError('<corpus>', 'expected an array of records');
  return raw.map((r, i) => parseProfile(r as Json, `<corpus>[${i}]`));
}

// --- Serialize --------------------------------------------------------------

/**
 * Key order is NOT preserved, and cannot be.
 *
 * The deployed corpus carries 13 distinct top-level key orders and 23 distinct
 * property key orders — the same fields written in different sequences by
 * whatever wrote them over five years. A model that captured semantics could
 * only reproduce one of those orders.
 *
 * This is why §12.2 stores `served_bytes` verbatim rather than regenerating
 * them. Spec §9.3 requires that the same name and version is never answered
 * with differing content; that guarantee comes from replaying stored bytes,
 * not from a serializer being canonical. The order below is one of the 23
 * observed orders, chosen so output looks like the corpus rather than novel.
 */
const PROPERTY_KEY_ORDER = ['server', 'name', 'propagate', 'description', 'required'] as const;

export function serializeProperty(property: Property): Json {
  const out: Json = {};
  for (const key of PROPERTY_KEY_ORDER) {
    switch (key) {
      case 'server':
        // Presence encodes the role, and the value is null — which is what the
        // corpus contains in all 186 cases.
        if (property.role === 'provider') out['server'] = null;
        break;
      case 'name':
        out['name'] = property.name;
        break;
      case 'propagate':
        if (property.propagate) out['propagate'] = null;
        break;
      case 'description':
        out['description'] = property.description;
        break;
      case 'required':
        if (property.mandatory) out['required'] = null;
        break;
    }
  }
  return out;
}

export function serializeVersion(version: ProfileVersion): Json {
  return { properties: version.properties.map(serializeProperty) };
}

export function serializeProfile(profile: Profile): Json {
  const out: Json = { name: profile.name };

  if (profile.title !== undefined) out['title'] = profile.title;
  if (profile.description !== undefined) out['comment'] = profile.description;
  if (profile.owner !== undefined) out['company'] = profile.owner;
  if (profile.website !== undefined) out['website'] = profile.website;
  if (profile.providerTitle !== undefined) out['server'] = profile.providerTitle;
  if (profile.consumerTitle !== undefined) out['client'] = profile.consumerTitle;
  if (profile.created !== undefined) out['created'] = profile.created;
  if (profile.modified !== undefined) out['modified'] = profile.modified;
  if (profile.used !== undefined) out['used'] = profile.used;
  if (profile.approved !== undefined) out['approved'] = profile.approved;
  if (profile.active !== undefined) out['active'] = profile.active;
  if (profile.versions !== undefined) out['versions'] = profile.versions.map(serializeVersion);

  return out;
}

export function serializeCorpus(profiles: Profile[]): Json[] {
  return profiles.map(serializeProfile);
}

// --- An independent oracle for the tests -------------------------------------

/**
 * Read the three presence flags straight off raw JSON, without going through
 * the parser.
 *
 * The golden tests compare this against the parsed model. If the parser were
 * also the thing that defined "correct", a parser bug would define itself as
 * correct — the tests would pass and every flag could still be wrong.
 */
export function rawFlags(rawProperty: Json): { role: Role; mandatory: boolean; propagate: boolean } {
  return {
    role: Object.prototype.hasOwnProperty.call(rawProperty, 'server') ? 'provider' : 'consumer',
    mandatory: Object.prototype.hasOwnProperty.call(rawProperty, 'required'),
    propagate: Object.prototype.hasOwnProperty.call(rawProperty, 'propagate'),
  };
}

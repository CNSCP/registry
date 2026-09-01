/**
 * The 2026 specification serialization — spec §6.3, §6.4, worked example §6.6.
 *
 *   {
 *     "Header": { "Name", "Version", "Pub Date", "Status", "Owner",
 *                 "Title", "Provider", "Consumer", "Description", "Website" },
 *     "Properties": {
 *       "Provider": [ { "Name", "Mandatory", "Propagate", "Description", "Sample" } ],
 *       "Consumer": [ ... ]
 *     }
 *   }
 *
 * Three differences from the deployed shape are structural rather than
 * cosmetic, and each one is a place a naive mapper goes wrong:
 *
 *   1. ROLE IS THE GROUPING. Spec §6.3: Properties are grouped by the role that
 *      supplies them "so the supplying role is given structurally rather than
 *      repeated on each Property." The deployed shape puts every Property in
 *      one array and encodes role by the presence of a `server` key. Round
 *      tripping means turning a key's presence into an array membership and
 *      back, and property ORDER within the original array is not recoverable
 *      once the two groups are split — one more reason §12.2 keeps the bytes.
 *
 *   2. FLAGS ARE THE STRINGS "yes"/"no", not booleans and not null-presence.
 *      Spec §6.6 shows `"Mandatory": "yes"`. A JSON boolean would be a
 *      different document.
 *
 *   3. VERSION IS A STRING IN THE HEADER but an integer in the namespace.
 *      Spec §6.2: "A version identifier SHALL be an integer, assigned at
 *      publication." Spec §6.6 renders it `"Version": "1"`. The model holds
 *      the integer; this serializer renders it.
 *
 * All ten Header fields are REQUIRED (§6.4) and §9.4 makes carrying them a
 * conformance condition for the Profile. This module will SERIALIZE an
 * incomplete Profile — that is `conformance.ts`'s job to detect, not this
 * module's to silently prevent — but it never invents a value to fill a gap.
 */

import type { Profile, ProfileVersion, Property, Role, Status } from './model.ts';

export class Spec2026ParseError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'Spec2026ParseError';
    this.path = path;
  }
}

type Json = Record<string, unknown>;

/** Spec §6.6 renders the flags as "yes" / "no". */
export function yesNo(value: boolean): 'yes' | 'no' {
  return value ? 'yes' : 'no';
}

export function parseYesNo(value: unknown, path: string): boolean {
  if (value === 'yes') return true;
  if (value === 'no') return false;
  throw new Spec2026ParseError(path, `expected "yes" or "no", got ${JSON.stringify(value)}`);
}

const STATUSES: readonly Status[] = ['Draft', 'Published', 'Deprecated'];

// --- Serialize --------------------------------------------------------------

export function serializeProperty(property: Property): Json {
  const out: Json = {
    Name: property.name,
    Mandatory: yesNo(property.mandatory),
    Propagate: yesNo(property.propagate),
    Description: property.description,
  };
  // Omitted rather than invented when the source had none. An empty string is
  // a claim that the author supplied an empty sample; absence is the truth.
  if (property.sample !== undefined) out['Sample'] = property.sample;
  return out;
}

function propertiesOfRole(version: ProfileVersion, role: Role): Json[] {
  return version.properties.filter((p) => p.role === role).map(serializeProperty);
}

/**
 * Render one version of a Profile.
 *
 * The 2026 shape is a document PER VERSION — the Header carries `Version` and
 * `Pub Date` — where the deployed shape is one document carrying every version
 * in an array. So this takes a profile and an index, not a profile alone.
 */
export function serializeProfileVersion(profile: Profile, versionIndex = 0): Json {
  const versions = profile.versions ?? [];
  const version = versions[versionIndex];
  if (!version) {
    throw new Spec2026ParseError(profile.name, `has no version at index ${versionIndex}`);
  }

  const header: Json = { Name: profile.name };

  // Spec §6.4: "assigned at publication; the Draft carries none." Absence here
  // means Draft, and is meaningful — so it is preserved, not defaulted to 1.
  if (profile.version !== undefined) header['Version'] = String(profile.version);
  if (profile.pubDate !== undefined) header['Pub Date'] = profile.pubDate;
  if (profile.status !== undefined) header['Status'] = profile.status;
  if (profile.owner !== undefined) header['Owner'] = profile.owner;
  if (profile.title !== undefined) header['Title'] = profile.title;
  if (profile.providerTitle !== undefined) header['Provider'] = profile.providerTitle;
  if (profile.consumerTitle !== undefined) header['Consumer'] = profile.consumerTitle;
  if (profile.description !== undefined) header['Description'] = profile.description;
  if (profile.website !== undefined) header['Website'] = profile.website;

  return {
    Header: header,
    Properties: {
      Provider: propertiesOfRole(version, 'provider'),
      Consumer: propertiesOfRole(version, 'consumer'),
    },
  };
}

// --- Parse ------------------------------------------------------------------

function parseRoleGroup(raw: unknown, role: Role, path: string): Property[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Spec2026ParseError(path, 'expected an array');

  return raw.map((entry, i) => {
    const p = entry as Json;
    const where = `${path}[${i}]`;
    const name = p['Name'];
    if (typeof name !== 'string') throw new Spec2026ParseError(where, 'Property has no Name');
    const description = p['Description'];
    if (typeof description !== 'string') {
      throw new Spec2026ParseError(`${where}(${name})`, 'Property has no Description');
    }

    const property: Property = {
      name,
      description,
      role,
      mandatory: parseYesNo(p['Mandatory'], `${where}(${name}).Mandatory`),
      propagate: parseYesNo(p['Propagate'], `${where}(${name}).Propagate`),
    };

    const sample = p['Sample'];
    if (sample !== undefined) {
      if (typeof sample !== 'string') {
        throw new Spec2026ParseError(`${where}(${name}).Sample`, 'expected a string');
      }
      property.sample = sample;
    }

    return property;
  });
}

export function parseProfileVersion(raw: Json, path = '<profile>'): Profile {
  const header = raw['Header'] as Json | undefined;
  if (!header) throw new Spec2026ParseError(path, 'document has no Header');

  const name = header['Name'];
  if (typeof name !== 'string') throw new Spec2026ParseError(`${path}.Header`, 'Header has no Name');

  const profile: Profile = { name };

  const version = header['Version'];
  if (version !== undefined) {
    // Spec §6.2: version identifiers are integers. The Header renders one as a
    // string; anything that is not an integer in string clothing is malformed.
    if (typeof version !== 'string' || !/^[0-9]+$/.test(version)) {
      throw new Spec2026ParseError(`${name}.Header.Version`, 'expected an integer as a string');
    }
    profile.version = Number(version);
  }

  const pubDate = header['Pub Date'];
  if (typeof pubDate === 'string') profile.pubDate = pubDate;

  const status = header['Status'];
  if (status !== undefined) {
    if (!STATUSES.includes(status as Status)) {
      throw new Spec2026ParseError(
        `${name}.Header.Status`,
        `expected one of ${STATUSES.join(', ')}, got ${JSON.stringify(status)}`,
      );
    }
    profile.status = status as Status;
  }

  if (typeof header['Owner'] === 'string') profile.owner = header['Owner'];
  if (typeof header['Title'] === 'string') profile.title = header['Title'];
  if (typeof header['Provider'] === 'string') profile.providerTitle = header['Provider'];
  if (typeof header['Consumer'] === 'string') profile.consumerTitle = header['Consumer'];
  if (typeof header['Description'] === 'string') profile.description = header['Description'];
  if (typeof header['Website'] === 'string') profile.website = header['Website'];

  const properties = (raw['Properties'] ?? {}) as Json;
  profile.versions = [
    {
      properties: [
        ...parseRoleGroup(properties['Provider'], 'provider', `${name}.Properties.Provider`),
        ...parseRoleGroup(properties['Consumer'], 'consumer', `${name}.Properties.Consumer`),
      ],
    },
  ];

  return profile;
}

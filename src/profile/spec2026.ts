/**
 * The 2026 specification serialization — spec §6.4–§6.6, worked example §6.8 (8 Sept revision).
 *
 *   {
 *     "Header": { "Name", "Version", "Pub Date", "Status", "Owner",
 *                 "Title", "Provider", "Consumer", "Description", "Website" },
 *     "Properties": {
 *       "Provider": [ { "Name", "Mandatory", "Propagate", "Default"?, "Description", "Sample"? } ],
 *       "Consumer": [ ... ]
 *     },
 *     "Channels"?: [ { "Name", "Mode", "Protocol", "Provider Role"?, "Consumer Role"?, "Description" } ]
 *   }
 *
 * Three differences from the deployed shape are structural rather than
 * cosmetic, and each one is a place a naive mapper goes wrong:
 *
 *   1. ROLE IS THE GROUPING. Spec §6.4: Properties are grouped by the role that
 *      supplies them "so the supplying role is given structurally rather than
 *      repeated on each Property." The deployed shape puts every Property in
 *      one array and encodes role by the presence of a `server` key. Round
 *      tripping means turning a key's presence into an array membership and
 *      back, and property ORDER within the original array is not recoverable
 *      once the two groups are split — one more reason §12.2 keeps the bytes.
 *
 *   2. FLAGS ARE THE STRINGS "yes"/"no", not booleans and not null-presence.
 *      Spec §6.8 shows `"Mandatory": "yes"`. A JSON boolean would be a
 *      different document.
 *
 *   3. VERSION IS A STRING IN THE HEADER but an integer in the namespace.
 *      Spec §6.2: "A version identifier SHALL be an integer, assigned at
 *      publication." Spec §6.8 renders it `"Version": "1"`. The model holds
 *      the integer; this serializer renders it.
 *
 * All ten Header fields are REQUIRED (§6.6) and §9.4 makes carrying them a
 * conformance condition for the Profile. This module will SERIALIZE an
 * incomplete Profile — that is `conformance.ts`'s job to detect, not this
 * module's to silently prevent — but it never invents a value to fill a gap.
 */

import type { Channel, ChannelMode, Profile, ProfileVersion, Property, Role, Status } from './model.ts';

export class Spec2026ParseError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'Spec2026ParseError';
    this.path = path;
  }
}

type Json = Record<string, unknown>;

/** Spec §6.8 renders the flags as "yes" / "no". */
export function yesNo(value: boolean): 'yes' | 'no' {
  return value ? 'yes' : 'no';
}

export function parseYesNo(value: unknown, path: string): boolean {
  if (value === 'yes') return true;
  if (value === 'no') return false;
  throw new Spec2026ParseError(path, `expected "yes" or "no", got ${JSON.stringify(value)}`);
}

const STATUSES: readonly Status[] = ['Unpublished', 'Published', 'Deprecated'];

// --- Serialize --------------------------------------------------------------

export function serializeProperty(property: Property): Json {
  const out: Json = {
    Name: property.name,
    Mandatory: yesNo(property.mandatory),
    Propagate: yesNo(property.propagate),
  };
  // Default sits between Propagate and Description, matching the §6.8 example
  // byte for byte. Omitted where undefined: absence means "no value until one
  // is delivered", which is a different contract from any present value (§6.4).
  if (property.default !== undefined) out['Default'] = property.default;
  out['Description'] = property.description;
  // Omitted rather than invented when the source had none. An empty string is
  // a claim that the author supplied an empty sample; absence is the truth.
  if (property.sample !== undefined) out['Sample'] = property.sample;
  return out;
}

/** Spec §6.5, §6.8: a Channel in the wire shape. */
export function serializeChannel(channel: Channel): Json {
  const out: Json = {
    Name: channel.name,
    Mode: channel.mode,
    Protocol: channel.protocol,
  };
  if (channel.providerRole !== undefined) out['Provider Role'] = channel.providerRole;
  if (channel.consumerRole !== undefined) out['Consumer Role'] = channel.consumerRole;
  out['Description'] = channel.description;
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

  // An unpublished Profile carries no assigned Version (§6.2–§6.3). Absence
  // here means Unpublished, and is meaningful — preserved, not defaulted to 1.
  if (profile.version !== undefined) header['Version'] = String(profile.version);
  if (profile.pubDate !== undefined) header['Pub Date'] = profile.pubDate;
  if (profile.status !== undefined) header['Status'] = profile.status;
  if (profile.owner !== undefined) header['Owner'] = profile.owner;
  if (profile.title !== undefined) header['Title'] = profile.title;
  if (profile.providerTitle !== undefined) header['Provider'] = profile.providerTitle;
  if (profile.consumerTitle !== undefined) header['Consumer'] = profile.consumerTitle;
  if (profile.description !== undefined) header['Description'] = profile.description;
  if (profile.website !== undefined) header['Website'] = profile.website;

  const document: Json = {
    Header: header,
    Properties: {
      Provider: propertiesOfRole(version, 'provider'),
      Consumer: propertiesOfRole(version, 'consumer'),
    },
  };

  // Channels are not assigned to a role, so the block is a single array
  // (§6.8). Absent when the Profile declares none — "a Profile that declares
  // no Channels is unaffected by this section" (§6.5), and every Profile
  // published before Channels were defined stays valid without the key.
  if (version.channels && version.channels.length > 0) {
    document['Channels'] = version.channels.map(serializeChannel);
  }

  return document;
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

    const defaultValue = p['Default'];
    if (defaultValue !== undefined) {
      if (typeof defaultValue !== 'string') {
        throw new Spec2026ParseError(`${where}(${name}).Default`, 'expected a string');
      }
      property.default = defaultValue;
    }

    return property;
  });
}

const CHANNEL_MODES: readonly ChannelMode[] = ['stream', 'message', 'datagram'];

function parseChannels(raw: unknown, path: string): Channel[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Spec2026ParseError(path, 'expected an array');

  return raw.map((entry, i) => {
    const c = entry as Json;
    const where = `${path}[${i}]`;
    const name = c['Name'];
    if (typeof name !== 'string') throw new Spec2026ParseError(where, 'Channel has no Name');

    const mode = c['Mode'];
    if (!CHANNEL_MODES.includes(mode as ChannelMode)) {
      throw new Spec2026ParseError(
        `${where}(${name}).Mode`,
        `expected one of ${CHANNEL_MODES.join(', ')} (spec §6.5), got ${JSON.stringify(mode)}`,
      );
    }

    const protocol = c['Protocol'];
    if (typeof protocol !== 'string') {
      throw new Spec2026ParseError(`${where}(${name})`, 'Channel has no Protocol');
    }
    const description = c['Description'];
    if (typeof description !== 'string') {
      throw new Spec2026ParseError(`${where}(${name})`, 'Channel has no Description');
    }

    const channel: Channel = { name, mode: mode as ChannelMode, protocol, description };
    if (typeof c['Provider Role'] === 'string') channel.providerRole = c['Provider Role'];
    if (typeof c['Consumer Role'] === 'string') channel.consumerRole = c['Consumer Role'];
    return channel;
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
      // Both superseded vocabularies are refused BY NAME, so a stale document
      // fails with its provenance visible: "Active" is the 2022 draft,
      // "Draft" the 26 Aug 2026 draft (renamed Unpublished on 8 Sept).
      const hint =
        status === 'Draft'
          ? ' ("Draft" was renamed "Unpublished" in the September 2026 revision)'
          : status === 'Active' || status === 'Testing'
            ? ' (a 2022-draft value; the 2026 lifecycle is Unpublished/Published/Deprecated)'
            : '';
      throw new Spec2026ParseError(
        `${name}.Header.Status`,
        `expected one of ${STATUSES.join(', ')}, got ${JSON.stringify(status)}${hint}`,
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
  const parsedVersion: ProfileVersion = {
    properties: [
      ...parseRoleGroup(properties['Provider'], 'provider', `${name}.Properties.Provider`),
      ...parseRoleGroup(properties['Consumer'], 'consumer', `${name}.Properties.Consumer`),
    ],
  };

  const channels = parseChannels(raw['Channels'], `${name}.Channels`);
  if (channels.length > 0) parsedVersion.channels = channels;

  profile.versions = [parsedVersion];
  return profile;
}

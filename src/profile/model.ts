/**
 * The canonical Profile model — design §19.2.
 *
 * "The specification mandates no serialization (spec §2.2), so the Registry
 * stores the model and serves both." This is that model: the semantic content
 * of a Profile, owing nothing to either wire shape.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE. In the deployed serialization, a
 * Property's role, requiredness and propagation are encoded by KEY PRESENCE,
 * and the value is always `null`:
 *
 *     {"server":null,"name":"electric","propagate":null,"description":"..."}
 *      ^^^^^^^^^^^^^                    ^^^^^^^^^^^^^^^
 *      provider supplies it             propagate is on
 *
 * A `server` key that is present-and-null means one thing; a `server` key that
 * is absent means the opposite. Any code that treats `null` as "no value" —
 * `if (p.server)`, a JSON cleaner that strips nulls, an ORM that coalesces —
 * silently inverts the contract. ARETE.md names this exact hazard, and it is
 * why the model below stores booleans rather than carrying the raw shape
 * around: once parsed, presence is a `true`, and `true` survives things that
 * `null` does not.
 *
 * Absence at the top level means something different and is preserved as
 * `undefined`. A Profile with no `company` key is not a Profile whose company
 * is empty, and re-serializing must not invent one.
 */

export type Role = 'provider' | 'consumer';

export type Property = {
  name: string;
  description: string;
  /**
   * Which side supplies the value (spec §6.3).
   *
   * In the 2026 shape this is STRUCTURAL — Properties are grouped into
   * `Provider` and `Consumer` arrays, "so the supplying role is given
   * structurally rather than repeated on each Property". In the deployed shape
   * it is the presence of the `server` key. Same fact, opposite mechanics.
   */
  role: Role;
  /** Spec §6.3 Mandatory. Legacy: `required` key present. 2026: `"yes"`/`"no"`. */
  mandatory: boolean;
  /**
   * Spec §6.3 Propagate — a DELIVERY MODE, not confidentiality.
   *
   * Set means broadcast: the value reaches every Connection the Capability
   * holds and is seeded into each new one at Bind. Unset means addressed only.
   * Legacy: `propagate` key present. 2026: `"yes"`/`"no"`.
   */
  propagate: boolean;
  /**
   * Spec §6.4 Sample. Documentary — "this specification takes no view" of it.
   *
   * `undefined` means the source had none, which is true of ALL 303 properties
   * in the deployed corpus: the legacy format has no sample field. See
   * `conformance.ts` for what that costs.
   */
  sample?: string;
  /**
   * Spec §6.4 Default (8 Sept revision). Optional, and PART OF THE CONTRACT:
   * where defined, it is the value a Connection starts with when the supplying
   * Capability has none at Bind, and redefining it in a later version breaks
   * additivity (§6.2). Absent means the Property has no value until one is
   * delivered — which is a different statement from a Default of empty string.
   */
  default?: string;
};

/** Spec §6.5 delivery modes. Exactly three; there is no unreliable stream. */
export type ChannelMode = 'stream' | 'message' | 'datagram';

/**
 * Spec §6.5 (8 Sept revision) — a Channel: what a Property cannot carry, a
 * protocol's own traffic or a stream.
 *
 * Channels share ONE NAME SPACE with Properties, and are stricter than
 * Properties under additivity: a Profile's Channels are fixed by its first
 * published version — a later version can neither add, remove, nor redefine
 * one (§6.2). A Property nobody uses can be ignored; an open Channel nobody
 * speaks on is indistinguishable from a broken one.
 */
export type Channel = {
  name: string;
  mode: ChannelMode;
  /** IANA service name / ALPN ID where one exists; else Description explains. */
  protocol: string;
  description: string;
  /**
   * Where the carried protocol has roles of its own (RTSP client/server, RTP
   * sender/receiver), which protocol role each PROFILE role plays — stated
   * structurally so §9.5's demand on a Node is checkable.
   */
  providerRole?: string;
  consumerRole?: string;
};

export type ProfileVersion = {
  properties: Property[];
  /** Absent and empty are equivalent: a Profile with no Channels (§6.5). */
  channels?: Channel[];
};

/**
 * Spec §6.3 (8 Sept revision). Three states, movement one-way:
 * Unpublished → Published → Deprecated. There is no unpublishing.
 *
 * The 26 Aug draft called the first state "Draft"; the revision renamed it,
 * and with the rename moved the unpublished content OUT of the Registry
 * entirely — "its content lives with its author" (§6.3), and the Registry
 * "SHALL NOT hold, serve, or answer for" it (§7.3, §9.3).
 */
export type Status = 'Unpublished' | 'Published' | 'Deprecated';

/**
 * `undefined` on any optional field means THE KEY WAS ABSENT, and the
 * serializer will omit it again. It never means "empty".
 */
export type Profile = {
  name: string;
  title?: string;
  /** Legacy `comment`. The Header's narrative description. */
  description?: string;
  /** Legacy `company`. Maps to the Header's Owner — a stewardship field. */
  owner?: string;
  website?: string;
  /** Legacy `server`: the title of the Provider capability, not a flag. */
  providerTitle?: string;
  /** Legacy `client`: the title of the Consumer capability. */
  consumerTitle?: string;

  /**
   * Spec §6.4 Version — "assigned at publication; the Draft carries none."
   * Absent means this is a Draft, not an incompletely-known version.
   */
  version?: number;
  /** Spec §6.4 Pub Date — "the Draft carries none." */
  pubDate?: string;
  /** Spec §6.4 Status. Absent means unknown, which an import must resolve. */
  status?: Status;

  created?: string;
  modified?: string;
  used?: string;

  /**
   * Legacy lifecycle fields. Null in every one of the 70 deployed records, and
   * carried rather than interpreted: the 2026 revision replaces them with
   * per-version Status (§12.2), so mapping them onto that would be a guess.
   */
  approved?: string | null;
  active?: string | null;

  /**
   * Absent in 2 of the 70 deployed records — distinct from present-but-empty.
   *
   * The legacy version object carries ONLY `properties`: no number, no status,
   * no date. The format has no version identifiers at all, so an importer
   * assigns them by array position, which is consistent with spec §6.2 making
   * version assignment the Registry's job rather than the author's.
   */
  versions?: ProfileVersion[];
};

/** Properties supplied by one side. Spec 2022 §2.4 defines the Capabilities this way. */
export function propertiesForRole(version: ProfileVersion, role: Role): Property[] {
  return version.properties.filter((p) => p.role === role);
}

/**
 * The three presence-encoded flags of one Property, as a comparable tuple.
 *
 * Used by the golden tests to compare a parsed Property against the raw JSON
 * independently of the parser — so a bug in the parser cannot also define what
 * "correct" means.
 */
export function flagsOf(property: Property): string {
  return `${property.role}|${property.mandatory ? 'mandatory' : 'optional'}|${
    property.propagate ? 'propagate' : 'no-propagate'
  }`;
}

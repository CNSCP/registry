/**
 * Types for the anchor constant. The constant itself is plain `.mjs` because
 * `verify-spec.mjs` runs under bare `node`, with no type stripping; the test
 * suite reads the same module and wants types. One file, two readers.
 */

export declare const SPEC_ANCHOR: {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly assembled: string;
  readonly sections: string;
  readonly published: string;
};

export declare function abbreviate(sha256?: string): string;

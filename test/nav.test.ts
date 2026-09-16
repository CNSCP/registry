/**
 * The Registry's header and cnscp.io's header are the same six — 16 September 2026.
 *
 * They are two copies on two origins, deliberately (§4.4: no console makes a
 * cross-origin call, and the Registry must keep answering when a static site
 * is not). What is deliberate about duplication is that somebody checks it.
 * Nothing did, for the licence texts, and four copies drifted for a year.
 *
 * So this compares `SITE_NAV` against the website's `nav.json` when the web
 * repository is checked out beside this one, and SKIPS when it is not — the
 * same shape as `verify-spec`, and for the same reason: the check must be
 * real where the material exists and silent where it doesn't, never a failure
 * that teaches people to ignore it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SITE_NAV } from '../src/part-three/routes.ts';

const here = dirname(fileURLToPath(import.meta.url));
// The website sits beside this repository, as the specification does.
const NAV_JSON = resolve(here, '../../web/nav.json');

type Item = { id: string; label: string; href: string };

describe('the shared navigation (§4.4)', () => {
  test('SITE_NAV is the six, in order', () => {
    assert.deepEqual(
      SITE_NAV.map((i) => i.id),
      ['home', 'registry', 'spec', 'legal', 'about', 'contact'],
    );
  });

  test('every item leaves this host except Registry', () => {
    for (const item of SITE_NAV) {
      if (item.id === 'registry') {
        assert.equal(item.href, '/', 'Registry is this host');
        continue;
      }
      assert.ok(
        /^https:\/\//.test(item.href),
        `${item.id} points at "${item.href}"; a shared item that is not this host is an absolute URL, ` +
          `or it will resolve against cp.cnscp.io and 404`,
      );
    }
  });

  test('no shared item takes a Prefix out of the namespace', () => {
    // A dotless path on this host is either a console path or an allocation
    // page (§19.1), so a relative shared link would silently claim a Prefix.
    for (const item of SITE_NAV) {
      if (item.href === '/') continue;
      assert.ok(!item.href.startsWith('/'), `${item.id} is a local path and would shadow a Prefix`);
    }
  });

  test('the labels match the website, item for item', (t) => {
    if (!existsSync(NAV_JSON)) {
      t.skip(`no web checkout at ${NAV_JSON} — nothing to compare against`);
      return;
    }
    const site = JSON.parse(readFileSync(NAV_JSON, 'utf8')) as { items: Item[] };

    assert.deepEqual(
      SITE_NAV.map((i) => ({ id: i.id, label: i.label })),
      site.items.map((i) => ({ id: i.id, label: i.label })),
      'the two headers have drifted — edit nav.json, run scripts/nav.mjs there, and match SITE_NAV here',
    );
  });

  test('where both name an absolute URL, they name the same one', (t) => {
    if (!existsSync(NAV_JSON)) {
      t.skip('no web checkout');
      return;
    }
    const site = JSON.parse(readFileSync(NAV_JSON, 'utf8')) as { items: Item[] };
    const byId = new Map(site.items.map((i) => [i.id, i.href]));

    for (const item of SITE_NAV) {
      const theirs = byId.get(item.id);
      if (!theirs || !/^https?:/.test(theirs)) continue; // the site links its own pages relatively

      if (item.id === 'registry') {
        // Each host points this one at ITSELF: '/' here, the absolute origin
        // there. Same destination, two spellings, and that is the point.
        assert.equal(item.href, '/');
        assert.equal(theirs, 'https://cp.cnscp.io', 'the site should send Registry to this host');
        continue;
      }
      assert.equal(item.href, theirs, `${item.id} points somewhere different on each host`);
    }
  });
});

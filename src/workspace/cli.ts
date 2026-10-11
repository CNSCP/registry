/**
 * Share and Import from a terminal — design §20.3, "Sharing a form" — for a
 * host nobody browses to. It speaks to the host over HTTP exactly as the page
 * does, so there is one implementation of the rules, not two.
 *
 *   npm run workspace -- share <name> [--out <file>]
 *   npm run workspace -- import <file | link> [--apply] [--replace]
 *
 *   CP_WORKSPACE_URL     the host (default http://localhost:8080)
 *   CP_WORKSPACE_TOKEN   its workspace credential (import only)
 *
 * `import` previews unless --apply is given. --replace also replaces forms
 * held here that differ, using the ETags the preview just showed.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const base = (process.env['CP_WORKSPACE_URL'] ?? 'http://localhost:8080').replace(/\/+$/, '');
const [command, target, ...rest] = process.argv.slice(2);
const flag = (f: string): boolean => rest.includes(f);
const option = (f: string): string | undefined => {
  const i = rest.indexOf(f);
  return i === -1 ? undefined : rest[i + 1];
};

function usage(): never {
  console.error('usage: npm run workspace -- share <name> [--out <file>]\n       npm run workspace -- import <file | link> [--apply] [--replace]');
  process.exit(2);
}

type Row = { name: string; as?: string; holder?: string | null; outcome: string; refusal?: string; detail?: string; current?: string; applied: boolean };

async function main(): Promise<void> {
  if (!command || !target) usage();

  if (command === 'share') {
    const r = await fetch(`${base}/workspace/share/${encodeURIComponent(target)}`);
    const text = await r.text();
    if (r.status !== 200) throw new Error(`${r.status}: ${text}`);
    const out = option('--out');
    if (out) {
      writeFileSync(out, text);
      console.error(`wrote ${out}`);
    } else process.stdout.write(text + '\n');
    return;
  }

  if (command === 'import') {
    const token = process.env['CP_WORKSPACE_TOKEN'];
    if (!token) throw new Error('CP_WORKSPACE_TOKEN is not set: importing writes to the workspace.');
    const source: Record<string, unknown> = /^https?:\/\//i.test(target) ? { link: target } : { source: JSON.parse(readFileSync(target, 'utf8')) };
    const send = async (body: Record<string, unknown>) => {
      const r = await fetch(`${base}/workspace/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const j = (await r.json()) as { message?: string; items: Row[]; origin: { from: string | null; verified: boolean; via: string[] }; apply: boolean; applied: number };
      if (r.status !== 200) throw new Error(`${r.status}: ${j.message ?? JSON.stringify(j)}`);
      return j;
    };

    let result = await send(source);
    if (flag('--apply')) {
      const replace: Record<string, string> = {};
      if (flag('--replace')) for (const i of result.items) if (i.outcome === 'differs' && i.current) replace[i.name] = i.current;
      result = await send({ ...source, apply: true, replace });
    }
    const o = result.origin;
    console.log(`${result.apply ? `imported ${result.applied} of ${result.items.length}` : 'preview — nothing written'}; from ${o.from ?? 'an unknown origin'}${o.via.length ? ` via ${o.via.join(', ')}` : ''} (${o.verified ? 'verified' : 'as stated'})`);
    for (const i of result.items) {
      const lands = i.as ? `${i.as === 'own' ? 'own work' : 'shared copy'}${i.holder ? ` · ${i.holder}` : ''}` : '';
      const outcome = i.applied ? (i.outcome === 'new' ? 'imported' : 'replaced') : i.refusal ? `refused: ${i.refusal}` : i.outcome;
      console.log(`  ${i.name.padEnd(40)} ${lands.padEnd(28)} ${outcome}${i.detail ? ` — ${i.detail}` : ''}`);
    }
    if (!result.apply && result.items.some((i) => i.outcome === 'differs')) console.log('Some forms held here differ: add --apply --replace to replace them.');
    return;
  }
  usage();
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});

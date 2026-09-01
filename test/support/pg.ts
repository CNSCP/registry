/**
 * A real PostgreSQL for the integration tests.
 *
 * PGlite is Postgres built to WebAssembly, and `pglite-socket` puts it behind
 * the actual wire protocol on a TCP port — so `node-pg-migrate` and the `pg`
 * client connect to it unmodified, and the migrations, triggers, constraints
 * and plpgsql functions execute as Postgres, not as an approximation.
 *
 * This exists because the first cut of the audit chain shipped `char(31)` where
 * `chr(31)` was meant. Every unit test passed, `tsc` was clean, and the
 * migration would have failed on the first `migrate up`, because nothing in the
 * suite ever asked Postgres to parse the SQL. Anything the database enforces
 * needs a database to prove it.
 *
 * Caveat worth keeping in view: PGlite here is PostgreSQL 18 and §23 targets
 * 16. Everything the schema uses is PostgreSQL 11 or older, so the gap is
 * narrow — but it is a gap, and CI should eventually run a real 16.
 */

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(here, '../../migrations');

export type Harness = {
  pool: pg.Pool;
  connectionString: string;
  close: () => Promise<void>;
};

let port = 55432 + Math.floor(Math.random() * 2000);

/** Boot an empty database and apply every migration to it. */
export async function freshDatabase(): Promise<Harness> {
  const db = await PGlite.create();
  const myPort = port++;

  // Default is one connection. node-pg-migrate holds one while it runs and the
  // test pool wants another, so allow a few; queries are serialised onto the
  // single PGlite instance regardless.
  const server = new PGLiteSocketServer({ db, port: myPort, host: '127.0.0.1', maxConnections: 8 });
  await server.start();

  const connectionString = `postgres://postgres:postgres@127.0.0.1:${myPort}/postgres`;

  // node-pg-migrate's programmatic entrypoint, so the tests run exactly the
  // files `npm run migrate` runs.
  const { runner } = await import('node-pg-migrate');
  await runner({
    databaseUrl: connectionString,
    dir: MIGRATIONS_DIR,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
    // PGlite is single-connection; node-pg-migrate's advisory lock would
    // otherwise contend with the connection it is holding.
    noLock: true,
  });

  const pool = new pg.Pool({ connectionString, max: 1 });

  return {
    pool,
    connectionString,
    close: async () => {
      await pool.end();
      await server.stop();
      await db.close();
    },
  };
}

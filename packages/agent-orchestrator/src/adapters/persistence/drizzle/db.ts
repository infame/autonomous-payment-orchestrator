import pg from "pg";
// `pg` ships CJS only; under this repo's NodeNext/verbatimModuleSyntax
// tsconfig a named import isn't available, so destructure off the default.
const { Pool } = pg;

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;
export type PgPool = InstanceType<typeof Pool>;

export function createPool(databaseUrl: string): PgPool {
  return new Pool({ connectionString: databaseUrl });
}

export function createDb(pool: PgPool): Database {
  return drizzle(pool, { schema });
}

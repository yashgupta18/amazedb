import { Pool } from "pg";

const databaseGlobal = globalThis as typeof globalThis & {
  databasePool?: Pool;
};

export function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is missing. Configure apps/web/.env.local.");
  }
  databaseGlobal.databasePool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  });
  return databaseGlobal.databasePool;
}

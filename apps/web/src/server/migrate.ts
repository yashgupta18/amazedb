import { readFile } from "node:fs/promises";
import { getPool } from "./db";

const pool = getPool();
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(7419201)");
  await client.query(
    await readFile(new URL("./migration.sql", import.meta.url), "utf8"),
  );
  await client.query("COMMIT");
  console.log("Control-plane migration complete.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}

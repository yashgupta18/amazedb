import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

const credentials = z.object({
  email: z.email().trim().toLowerCase().max(254),
  password: z.string().min(10, "Use at least 10 characters.").max(128),
});
const projectInput = z.object({ name: z.string().trim().min(1).max(64) });
const projectId = z.uuid();
const sessionDuration = 60 * 60 * 24 * 7;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Account = { id: string; email: string };
export type Project = {
  id: string;
  name: string;
  schema_name: string;
  created_at: string;
  table_count: number;
};

export function hashToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function derivePassword(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${(await derivePassword(password, salt)).toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [algorithm, salt, hash] = stored.split("$");
  if (algorithm !== "scrypt" || !salt || !hash || !/^[a-f0-9]{128}$/.test(hash))
    return false;
  return timingSafeEqual(
    await derivePassword(password, salt),
    Buffer.from(hash, "hex"),
  );
}

function identifier(value: string) {
  if (!/^p_[a-f0-9]{32}$/.test(value))
    throw new Error("Invalid generated database identifier.");
  return `"${value}"`;
}

const projectColumns = `id, name, schema_name, created_at,
  (SELECT count(*)::int FROM pg_tables WHERE schemaname = schema_name) AS table_count`;

export class ControlPlane {
  constructor(private pool: Pool) {}

  private async transaction<Result>(
    work: (client: PoolClient) => Promise<Result>,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async newSession(client: PoolClient, account: Account) {
    const token = randomBytes(32).toString("base64url");
    await client.query(
      "DELETE FROM control_plane.sessions WHERE expires_at <= now()",
    );
    await client.query(
      "INSERT INTO control_plane.sessions (token_hash, account_id, expires_at) VALUES ($1, $2, now() + $3 * interval '1 second')",
      [hashToken(token), account.id, sessionDuration],
    );
    return { account, token, maxAge: sessionDuration };
  }

  async signUp(input: unknown) {
    const { email, password } = credentials.parse(input);
    const passwordHash = await hashPassword(password);
    try {
      return await this.transaction(async (client) => {
        const result = await client.query<Account>(
          "INSERT INTO control_plane.accounts (id, email, password_hash) VALUES ($1, $2, $3) RETURNING id, email",
          [randomUUID(), email, passwordHash],
        );
        return this.newSession(client, result.rows[0]);
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new ApiError(409, "An account with that email already exists.");
      throw error;
    }
  }

  async signIn(input: unknown) {
    const { email, password } = credentials.parse(input);
    const result = await this.pool.query<Account & { password_hash: string }>(
      "SELECT id, email, password_hash FROM control_plane.accounts WHERE email = $1",
      [email],
    );
    const account = result.rows[0];
    if (!account) {
      await derivePassword(password, "missing-account-timing-salt");
      throw new ApiError(401, "Incorrect email or password.");
    }
    if (!(await verifyPassword(password, account.password_hash)))
      throw new ApiError(401, "Incorrect email or password.");
    return this.transaction((client) =>
      this.newSession(client, { id: account.id, email: account.email }),
    );
  }

  async accountForSession(token: string | undefined): Promise<Account | null> {
    if (!token || token.length > 128) return null;
    const result = await this.pool.query<Account>(
      `SELECT accounts.id, accounts.email FROM control_plane.sessions sessions
       JOIN control_plane.accounts accounts ON accounts.id = sessions.account_id
       WHERE sessions.token_hash = $1 AND sessions.expires_at > now()`,
      [hashToken(token)],
    );
    return result.rows[0] ?? null;
  }

  async signOut(token: string | undefined) {
    if (token)
      await this.pool.query(
        "DELETE FROM control_plane.sessions WHERE token_hash = $1",
        [hashToken(token)],
      );
  }

  async listProjects(ownerId: string) {
    return (
      await this.pool.query<Project>(
        `SELECT ${projectColumns} FROM control_plane.projects WHERE owner_id = $1 ORDER BY created_at DESC`,
        [ownerId],
      )
    ).rows;
  }

  async createProject(ownerId: string, input: unknown) {
    const { name } = projectInput.parse(input);
    const id = randomUUID();
    const schemaName = `p_${id.replaceAll("-", "")}`;
    const anonKey = `amz_anon_${randomBytes(32).toString("base64url")}`;
    const serviceKey = `amz_service_${randomBytes(32).toString("base64url")}`;
    const project = await this.transaction(async (client) => {
      await client.query(
        `CREATE ROLE ${identifier(schemaName)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
      await client.query(
        `CREATE SCHEMA ${identifier(schemaName)} AUTHORIZATION ${identifier(schemaName)}`,
      );
      await client.query(
        `REVOKE ALL ON SCHEMA ${identifier(schemaName)} FROM PUBLIC`,
      );
      const result = await client.query<Project>(
        `INSERT INTO control_plane.projects (id, owner_id, name, schema_name, anon_key_hash, service_key_hash)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${projectColumns}`,
        [
          id,
          ownerId,
          name,
          schemaName,
          hashToken(anonKey),
          hashToken(serviceKey),
        ],
      );
      return result.rows[0];
    });
    return { project, keys: { anon: anonKey, service: serviceKey } };
  }

  async deleteProject(ownerId: string, id: string) {
    projectId.parse(id);
    await this.transaction(async (client) => {
      const result = await client.query<{ schema_name: string }>(
        "DELETE FROM control_plane.projects WHERE id = $1 AND owner_id = $2 RETURNING schema_name",
        [id, ownerId],
      );
      if (!result.rows[0]) throw new ApiError(404, "Project not found.");
      const schemaName = identifier(result.rows[0].schema_name);
      await client.query(`DROP SCHEMA ${schemaName} CASCADE`);
      const loginRole = result.rows[0].schema_name.replace(/^p_/, "d_");
      await client.query(`DROP ROLE IF EXISTS "${loginRole}"`);
      await client.query(`DROP ROLE ${schemaName}`);
    });
  }
}

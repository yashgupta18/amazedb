import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import {
  ApiError,
  hashPassword,
  hashToken,
  verifyPassword,
} from "./control-plane";
import { signProjectAccessToken } from "./project-tokens";

const credentials = z.object({
  email: z.email().trim().toLowerCase().max(254),
  password: z.string().min(10).max(128),
});
const refreshInput = z.object({
  refresh_token: z.string().regex(/^[A-Za-z0-9_-]{40,60}$/),
});
const accessTokenLifetime = 15 * 60;
const refreshTokenLifetime = 30 * 24 * 60 * 60;
const dummyPasswordHash = `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`;

export type ApplicationUser = { id: string; email: string };
export type TokenSession = {
  user: ApplicationUser;
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  refresh_token: string;
};

export class ApplicationAuth {
  constructor(private readonly pool: Pool) {}

  private async signingKey(projectId: string, apiKey: string | undefined) {
    if (
      !apiKey ||
      apiKey.length > 160 ||
      !/^amz_anon_[A-Za-z0-9_-]{40,60}$/.test(apiKey)
    )
      throw new ApiError(401, "A valid anon API key is required.");
    const result = await this.pool.query<{ service_key_hash: string }>(
      `SELECT service_key_hash FROM control_plane.projects
       WHERE id = $1 AND anon_key_hash = $2`,
      [projectId, hashToken(apiKey)],
    );
    if (!result.rows[0])
      throw new ApiError(401, "A valid anon API key is required.");
    return result.rows[0].service_key_hash;
  }

  private async newSession(
    projectId: string,
    serviceKeyHash: string,
    user: ApplicationUser,
  ): Promise<TokenSession> {
    const access_token = await signProjectAccessToken(
      projectId,
      serviceKeyHash,
      user.id,
    );
    const refresh_token = randomBytes(32).toString("base64url");
    await this.pool.query(
      `INSERT INTO control_plane.application_refresh_tokens (token_hash, project_id, user_id, expires_at)
       VALUES ($1, $2, $3, now() + $4 * interval '1 second')`,
      [hashToken(refresh_token), projectId, user.id, refreshTokenLifetime],
    );
    return {
      user,
      access_token,
      token_type: "bearer",
      expires_in: accessTokenLifetime,
      refresh_token,
    };
  }

  async signUp(projectId: string, apiKey: string | undefined, input: unknown) {
    const { email, password } = credentials.parse(input);
    const serviceKeyHash = await this.signingKey(projectId, apiKey);
    const user = { id: randomUUID(), email };
    try {
      const result = await this.pool.query<ApplicationUser>(
        `INSERT INTO control_plane.application_users (id, project_id, email, password_hash)
         VALUES ($1, $2, $3, $4) RETURNING id, email`,
        [user.id, projectId, email, await hashPassword(password)],
      );
      return this.newSession(projectId, serviceKeyHash, result.rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new ApiError(
          409,
          "An application user with that email already exists.",
        );
      throw error;
    }
  }

  async signIn(projectId: string, apiKey: string | undefined, input: unknown) {
    const { email, password } = credentials.parse(input);
    const serviceKeyHash = await this.signingKey(projectId, apiKey);
    const result = await this.pool.query<
      ApplicationUser & { password_hash: string }
    >(
      `SELECT id, email, password_hash FROM control_plane.application_users
       WHERE project_id = $1 AND email = $2`,
      [projectId, email],
    );
    const stored = result.rows[0];
    const valid = await verifyPassword(
      password,
      stored?.password_hash ?? dummyPasswordHash,
    );
    if (!stored || !valid)
      throw new ApiError(401, "Incorrect email or password.");
    return this.newSession(projectId, serviceKeyHash, {
      id: stored.id,
      email: stored.email,
    });
  }

  async refresh(projectId: string, apiKey: string | undefined, input: unknown) {
    const { refresh_token } = refreshInput.parse(input);
    const serviceKeyHash = await this.signingKey(projectId, apiKey);
    const tokenHash = hashToken(refresh_token);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<
        ApplicationUser & { password_hash?: never } & {
          expires_at: Date;
          revoked_at: Date | null;
        }
      >(
        `SELECT users.id, users.email, sessions.expires_at, sessions.revoked_at
         FROM control_plane.application_refresh_tokens sessions
         JOIN control_plane.application_users users
           ON users.project_id = sessions.project_id AND users.id = sessions.user_id
         WHERE sessions.project_id = $1 AND sessions.token_hash = $2
         FOR UPDATE OF sessions`,
        [projectId, tokenHash],
      );
      const session = result.rows[0];
      if (!session || session.revoked_at || session.expires_at <= new Date()) {
        await client.query("ROLLBACK");
        throw new ApiError(
          401,
          "Refresh token is invalid, expired, or already used.",
        );
      }
      await client.query(
        "UPDATE control_plane.application_refresh_tokens SET revoked_at = now() WHERE token_hash = $1",
        [tokenHash],
      );
      const user = { id: session.id, email: session.email };
      const access_token = await signProjectAccessToken(
        projectId,
        serviceKeyHash,
        user.id,
      );
      const nextRefresh = randomBytes(32).toString("base64url");
      await client.query(
        `INSERT INTO control_plane.application_refresh_tokens (token_hash, project_id, user_id, expires_at)
         VALUES ($1, $2, $3, now() + $4 * interval '1 second')`,
        [hashToken(nextRefresh), projectId, user.id, refreshTokenLifetime],
      );
      await client.query("COMMIT");
      return {
        user,
        access_token,
        token_type: "bearer" as const,
        expires_in: accessTokenLifetime,
        refresh_token: nextRefresh,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async signOut(projectId: string, apiKey: string | undefined, input: unknown) {
    await this.signingKey(projectId, apiKey);
    const { refresh_token } = refreshInput.parse(input);
    await this.pool.query(
      `UPDATE control_plane.application_refresh_tokens SET revoked_at = now()
       WHERE project_id = $1 AND token_hash = $2 AND revoked_at IS NULL`,
      [projectId, hashToken(refresh_token)],
    );
    return { success: true };
  }
}

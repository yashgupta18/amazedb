import { createHmac } from "node:crypto";
import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import { z } from "zod";
import { ApiError } from "./control-plane";

export type ProjectClaims = JWTPayload & {
  sub: string;
  role: "authenticated";
};

export function projectSigningKey(projectId: string, serviceKeyHash: string) {
  return createHmac("sha256", serviceKeyHash)
    .update(`project-jwt:v1:${projectId}`)
    .digest();
}

export async function signProjectAccessToken(
  projectId: string,
  serviceKeyHash: string,
  userId: string,
) {
  return new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("amazedb")
    .setAudience(projectId)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(projectSigningKey(projectId, serviceKeyHash));
}

export async function verifyProjectAccessToken(
  projectId: string,
  serviceKeyHash: string,
  token: string,
): Promise<ProjectClaims> {
  try {
    const { payload } = await jwtVerify(
      token,
      projectSigningKey(projectId, serviceKeyHash),
      { algorithms: ["HS256"], issuer: "amazedb", audience: projectId },
    );
    const claims = z
      .object({
        sub: z.uuid(),
        role: z.literal("authenticated"),
      })
      .parse(payload);
    return { ...payload, ...claims };
  } catch {
    throw new ApiError(401, "The project access token is invalid or expired.");
  }
}

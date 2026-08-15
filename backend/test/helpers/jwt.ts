import { SignJWT } from "jose";

const secret = () => new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);

/** Mints a token shaped like one GoTrue would issue, signed with the same
 * HS256 secret `verifyAccessToken` checks against in tests. */
export async function signTestAccessToken(
  sub: string,
  opts: { email?: string; expiresIn?: string } = {},
): Promise<string> {
  return new SignJWT({ email: opts.email ?? `${sub}@example.com`, role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "1h")
    .sign(secret());
}

export async function signExpiredAccessToken(sub: string): Promise<string> {
  return new SignJWT({ email: `${sub}@example.com`, role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setAudience("authenticated")
    .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 1)
    .sign(secret());
}

/** Signed with a different secret entirely — a tampered/forged token. */
export async function signInvalidAccessToken(sub: string): Promise<string> {
  const wrongSecret = new TextEncoder().encode("a-completely-different-secret-000000000000");
  return new SignJWT({ email: `${sub}@example.com`, role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(wrongSecret);
}

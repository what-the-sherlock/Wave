import { config } from "../config/env.js";
import { ServiceUnavailableError } from "../errors/AppError.js";

/**
 * A thin, explicit proxy over Supabase Storage's REST API — same rationale
 * as `auth/supabaseAuthClient.ts`: no `@supabase/supabase-js` dependency,
 * a handful of `fetch` calls make the actual wire behaviour easy to read.
 * Endpoints and response shapes below were verified against a running
 * local `supabase start` instance, not assumed from memory.
 *
 * Every function here runs under the *caller's own* access token, never
 * service_role — reachable from the HTTP request path. The service_role
 * variants (used only by queue workers) live in
 * `queue/workers/storageAdminClient.ts`, a separate module so this one
 * never imports `config/privileged.ts` (eslint-enforced —
 * docs/security-model.md §5).
 */

const STORAGE_URL = `${config.SUPABASE_URL}/storage/v1`;
const BUCKET = "attachments";

async function call(
  path: string,
  init: { method: string; accessToken?: string; body?: unknown },
): Promise<Response> {
  const headers: Record<string, string> = { apikey: config.SUPABASE_ANON_KEY };
  if (init.accessToken) {
    headers.Authorization = `Bearer ${init.accessToken}`;
  }
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  try {
    return await fetch(`${STORAGE_URL}${path}`, {
      method: init.method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ServiceUnavailableError("Storage service is unreachable");
  }
}

export type SignedUpload = { url: string };

/**
 * Subject to the "attachments writable by channel members" storage.objects
 * RLS policy for real (docs/security-model.md §9's defense in depth), not
 * just the application-level channel-membership check `upload.service.ts`
 * also performs. Returns an absolute URL — the browser uploads to it
 * directly (docs/security-model.md §9: "the API never touches bytes"), but
 * deliberately never learns `SUPABASE_URL` itself
 * (docs/target-architecture.md §5's "no supabase-js in the browser"); the
 * signed token embedded in the URL is self-sufficient authorization for the
 * PUT, no separate header needed.
 */
export async function createSignedUploadUrl(accessToken: string, path: string): Promise<SignedUpload> {
  const res = await call(`/object/upload/sign/${BUCKET}/${path}`, {
    method: "POST",
    accessToken,
    body: {},
  });
  if (!res.ok) {
    throw new ServiceUnavailableError("Could not create an upload URL");
  }
  const body = (await res.json()) as { url: string };
  return { url: `${STORAGE_URL}${body.url}` };
}

export async function createSignedDownloadUrl(
  accessToken: string,
  path: string,
  expiresInSeconds: number,
  downloadFilename?: string,
): Promise<string> {
  const res = await call(`/object/sign/${BUCKET}/${path}`, {
    method: "POST",
    accessToken,
    body: { expiresIn: expiresInSeconds },
  });
  if (!res.ok) {
    throw new ServiceUnavailableError("Could not create a download URL");
  }
  const body = (await res.json()) as { signedURL: string };
  const suffix = downloadFilename ? `&download=${encodeURIComponent(downloadFilename)}` : "";
  return `${STORAGE_URL}${body.signedURL}${suffix}`;
}

import { config } from "../../config/env.js";
import { loadPrivilegedConfig } from "../../config/privileged.js";
import { ServiceUnavailableError } from "../../errors/AppError.js";

/**
 * service_role-only Storage REST calls — never reachable from the HTTP
 * request path (docs/security-model.md §5); only `attachmentProcess.worker.ts`
 * and `cleanupOrphans.worker.ts` import this. The user-token variants used
 * by the presign/download-url HTTP endpoints live in
 * `uploads/storageClient.ts`, which deliberately does not import
 * `config/privileged.ts` at all.
 */

const STORAGE_URL = `${config.SUPABASE_URL}/storage/v1`;
const BUCKET = "attachments";

function authHeaders(): Record<string, string> {
  const { SUPABASE_SERVICE_ROLE_KEY } = loadPrivilegedConfig();
  return {
    apikey: config.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };
}

export async function downloadObjectAsServiceRole(path: string): Promise<ArrayBuffer> {
  const res = await fetch(`${STORAGE_URL}/object/${BUCKET}/${path}`, { headers: authHeaders() });
  if (!res.ok) {
    throw new ServiceUnavailableError("Could not download the uploaded object");
  }
  return res.arrayBuffer();
}

export async function uploadObjectAsServiceRole(
  path: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const res = await fetch(`${STORAGE_URL}/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": contentType, "x-upsert": "true" },
    body,
  });
  if (!res.ok) {
    throw new ServiceUnavailableError("Could not upload the thumbnail");
  }
}

export async function deleteObjectAsServiceRole(path: string): Promise<void> {
  const res = await fetch(`${STORAGE_URL}/object/${BUCKET}/${path}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok && res.status !== 404) {
    throw new ServiceUnavailableError("Could not delete the storage object");
  }
}

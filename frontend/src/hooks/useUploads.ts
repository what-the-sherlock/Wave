import { useMutation, useQuery } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { axiosInstance } from "../lib/axios";
import { extractErrorMessage } from "../lib/utils";

type PresignResponse = { attachmentId: string; uploadUrl: string; storagePath: string };

export type PendingUpload = { attachmentId: string; name: string };

/**
 * Two steps: presign through our API (verifies channel membership, reserves
 * the row), then PUT the raw bytes straight to the signed Storage URL from
 * the browser — the API never touches file bytes
 * (docs/security-model.md §9). The signed URL is absolute and
 * self-authorizing; no Supabase URL/key is ever known to the frontend
 * (docs/target-architecture.md §5).
 */
export function usePresignUpload(channelId: string) {
  return useMutation({
    mutationFn: async (file: File): Promise<PendingUpload> => {
      const presign = await axiosInstance.post<PresignResponse>("/uploads/presign", {
        channelId,
        filename: file.name,
        mimeType: file.type,
        size: file.size,
      });

      const uploadRes = await fetch(presign.data.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!uploadRes.ok) {
        throw new Error("Upload failed");
      }

      return { attachmentId: presign.data.attachmentId, name: file.name };
    },
    onError: (error) => toast.error(extractErrorMessage(error, "Upload failed")),
  });
}

/**
 * `enabled` defaults to lazy (off) — most attachments in a scrollback are
 * never opened, so minting a signed URL for every rendered message would be
 * wasteful. Image thumbnails pass `enabled: true` to fetch eagerly; file
 * cards fetch on click instead. `variant: "thumb"` requests the generated
 * thumbnail (falling back server-side to the original if none exists yet).
 */
export function useDownloadUrl(
  attachmentId: string | undefined,
  enabled = false,
  variant: "original" | "thumb" = "original",
) {
  return useQuery({
    queryKey: ["attachment-download-url", attachmentId, variant],
    queryFn: async () => {
      const res = await axiosInstance.get<{ url: string }>(`/uploads/${attachmentId}/download-url`, {
        params: { variant },
      });
      return res.data.url;
    },
    enabled: Boolean(attachmentId) && enabled,
    // Just under the 5-minute signed-URL expiry.
    staleTime: 240_000,
  });
}

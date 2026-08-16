import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import { useDownloadUrl } from "../hooks/useUploads";
import type { Attachment } from "../types/channel";

/** Renders an image attachment's inline thumbnail (fetched eagerly — it's
 * small, that's the whole point of generating it) and, on click, a
 * full-screen viewer of the original (fetched lazily). */
export default function ImageAttachment({ attachment }: { attachment: Attachment }) {
  const [expanded, setExpanded] = useState(false);
  const thumb = useDownloadUrl(attachment.id, true, "thumb");
  const original = useDownloadUrl(attachment.id, expanded, "original");

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="block mt-1.5 max-w-xs max-h-64 rounded-lg overflow-hidden border border-base-300"
      >
        {thumb.data ? (
          <img src={thumb.data} alt={attachment.name} className="max-w-full max-h-64 object-contain" />
        ) : (
          <div className="w-40 h-32 flex items-center justify-center bg-base-200">
            <Loader2 className="size-5 animate-spin text-base-content/40" />
          </div>
        )}
      </button>

      {expanded &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center"
            onClick={() => setExpanded(false)}
          >
            <button
              type="button"
              className="btn btn-circle btn-sm absolute top-4 right-4"
              onClick={() => setExpanded(false)}
            >
              <X className="size-4" />
            </button>
            {original.data ? (
              <img
                src={original.data}
                alt={attachment.name}
                className="max-w-[90vw] max-h-[90vh] object-contain"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <Loader2 className="size-8 animate-spin text-white" />
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

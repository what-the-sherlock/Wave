import { useState, type DragEvent, type ReactNode } from "react";

/** Wraps its children with drag-and-drop file handling — a visual overlay
 * while dragging, `onFiles` called with the dropped files. Paperclip-button
 * and paste-based attachment picking live in MessageInput.tsx itself, which
 * shares the same `onFiles` callback. */
export default function Dropzone({
  onFiles,
  children,
}: {
  onFiles: (files: File[]) => void;
  children: ReactNode;
}) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragging(true);
    }
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      onFiles(Array.from(e.dataTransfer.files));
    }
  };

  return (
    <div
      className="relative"
      onDragOver={handleDragOver}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      {children}
      {isDragging && (
        <div className="absolute inset-0 bg-primary/10 border-2 border-dashed border-primary rounded-lg flex items-center justify-center pointer-events-none z-10">
          <span className="text-primary font-medium text-sm">Drop to attach</span>
        </div>
      )}
    </div>
  );
}

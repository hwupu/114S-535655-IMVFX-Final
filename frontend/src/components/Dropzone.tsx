"use client";

import { useRef, useState, DragEvent, ChangeEvent } from "react";

interface Props {
  onFile: (file: File) => void;
  disabled?: boolean;
  currentImageUrl?: string | null;
}

export default function Dropzone({ onFile, disabled, currentImageUrl }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) onFile(file);
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFile(file);
    e.target.value = "";
  };

  return (
    <div
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={[
        "relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed transition-colors cursor-pointer select-none",
        dragging ? "border-indigo-400 bg-indigo-950/30" : "border-zinc-600 hover:border-zinc-400",
        disabled ? "opacity-50 cursor-not-allowed" : "",
        currentImageUrl ? "h-64" : "h-48",
      ].join(" ")}
    >
      {currentImageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={currentImageUrl}
          alt="Uploaded"
          className="h-full w-full rounded-xl object-contain"
        />
      ) : (
        <>
          <svg className="mb-3 h-10 w-10 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
          </svg>
          <p className="text-sm text-zinc-400">Drag & drop an image, or <span className="text-indigo-400 underline">browse</span></p>
          <p className="mt-1 text-xs text-zinc-600">PNG, JPG, WEBP</p>
        </>
      )}
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleChange} />
    </div>
  );
}

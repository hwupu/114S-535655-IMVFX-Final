"use client";

import { useState, useRef, useCallback } from "react";
import TestShell from "@/components/TestShell";
import Dropzone from "@/components/Dropzone";
import MaskCanvas from "@/components/MaskCanvas";

// 1×1 transparent PNG — used as the blank starting mask for draw mode
const BLANK_MASK = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=";

type Status = "idle" | "uploading-image" | "uploading-mask" | "running" | "done" | "error";
type MaskMode = "upload" | "draw";

export default function InpaintingTestPage() {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageSessionId, setImageSessionId] = useState<string | null>(null);
  const [maskUrl, setMaskUrl] = useState<string | null>(null);
  const [maskSessionId, setMaskSessionId] = useState<string | null>(null);
  const [maskMode, setMaskMode] = useState<MaskMode>("upload");
  const [drawnMaskBlob, setDrawnMaskBlob] = useState<Blob | null>(null);
  const [prompt, setPrompt] = useState("fix the artifact, realistic photo");
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollerRef = useRef<NodeJS.Timeout | null>(null);

  const stopPoller = () => {
    if (pollerRef.current) { clearInterval(pollerRef.current); pollerRef.current = null; }
  };

  const handleImageFile = async (file: File) => {
    setImageUrl(URL.createObjectURL(file));
    setStatus("uploading-image");
    setResultUrl(null);
    setError(null);
    setDrawnMaskBlob(null);
    const form = new FormData();
    form.append("image", file);
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const { sessionId: sid } = await res.json();
    setImageSessionId(sid);
    setStatus("idle");
  };

  const handleMaskFile = async (file: File) => {
    setMaskUrl(URL.createObjectURL(file));
    setStatus("uploading-mask");
    const form = new FormData();
    form.append("image", file);
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const { sessionId: sid } = await res.json();
    setMaskSessionId(sid);
    setStatus("idle");
  };

  const handleMaskChange = useCallback((blob: Blob) => {
    setDrawnMaskBlob(blob);
  }, []);

  const handleRun = async () => {
    if (!imageSessionId || !prompt.trim()) return;

    let activeMaskSessionId = maskSessionId;

    if (maskMode === "draw") {
      if (!drawnMaskBlob) return;
      setStatus("uploading-mask");
      const form = new FormData();
      form.append("image", drawnMaskBlob, "mask.png");
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const { sessionId: sid } = await res.json();
      activeMaskSessionId = sid;
    }

    if (!activeMaskSessionId) return;

    setStatus("running");
    setProgress(0);
    setResultUrl(null);
    setError(null);

    const invokeRes = await fetch("/api/test/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: "sd2",
        sessionId: imageSessionId,
        maskSessionId: activeMaskSessionId,
        prompt,
      }),
    });
    if (!invokeRes.ok) {
      const { error: e } = await invokeRes.json();
      setError(e);
      setStatus("error");
      return;
    }
    const { jobId, port } = await invokeRes.json();

    stopPoller();
    pollerRef.current = setInterval(async () => {
      const r = await fetch(
        `/api/test/status?port=${port}&jobId=${jobId}&sessionId=${imageSessionId}`
      );
      const data = await r.json();
      setProgress(data.progress ?? 0);
      if (data.status === "done") {
        stopPoller();
        setResultUrl(data.resultImageUrl ?? null);
        setStatus("done");
      }
      if (data.status === "error") {
        stopPoller();
        setError(data.detail ?? "Unknown error");
        setStatus("error");
      }
    }, 600);
  };

  const reset = () => {
    stopPoller();
    setImageUrl(null);
    setImageSessionId(null);
    setMaskUrl(null);
    setMaskSessionId(null);
    setDrawnMaskBlob(null);
    setResultUrl(null);
    setError(null);
    setProgress(0);
    setStatus("idle");
  };

  const busy = status === "uploading-image" || status === "uploading-mask" || status === "running";
  const canRun =
    !!imageSessionId &&
    ((maskMode === "upload" && !!maskSessionId) || (maskMode === "draw" && !!drawnMaskBlob)) &&
    !busy &&
    !!prompt.trim();

  return (
    <TestShell
      title="SD2 Inpainting"
      port={8004}
      description="Text-guided local repair: inpaint the masked region using a text prompt"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Inputs */}
        <div className="space-y-4">
          {/* Source image */}
          <div>
            <p className="mb-1.5 text-xs text-zinc-400">Source image</p>
            <Dropzone onFile={handleImageFile} disabled={busy} currentImageUrl={imageUrl} />
          </div>

          {/* Mask mode toggle */}
          <div>
            <p className="mb-1.5 text-xs text-zinc-400">Mask</p>
            <div className="mb-3 flex gap-1 rounded-lg border border-zinc-700 p-1 w-fit">
              {(["upload", "draw"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMaskMode(m)}
                  disabled={busy}
                  className={[
                    "rounded px-3 py-1 text-xs font-medium capitalize transition-colors",
                    maskMode === m
                      ? "bg-rose-600 text-white"
                      : "text-zinc-400 hover:text-zinc-200",
                  ].join(" ")}
                >
                  {m === "upload" ? "Upload mask" : "Draw mask"}
                </button>
              ))}
            </div>

            {maskMode === "upload" ? (
              <div>
                <p className="mb-1.5 text-xs text-zinc-600">White = inpaint area</p>
                <Dropzone onFile={handleMaskFile} disabled={busy} currentImageUrl={maskUrl} />
              </div>
            ) : (
              imageUrl ? (
                <MaskCanvas
                  baseImageUrl={imageUrl}
                  maskUrl={BLANK_MASK}
                  onMaskChange={handleMaskChange}
                />
              ) : (
                <div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed border-zinc-700">
                  <p className="text-xs text-zinc-600">Upload a source image first</p>
                </div>
              )
            )}
          </div>

          {/* Prompt */}
          <div>
            <label className="mb-1.5 block text-xs text-zinc-400">Inpainting prompt</label>
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={busy}
              placeholder="e.g. fix the artifact, realistic photo"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-rose-500 focus:outline-none disabled:opacity-50"
            />
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <button
              onClick={handleRun}
              disabled={!canRun}
              className="flex-1 rounded-lg bg-rose-600 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {status === "uploading-mask" ? "Uploading mask…" :
               status === "running" ? `Inpainting… ${progress}%` : "Inpaint"}
            </button>
            {(resultUrl || error) && (
              <button
                onClick={reset}
                className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
              >
                Reset
              </button>
            )}
          </div>

          {!imageSessionId && (
            <p className="text-xs text-zinc-600">Upload a source image to continue.</p>
          )}
          {imageSessionId && maskMode === "upload" && !maskSessionId && (
            <p className="text-xs text-zinc-600">Upload a mask image to continue.</p>
          )}
          {status === "running" && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-rose-500 transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
          {error && (
            <p className="rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}
        </div>

        {/* Result */}
        <div className="flex min-h-48 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900">
          {resultUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={resultUrl}
              alt="Inpainting result"
              className="max-h-96 w-full rounded-xl object-contain"
            />
          ) : (
            <p className="text-sm text-zinc-600">
              {status === "running" ? "Inpainting…" : "Result will appear here"}
            </p>
          )}
        </div>
      </div>
    </TestShell>
  );
}

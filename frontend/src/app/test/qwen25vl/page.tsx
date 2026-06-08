"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import TestShell from "@/components/TestShell";
import Dropzone from "@/components/Dropzone";

type Status = "idle" | "uploading" | "running" | "done" | "error";

interface DetectorResult {
  raw_text: string;
  has_artifacts: boolean;
  artifacts: string[];
  boxes: number[][];
}

const BOX_COLORS = ["#ff5032", "#32b5ff", "#32ff7a", "#ffb432", "#c832ff"];

export default function Qwen25VLTestPage() {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [imgAspect, setImgAspect] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<DetectorResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const stopPoller = useCallback(() => {
    if (pollerRef.current) { clearInterval(pollerRef.current); pollerRef.current = null; }
  }, []);

  // Draw image + boxes on canvas whenever imageUrl or result changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageUrl) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);

      if (result?.boxes.length) {
        result.boxes.forEach(([x1, y1, x2, y2], i) => {
          const color = BOX_COLORS[i % BOX_COLORS.length];
          const px = (x1 / 1000) * img.naturalWidth;
          const py = (y1 / 1000) * img.naturalHeight;
          const pw = ((x2 - x1) / 1000) * img.naturalWidth;
          const ph = ((y2 - y1) / 1000) * img.naturalHeight;
          const lw = Math.max(2, img.naturalWidth / 250);
          ctx.strokeStyle = color;
          ctx.lineWidth = lw;
          ctx.strokeRect(px, py, pw, ph);
          const badgeSize = Math.max(18, lw * 8);
          ctx.fillStyle = color;
          ctx.fillRect(px, py - badgeSize, badgeSize, badgeSize);
          ctx.fillStyle = "#fff";
          ctx.font = `bold ${badgeSize * 0.65}px sans-serif`;
          ctx.textBaseline = "middle";
          ctx.fillText(String(i + 1), px + badgeSize * 0.18, py - badgeSize / 2);
        });
      }
    };
    img.src = imageUrl;
  }, [imageUrl, result]);

  const handleFile = async (file: File) => {
    stopPoller();
    setResult(null);
    setError(null);
    setProgress(0);
    setStatus("uploading");
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    const img = new Image();
    img.onload = () => setImgAspect(img.naturalWidth / img.naturalHeight);
    img.src = url;

    const form = new FormData();
    form.append("image", file);
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const { sessionId: sid } = await res.json();
    setSessionId(sid);
    setStatus("idle");
  };

  const handleRun = async () => {
    if (!sessionId) return;
    stopPoller();
    setStatus("running");
    setProgress(0);
    setResult(null);
    setError(null);

    const invokeRes = await fetch("/api/test/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "qwen25vl", sessionId }),
    });
    if (!invokeRes.ok) {
      const { error: e } = await invokeRes.json();
      setError(e ?? "Invoke failed");
      setStatus("error");
      return;
    }
    const { jobId, port } = await invokeRes.json();

    pollerRef.current = setInterval(async () => {
      try {
        const r = await fetch(
          `/api/test/status?port=${port}&jobId=${jobId}&sessionId=${sessionId}`
        );
        const data = await r.json();
        setProgress(data.progress ?? 0);
        if (data.status === "done") {
          stopPoller();
          setResult(data.result as DetectorResult);
          setStatus("done");
        }
        if (data.status === "error") {
          stopPoller();
          setError(data.detail ?? "Unknown error");
          setStatus("error");
        }
      } catch {
        /* retry next tick */
      }
    }, 600);
  };

  const reset = () => {
    stopPoller();
    setImageUrl(null);
    setSessionId(null);
    setImgAspect(null);
    setResult(null);
    setError(null);
    setProgress(0);
    setStatus("idle");
    const canvas = canvasRef.current;
    if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  };

  const busy = status === "uploading" || status === "running";

  return (
    <TestShell
      title="Qwen2.5-VL Detector"
      port={8002}
      description="Qwen2.5-VL-3B detects AI-generated visual artifacts with bounding boxes"
    >
      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-2">

          {/* Left: upload + controls + raw text */}
          <div className="space-y-4">
            <Dropzone onFile={handleFile} disabled={busy} currentImageUrl={null} />

            <div className="flex gap-2">
              <button
                onClick={handleRun}
                disabled={!sessionId || busy}
                className="flex-1 rounded-lg bg-amber-600 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {status === "running" ? `Detecting… ${progress}%` : "Detect Artifacts"}
              </button>
              {(result || error) && (
                <button
                  onClick={reset}
                  className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                >
                  Reset
                </button>
              )}
            </div>

            {status === "running" && (
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-amber-500 transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            )}

            {error && (
              <p className="rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-xs text-red-400">
                {error}
              </p>
            )}

            {result && (
              <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  Model response
                </p>
                <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-zinc-300">
                  {result.raw_text || "(empty)"}
                </pre>
              </div>
            )}
          </div>

          {/* Right: canvas overlay + artifact list */}
          <div className="space-y-3">
            {imageUrl ? (
              <div
                className="overflow-hidden rounded-xl border border-zinc-700"
                style={imgAspect ? { aspectRatio: String(imgAspect) } : undefined}
              >
                <canvas
                  ref={canvasRef}
                  className="block w-full h-full"
                />
              </div>
            ) : (
              <div className="flex min-h-48 items-center justify-center rounded-xl border border-dashed border-zinc-700">
                <p className="text-sm text-zinc-600">Upload an image to see the overlay</p>
              </div>
            )}

            {result ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-2">
                <span
                  className={[
                    "rounded-full px-2.5 py-0.5 text-xs font-medium",
                    result.has_artifacts
                      ? "bg-red-900/60 text-red-300"
                      : "bg-emerald-900/60 text-emerald-300",
                  ].join(" ")}
                >
                  {result.has_artifacts
                    ? `${result.artifacts.length} artifact(s) detected`
                    : "No artifacts"}
                </span>
                {result.artifacts.length > 0 && (
                  <ul className="mt-2 space-y-1.5">
                    {result.artifacts.map((a, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
                        <span
                          className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-black"
                          style={{ backgroundColor: BOX_COLORS[i % BOX_COLORS.length] }}
                        >
                          {i + 1}
                        </span>
                        {a}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <div className="flex min-h-16 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900">
                <p className="text-sm text-zinc-600">
                  {status === "running" ? "Detecting…" : "Results will appear here"}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </TestShell>
  );
}

"use client";

import { useState, useRef } from "react";
import TestShell from "@/components/TestShell";
import Dropzone from "@/components/Dropzone";

type Status = "idle" | "uploading" | "running" | "done" | "error";

export default function PAL4VSTTestPage() {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(0.5);
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
  const [maskUrl, setMaskUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollerRef = useRef<NodeJS.Timeout | null>(null);

  const stopPoller = () => {
    if (pollerRef.current) { clearInterval(pollerRef.current); pollerRef.current = null; }
  };

  const handleFile = async (file: File) => {
    setImageUrl(URL.createObjectURL(file));
    setStatus("uploading");
    setMaskUrl(null);
    setError(null);
    const form = new FormData();
    form.append("image", file);
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const { sessionId: sid } = await res.json();
    setSessionId(sid);
    setStatus("idle");
  };

  const handleRun = async () => {
    if (!sessionId) return;
    setStatus("running");
    setProgress(0);
    setMaskUrl(null);
    setError(null);

    const invokeRes = await fetch("/api/test/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        service: "pal4vst", 
        sessionId, 
        payload: { threshold } 
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
      const r = await fetch(`/api/test/status?port=${port}&jobId=${jobId}&sessionId=${sessionId}`);
      const data = await r.json();
      setProgress(data.progress ?? 0);
      
      if (data.status === "done") {
        stopPoller();
        
        setMaskUrl(data.resultImageUrl ?? null); 
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
    setSessionId(null);
    setMaskUrl(null);
    setError(null);
    setProgress(0);
    setStatus("idle");
  };

  const busy = status === "uploading" || status === "running";

  return (
    <TestShell
      title="PAL4VST"
      port={8006}
      description="Directly predicts Perceptual Artifacts Localization heatmap and binarizes it to a mask"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Inputs */}
        <div className="space-y-4">
          <Dropzone onFile={handleFile} disabled={busy} currentImageUrl={imageUrl} />
          
          <div>
            <label className="mb-1.5 flex justify-between text-xs text-zinc-400">
              <span>Binarization Threshold</span>
              <span className="text-zinc-500">{threshold.toFixed(2)}</span>
            </label>
            <input
              type="range"
              min="0.1"
              max="0.9"
              step="0.05"
              value={threshold}
              onChange={(e) => setThreshold(parseFloat(e.target.value))}
              disabled={busy}
              className="w-full accent-cyan-500"
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleRun}
              disabled={!sessionId || busy}
              className="flex-1 rounded-lg bg-cyan-600 py-2 text-sm font-medium text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {status === "running" ? `Generating Mask… ${progress}%` : "Generate Mask"}
            </button>
            {(maskUrl || error) && (
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
                className="h-full rounded-full bg-cyan-500 transition-all"
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
          {maskUrl ? (
            <div className="w-full space-y-2 p-2">
              <p className="px-2 text-xs text-zinc-500">Predicted PAL Mask</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={maskUrl}
                alt="Mask"
                className="max-h-80 w-full rounded-lg object-contain"
                
                style={{ filter: "brightness(1.5) sepia(1) hue-rotate(180deg) saturate(200%)" }}
              />
            </div>
          ) : (
            <p className="text-sm text-zinc-600">
              {status === "running" ? "Model is predicting heatmap…" : "Mask will appear here"}
            </p>
          )}
        </div>
      </div>
    </TestShell>
  );
}
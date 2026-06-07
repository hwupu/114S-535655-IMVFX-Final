"use client";

import { useState, useRef } from "react";
import TestShell from "@/components/TestShell";
import Dropzone from "@/components/Dropzone";

type Status = "idle" | "uploading" | "running" | "done" | "error";

interface DetectorResult {
  has_artifacts: boolean;
  artifacts: string[];
}

export default function ArtifactDetectorTestPage() {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<DetectorResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollerRef = useRef<NodeJS.Timeout | null>(null);

  const stopPoller = () => {
    if (pollerRef.current) { clearInterval(pollerRef.current); pollerRef.current = null; }
  };

  const handleFile = async (file: File) => {
    setImageUrl(URL.createObjectURL(file));
    setStatus("uploading");
    setResult(null);
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
    setResult(null);
    setError(null);

    const invokeRes = await fetch("/api/test/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "artifact_detector", sessionId }),
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
        setResult(data.result as DetectorResult);
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
    setResult(null);
    setError(null);
    setProgress(0);
    setStatus("idle");
  };

  const busy = status === "uploading" || status === "running";

  return (
    <TestShell
      title="Artifact Detector"
      port={8002}
      description="Qwen2-VL-2B detects AI-generated visual artifacts in an image"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Inputs */}
        <div className="space-y-4">
          <Dropzone onFile={handleFile} disabled={busy} currentImageUrl={imageUrl} />
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
        </div>

        {/* Result */}
        <div className="flex min-h-48 flex-col justify-center rounded-xl border border-zinc-800 bg-zinc-900 p-5">
          {result ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span
                  className={[
                    "rounded-full px-2.5 py-0.5 text-xs font-medium",
                    result.has_artifacts
                      ? "bg-red-900/60 text-red-300"
                      : "bg-emerald-900/60 text-emerald-300",
                  ].join(" ")}
                >
                  {result.has_artifacts ? "Artifacts detected" : "No artifacts"}
                </span>
              </div>
              {result.has_artifacts && result.artifacts.length > 0 && (
                <ul className="space-y-1.5">
                  {result.artifacts.map((a, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                      {a}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="text-center text-sm text-zinc-600">
              {status === "running" ? "Analyzing image…" : "Detection results will appear here"}
            </p>
          )}
        </div>
      </div>
    </TestShell>
  );
}

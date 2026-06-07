"use client";

import { useState, useRef } from "react";
import TestShell from "@/components/TestShell";
import Dropzone from "@/components/Dropzone";

type Status = "idle" | "uploading" | "running" | "done" | "error";

export default function InstructPix2PixTestPage() {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("Make it look like a painting");
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollerRef = useRef<NodeJS.Timeout | null>(null);

  const stopPoller = () => {
    if (pollerRef.current) { clearInterval(pollerRef.current); pollerRef.current = null; }
  };

  const handleFile = async (file: File) => {
    setImageUrl(URL.createObjectURL(file));
    setStatus("uploading");
    setResultUrl(null);
    setError(null);
    const form = new FormData();
    form.append("image", file);
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const { sessionId: sid } = await res.json();
    setSessionId(sid);
    setStatus("idle");
  };

  const handleRun = async () => {
    if (!sessionId || !prompt.trim()) return;
    setStatus("running");
    setProgress(0);
    setResultUrl(null);
    setError(null);

    const invokeRes = await fetch("/api/test/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "instructpix2pix", sessionId, prompt }),
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
    setSessionId(null);
    setResultUrl(null);
    setError(null);
    setProgress(0);
    setStatus("idle");
  };

  const busy = status === "uploading" || status === "running";

  return (
    <TestShell
      title="InstructPix2Pix"
      port={8001}
      description="Apply a text-guided global style edit to any image"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Inputs */}
        <div className="space-y-4">
          <Dropzone
            onFile={handleFile}
            disabled={busy}
            currentImageUrl={imageUrl}
          />
          <div>
            <label className="mb-1.5 block text-xs text-zinc-400">Prompt</label>
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={busy}
              placeholder="e.g. Make it look like a painting"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleRun}
              disabled={!sessionId || busy || !prompt.trim()}
              className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {status === "running" ? `Running… ${progress}%` : "Run"}
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
          {status === "running" && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-indigo-500 transition-all"
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
            <img src={resultUrl} alt="Result" className="max-h-96 w-full rounded-xl object-contain" />
          ) : (
            <p className="text-sm text-zinc-600">
              {status === "running" ? "Generating…" : "Result will appear here"}
            </p>
          )}
        </div>
      </div>
    </TestShell>
  );
}

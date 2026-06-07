"use client";

import { useState, useRef } from "react";
import TestShell from "@/components/TestShell";
import Dropzone from "@/components/Dropzone";

type Status = "idle" | "uploading" | "running" | "done" | "error";

const DEFAULT_PROMPT = "<image>Does the image looks real/fake?";

export default function FakeVLMTestPage() {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<string | null>(null);
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
      body: JSON.stringify({ service: "fakevlm", sessionId, prompt }),
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
        setResult(typeof data.result === "string" ? data.result : JSON.stringify(data.result));
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
      title="FakeVLM"
      port={8005}
      description="LLaVA-based model that classifies whether an image looks real or AI-generated"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Inputs */}
        <div className="space-y-4">
          <Dropzone onFile={handleFile} disabled={busy} currentImageUrl={imageUrl} />
          <div>
            <label className="mb-1.5 block text-xs text-zinc-400">
              Prompt{" "}
              <span className="text-zinc-600">(LLaVA format — keep &lt;image&gt; token)</span>
            </label>
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={busy}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-300 placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none disabled:opacity-50"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleRun}
              disabled={!sessionId || busy}
              className="flex-1 rounded-lg bg-violet-600 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {status === "running" ? `Analyzing… ${progress}%` : "Analyze"}
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
                className="h-full rounded-full bg-violet-500 transition-all"
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
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
                Model response
              </p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">{result}</p>
            </div>
          ) : (
            <p className="text-center text-sm text-zinc-600">
              {status === "running" ? "Model is thinking…" : "Response will appear here"}
            </p>
          )}
        </div>
      </div>
    </TestShell>
  );
}

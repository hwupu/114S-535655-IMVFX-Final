"use client";

import { useState, useRef, useCallback } from "react";
import { PipelineState, SSEMessage } from "@/lib/types";
import Dropzone from "@/components/Dropzone";
import PromptPanel from "@/components/PromptPanel";
import PipelineStatus from "@/components/PipelineStatus";
import MaskCanvas from "@/components/MaskCanvas";
import ResultPanel from "@/components/ResultPanel";

const INITIAL: PipelineState = {
  stage: "idle",
  sessionId: null,
  prompt: "",
  originalImageUrl: null,
  stage1OutputUrl: null,
  artifacts: [],
  maskUrl: null,
  resultUrl: null,
  progress: 0,
  stageProgress: {},
  error: null,
};

function imageApiUrl(sessionRelPath: string) {
  const [sessionId, filename] = sessionRelPath.split("/");
  return `/api/images/${sessionId}/${filename}`;
}

export default function Home() {
  const [state, setState] = useState<PipelineState>(INITIAL);
  const [pendingMaskBlob, setPendingMaskBlob] = useState<Blob | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader | null>(null);

  function patch(p: Partial<PipelineState>) {
    setState((s) => ({ ...s, ...p }));
  }

  // ── File upload ───────────────────────────────────────────────────────────
  async function handleFile(file: File) {
    patch({ stage: "uploading", originalImageUrl: URL.createObjectURL(file) });
    const form = new FormData();
    form.append("image", file);
    const res = await fetch("/api/upload", { method: "POST", body: form });
    if (!res.ok) { patch({ stage: "error", error: "Upload failed" }); return; }
    const { sessionId } = await res.json();
    patch({ sessionId, stage: "idle" });
  }

  // ── SSE stream helper ─────────────────────────────────────────────────────
  function openSSE(sessionId: string, prompt: string, fromStage: number, artifacts?: string[]) {
    readerRef.current?.cancel();

    fetch("/api/pipeline/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, prompt, fromStage, artifacts }),
    }).then(async (res) => {
      if (!res.body) return;
      const reader = res.body.getReader();
      readerRef.current = reader;
      const dec = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.startsWith("data: ")) continue;
          try {
            handleMsg(JSON.parse(part.slice(6)));
          } catch { /* skip malformed */ }
        }
      }
    });
  }

  function handleMsg(msg: SSEMessage) {
    setState((prev) => {
      const next = { ...prev };

      if (typeof msg.stage === "number") {
        next.stage = `stage${msg.stage}` as PipelineState["stage"];
        next.stageProgress = {
          ...prev.stageProgress,
          [msg.stage]: msg.progress ?? prev.stageProgress[msg.stage] ?? 0,
        };
        if (msg.status === "done") {
          if (msg.stage === 1 && msg.resultPath) next.stage1OutputUrl = imageApiUrl(msg.resultPath);
          if (msg.stage === 2 && msg.artifacts)  next.artifacts = msg.artifacts;
          if (msg.stage === 3 && msg.maskPath)   next.maskUrl = imageApiUrl(msg.maskPath);
          if (msg.stage === 4 && msg.resultPath) next.resultUrl = imageApiUrl(msg.resultPath);
        }
      }

      if (msg.stage === "mask_review") {
        next.stage = "mask_review";
        if (msg.maskPath) next.maskUrl = imageApiUrl(msg.maskPath);
      }
      if (msg.stage === "no_artifacts") next.stage = "no_artifacts";
      if (msg.stage === "done") {
        next.stage = "done";
        next.stageProgress = { 1: 100, 2: 100, 3: 100, 4: 100 };
      }
      if (msg.stage === "aborted") next.stage = "aborted";
      if (msg.stage === "error" || msg.status === "error") {
        next.stage = "error";
        next.error = msg.error ?? "Unknown error";
      }

      return next;
    });
  }

  // ── Abort ─────────────────────────────────────────────────────────────────
  async function handleAbort() {
    readerRef.current?.cancel();
    if (!state.sessionId) return;
    await fetch("/api/pipeline/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
    setState((prev) => {
      const revert: PipelineState["stage"] =
        prev.stage === "stage1" ? "idle" :
        prev.stage === "stage2" ? "stage1" :
        prev.stage === "stage3" ? "stage2" :
        prev.stage === "stage4" ? "mask_review" : "idle";
      return { ...prev, stage: revert, error: null };
    });
  }

  // ── Continue after mask review ────────────────────────────────────────────
  async function handleContinue() {
    if (!state.sessionId) return;
    if (pendingMaskBlob) {
      const form = new FormData();
      form.append("image", pendingMaskBlob, "stage3_mask.png");
      form.append("sessionId", state.sessionId);
      await fetch("/api/upload/mask", { method: "POST", body: form });
    }
    openSSE(state.sessionId, state.prompt, 4, state.artifacts);
  }

  // ── Reset ─────────────────────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    readerRef.current?.cancel();
    setState(INITIAL);
    setPendingMaskBlob(null);
  }, []);

  const isRunning = ["uploading", "stage1", "stage2", "stage3", "stage4"].includes(state.stage);
  const canStart = !isRunning && state.sessionId && state.prompt && state.stage !== "mask_review";

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <div className="mx-auto max-w-5xl space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">AI Artifact Repair Pipeline</h1>
            <p className="text-xs text-zinc-500 mt-0.5">InstructPix2Pix → Detection → Mask → Inpainting</p>
          </div>
          <button
            onClick={handleReset}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors"
          >
            Reset
          </button>
        </div>

        {/* Main grid */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Left — input */}
          <div className="space-y-4">
            <Dropzone
              onFile={handleFile}
              disabled={isRunning || state.stage === "mask_review"}
              currentImageUrl={state.originalImageUrl}
            />
            <PromptPanel
              value={state.prompt}
              onChange={(v) => patch({ prompt: v })}
              disabled={isRunning || state.stage === "mask_review"}
            />
            <div className="flex gap-3">
              {state.stage !== "mask_review" && (
                <button
                  onClick={() => state.sessionId && openSSE(state.sessionId, state.prompt, 1)}
                  disabled={!canStart}
                  className="flex-1 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {isRunning ? "Running…" : "Start"}
                </button>
              )}
              {isRunning && (
                <button
                  onClick={handleAbort}
                  className="rounded-lg border border-red-700 px-4 py-2.5 text-sm font-medium text-red-400 hover:bg-red-950 transition-colors"
                >
                  Abort
                </button>
              )}
            </div>
            {state.error && (
              <p className="rounded-lg bg-red-950/40 border border-red-800/50 p-3 text-xs text-red-300">
                {state.error}
              </p>
            )}
          </div>

          {/* Right — status + results */}
          <div className="space-y-4">
            <PipelineStatus stage={state.stage} stageProgress={state.stageProgress} artifacts={state.artifacts} />
            <ResultPanel
              originalUrl={state.originalImageUrl}
              maskUrl={state.maskUrl}
              resultUrl={state.resultUrl}
              stage1Url={state.stage1OutputUrl}
            />
          </div>
        </div>

        {/* Mask editor (full-width, shown during mask_review) */}
        {(state.stage === "mask_review") && state.stage1OutputUrl && state.maskUrl && (
          <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Mask Editor</h3>
              <div className="flex gap-3">
                <button
                  onClick={handleAbort}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-zinc-500"
                >
                  Back
                </button>
                <button
                  onClick={handleContinue}
                  className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
                >
                  Continue to Inpainting →
                </button>
              </div>
            </div>
            <MaskCanvas
              baseImageUrl={state.stage1OutputUrl}
              maskUrl={state.maskUrl}
              onMaskChange={setPendingMaskBlob}
            />
          </div>
        )}
      </div>
    </main>
  );
}

"use client";

import { useState, useRef, useCallback } from "react";
import Link from "next/link";
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

// ── Per-stage debug card ──────────────────────────────────────────────────────

type CardStatus = "waiting" | "running" | "done" | "error";

function StageCard({
  num,
  label,
  status,
  progress,
  children,
}: {
  num: number;
  label: string;
  status: CardStatus;
  progress?: number;
  children: React.ReactNode;
}) {
  const badge: Record<CardStatus, string> = {
    waiting: "text-zinc-600 bg-zinc-800",
    running: "text-amber-400 bg-amber-950",
    done:    "text-emerald-400 bg-emerald-950",
    error:   "text-red-400 bg-red-950",
  };
  const badgeText: Record<CardStatus, string> = {
    waiting: "waiting",
    running: progress != null ? `${progress}%` : "running",
    done:    "done",
    error:   "error",
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
      {/* Horizontal layout: label column + output column */}
      <div className="flex items-stretch gap-0">
        {/* Left: stage label */}
        <div className="flex flex-col justify-center gap-1 px-4 py-3 border-r border-zinc-800 min-w-36">
          <p className="text-[10px] text-zinc-600 font-medium uppercase tracking-wider">Stage {num}</p>
          <p className="text-sm font-semibold text-zinc-200">{label}</p>
          <span className={`mt-1 self-start rounded-full px-2 py-0.5 text-[10px] font-medium ${badge[status]}`}>
            {badgeText[status]}
          </span>
        </div>
        {/* Right: output */}
        <div className="flex flex-1 items-center justify-start p-3 min-h-28">
          {children}
        </div>
      </div>
      {/* Running progress bar */}
      {status === "running" && progress != null && (
        <div className="h-0.5 w-full bg-zinc-800">
          <div className="h-full bg-amber-500 transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}
    </div>
  );
}

function ImgOutput({ url, alt }: { url: string; alt: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt={alt} className="max-h-28 max-w-full object-contain rounded" />
  );
}

function Placeholder({ text }: { text?: string }) {
  return <p className="text-xs text-zinc-700">{text ?? "—"}</p>;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PipelinePage() {
  const [state, setState] = useState<PipelineState>(INITIAL);
  const [pendingMaskBlob, setPendingMaskBlob] = useState<Blob | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader | null>(null);

  function patch(p: Partial<PipelineState>) {
    setState((s) => ({ ...s, ...p }));
  }

  // ── File upload ─────────────────────────────────────────────────────────────
  async function handleFile(file: File) {
    patch({ stage: "uploading", originalImageUrl: URL.createObjectURL(file) });
    const form = new FormData();
    form.append("image", file);
    const res = await fetch("/api/upload", { method: "POST", body: form });
    if (!res.ok) { patch({ stage: "error", error: "Upload failed" }); return; }
    const { sessionId } = await res.json();
    patch({ sessionId, stage: "idle" });
  }

  // ── SSE stream helper ───────────────────────────────────────────────────────
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
          try { handleMsg(JSON.parse(part.slice(6))); }
          catch { /* skip malformed */ }
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

  // ── Abort ───────────────────────────────────────────────────────────────────
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

  // ── Continue after mask review ──────────────────────────────────────────────
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

  // ── Reset ───────────────────────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    readerRef.current?.cancel();
    setState(INITIAL);
    setPendingMaskBlob(null);
  }, []);

  // ── Derived stage card statuses ─────────────────────────────────────────────
  const s = state.stage;
  const sp = state.stageProgress;

  const pastStage = (n: number) =>
    ["stage" + (n + 1), "stage" + (n + 2), "stage" + (n + 3),
     "mask_review", "no_artifacts", "done"].includes(s);

  const stageStatus = (n: number): CardStatus => {
    if (s === `stage${n}`) return "running";
    if (s === "error" && !pastStage(n) && sp[n] != null && sp[n]! > 0) return "error";
    switch (n) {
      case 1: return state.stage1OutputUrl ? "done" : "waiting";
      case 2: return (state.artifacts.length > 0 || s === "no_artifacts" || pastStage(2)) ? "done" : "waiting";
      case 3: return state.maskUrl ? "done" : "waiting";
      case 4: return state.resultUrl ? "done" : "waiting";
      default: return "waiting";
    }
  };

  const isRunning = ["uploading", "stage1", "stage2", "stage3", "stage4"].includes(s);
  const canStart  = !isRunning && state.sessionId && state.prompt && s !== "mask_review";
  const showStageOutputs = !!state.originalImageUrl;

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <div className="mx-auto max-w-5xl space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">AI Artifact Repair Pipeline</h1>
            <p className="text-xs text-zinc-500 mt-0.5">InstructPix2Pix → Detection → Mask → Inpainting</p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/"
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors"
            >
              ← Home
            </Link>
            <button
              onClick={handleReset}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors"
            >
              Reset
            </button>
          </div>
        </div>

        {/* Main grid */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Left — input */}
          <div className="space-y-4">
            <Dropzone
              onFile={handleFile}
              disabled={isRunning || s === "mask_review"}
              currentImageUrl={state.originalImageUrl}
            />
            <PromptPanel
              value={state.prompt}
              onChange={(v) => patch({ prompt: v })}
              disabled={isRunning || s === "mask_review"}
            />
            <div className="flex gap-3">
              {s !== "mask_review" && (
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
            <PipelineStatus stage={s} stageProgress={sp} artifacts={state.artifacts} />
            <ResultPanel
              originalUrl={state.originalImageUrl}
              maskUrl={state.maskUrl}
              resultUrl={state.resultUrl}
              stage1Url={state.stage1OutputUrl}
            />
          </div>
        </div>

        {/* Mask editor (full-width, shown during mask_review) */}
        {s === "mask_review" && state.stage1OutputUrl && state.maskUrl && (
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

        {/* ── Per-stage debug outputs ── */}
        {showStageOutputs && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-zinc-400">Stage Outputs</h3>
            <div className="flex flex-col gap-3">

              {/* Stage 1 — InstructPix2Pix */}
              <StageCard
                num={1} label="Style Edit"
                status={stageStatus(1)} progress={sp[1]}
              >
                {state.stage1OutputUrl
                  ? <ImgOutput url={state.stage1OutputUrl} alt="Stage 1 output" />
                  : <Placeholder text={s === "stage1" ? "Processing…" : "Not yet run"} />}
              </StageCard>

              {/* Stage 2 — FakeVLM artifact detection */}
              <StageCard
                num={2} label="Detection"
                status={stageStatus(2)} progress={sp[2]}
              >
                {s === "stage2" ? (
                  <Placeholder text="Analyzing image…" />
                ) : s === "no_artifacts" ? (
                  <p className="text-xs text-emerald-400 text-center px-2">
                    ✓ No artifacts detected<br />
                    <span className="text-zinc-500">Pipeline ended early</span>
                  </p>
                ) : state.artifacts.length > 0 ? (
                  <ul className="w-full space-y-1 px-1">
                    {state.artifacts.map((a, i) => (
                      <li key={i} className="text-[11px] text-zinc-300 bg-zinc-800 rounded px-2 py-1 leading-snug">
                        {a}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Placeholder text="Not yet run" />
                )}
              </StageCard>

              {/* Stage 3 — Grounded-SAM mask */}
              <StageCard
                num={3} label="Mask"
                status={stageStatus(3)} progress={sp[3]}
              >
                {state.maskUrl
                  ? <ImgOutput url={state.maskUrl} alt="Stage 3 mask" />
                  : <Placeholder text={s === "stage3" ? "Generating mask…" : "Not yet run"} />}
              </StageCard>

              {/* Stage 4 — SD Inpainting */}
              <StageCard
                num={4} label="Inpainting"
                status={stageStatus(4)} progress={sp[4]}
              >
                {state.resultUrl
                  ? <ImgOutput url={state.resultUrl} alt="Stage 4 result" />
                  : <Placeholder text={s === "stage4" ? "Inpainting…" : "Not yet run"} />}
              </StageCard>

            </div>
          </div>
        )}

      </div>
    </main>
  );
}

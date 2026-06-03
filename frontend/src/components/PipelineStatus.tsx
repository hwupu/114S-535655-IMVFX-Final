"use client";

import { PipelineStage, STAGE_LABELS } from "@/lib/types";

interface Props {
  stage: PipelineStage;
  stageProgress: Record<number, number>;
  artifacts: string[];
}

const STAGES = [1, 2, 3, 4] as const;

function stageState(stageNum: number, current: PipelineStage): "done" | "active" | "pending" | "skipped" {
  const runningMap: Partial<Record<PipelineStage, number>> = {
    stage1: 1, stage2: 2, stage3: 3, stage4: 4,
  };
  const doneAfter: Record<number, PipelineStage[]> = {
    1: ["stage2", "stage3", "mask_review", "stage4", "done", "no_artifacts"],
    2: ["stage3", "mask_review", "stage4", "done", "no_artifacts"],
    3: ["mask_review", "stage4", "done"],
    4: ["done"],
  };

  if (current === "no_artifacts" && stageNum >= 3) return "skipped";
  if (doneAfter[stageNum]?.includes(current)) return "done";
  if (runningMap[current] === stageNum) return "active";
  return "pending";
}

export default function PipelineStatus({ stage, stageProgress, artifacts }: Props) {
  if (stage === "idle" || stage === "uploading") return null;

  return (
    <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-4 space-y-4">
      <div className="flex items-center gap-2 justify-between">
        {STAGES.map((n, i) => {
          const state = stageState(n, stage);
          return (
            <div key={n} className="flex items-center gap-2 flex-1">
              <div className="flex flex-col items-center gap-1 flex-1">
                <div className={[
                  "flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold transition-colors",
                  state === "done" ? "bg-green-600 text-white" :
                  state === "active" ? "bg-indigo-600 text-white animate-pulse" :
                  state === "skipped" ? "bg-zinc-700 text-zinc-500" :
                  "bg-zinc-700 text-zinc-400",
                ].join(" ")}>
                  {state === "done" ? "✓" : state === "skipped" ? "—" : n}
                </div>
                <span className={[
                  "text-center text-xs leading-tight",
                  state === "active" ? "text-indigo-400" :
                  state === "done" ? "text-green-400" :
                  state === "skipped" ? "text-zinc-600" : "text-zinc-500",
                ].join(" ")}>
                  {STAGE_LABELS[n]}
                </span>
                {state === "active" && (
                  <div className="w-full h-1 rounded bg-zinc-700">
                    <div
                      className="h-1 rounded bg-indigo-500 transition-all duration-300"
                      style={{ width: `${stageProgress[n] ?? 0}%` }}
                    />
                  </div>
                )}
              </div>
              {i < STAGES.length - 1 && (
                <div className={[
                  "h-px w-4 shrink-0 mb-6",
                  state === "done" ? "bg-green-600" : "bg-zinc-700",
                ].join(" ")} />
              )}
            </div>
          );
        })}
      </div>

      {artifacts.length > 0 && (
        <div className="rounded-lg bg-amber-950/40 border border-amber-800/50 p-3">
          <p className="text-xs font-semibold text-amber-400 mb-1">Detected artifacts</p>
          <ul className="space-y-0.5">
            {artifacts.map((a, i) => (
              <li key={i} className="text-xs text-amber-200">• {a}</li>
            ))}
          </ul>
        </div>
      )}

      {stage === "no_artifacts" && (
        <p className="text-sm text-green-400 text-center">
          No artifacts detected — your image looks clean!
        </p>
      )}
      {stage === "done" && (
        <p className="text-sm text-green-400 text-center font-medium">
          Pipeline complete
        </p>
      )}
    </div>
  );
}

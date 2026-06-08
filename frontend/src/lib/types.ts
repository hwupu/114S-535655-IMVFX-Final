export type PipelineStage =
  | "idle"
  | "uploading"
  | "stage1"       // InstructPix2Pix
  | "stage2"       // Artifact detection
  | "stage3"       // Grounded-SAM mask generation
  | "mask_review"  // Paused; user may edit mask
  | "stage4"       // SD Inpainting
  | "no_artifacts" // Complete — no artifacts found
  | "done"
  | "error"
  | "aborted";

export interface PipelineState {
  stage: PipelineStage;
  sessionId: string | null;
  prompt: string;
  originalImageUrl: string | null;   // uploaded file, object URL
  stage1OutputUrl: string | null;    // /api/images/:session/stage1_output.png
  artifacts: string[];               // VLM descriptions (parsed)
  stage2RawText: string | null;      // raw model response, for debugging
  maskUrl: string | null;            // /api/images/:session/stage3_mask.png
  resultUrl: string | null;          // /api/images/:session/stage4_result.png
  progress: number;                  // 0-100 for the current running stage
  stageProgress: Record<number, number>; // per-stage progress 1-4
  error: string | null;
}

export interface SSEMessage {
  stage: number | "done" | "no_artifacts" | "mask_review" | "aborted" | "error";
  status: "running" | "done" | "waiting" | "aborted" | "error";
  progress?: number;
  artifacts?: string[];
  rawText?: string;      // stage 2: unprocessed model response
  resultPath?: string;  // session-relative: "{sessionId}/filename"
  maskPath?: string;
  error?: string;
}

export const STAGE_LABELS: Record<number, string> = {
  1: "Global Style Edit",
  2: "Artifact Detection",
  3: "Mask Generation",
  4: "Inpainting",
};

export const PROMPT_SUGGESTIONS = [
  "Make it look like a painting",
  "Apply cinematic color grading",
  "Make it look like a vintage photograph",
  "Convert to watercolor style",
  "Apply a dreamy, soft-focus effect",
];

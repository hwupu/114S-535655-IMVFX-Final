import { NextRequest } from "next/server";
import path from "path";
import { submitJob, pollJob, abortJob } from "@/lib/serviceClient";
import { abortFlags, activeJobs, sessionArtifacts } from "@/lib/pipelineState";
import { WORKSPACE } from "@/lib/paths";

interface StartRequest {
  sessionId: string;
  prompt: string;
  fromStage?: number;          // 1 (default) or 4 (resume after mask review)
  artifacts?: string[];        // required when fromStage=4
}

type Service = Parameters<typeof submitJob>[0];

export async function POST(req: NextRequest) {
  const body: StartRequest = await req.json();
  const { sessionId, prompt, fromStage = 1, artifacts: providedArtifacts } = body;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

      const isAborted = () => abortFlags.get(sessionId) === true;

      async function runStage(
        stageNum: number,
        service: Service,
        requestBody: object,
      ): Promise<{ ok: boolean; status: import("@/lib/serviceClient").JobStatus | null }> {
        send({ stage: stageNum, status: "running", progress: 0 });
        let jobId: string;
        try {
          jobId = await submitJob(service, requestBody);
        } catch (err: unknown) {
          send({ stage: stageNum, status: "error", error: String(err) });
          return { ok: false, status: null };
        }
        activeJobs.set(sessionId, { service, jobId });

        while (true) {
          if (isAborted()) {
            await abortJob(service, jobId).catch(() => {});
            activeJobs.delete(sessionId);
            send({ stage: stageNum, status: "aborted" });
            return { ok: false, status: null };
          }

          let s: import("@/lib/serviceClient").JobStatus;
          try {
            s = await pollJob(service, jobId);
          } catch {
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }

          send({ stage: stageNum, status: s.status === "done" ? "running" : s.status, progress: s.progress });

          if (s.status === "done") {
            activeJobs.delete(sessionId);
            return { ok: true, status: s };
          }
          if (s.status === "error") {
            send({ stage: stageNum, status: "error", error: s.detail });
            return { ok: false, status: s };
          }

          await new Promise((r) => setTimeout(r, 500));
        }
      }

      try {
        abortFlags.delete(sessionId);
        const sessionDir = path.join(WORKSPACE, sessionId);

        // Stage 1 — InstructPix2Pix
        if (fromStage <= 1) {
          const { ok, status } = await runStage(1, "instructpix2pix", {
            image_path: path.join(sessionDir, "original.png"),
            prompt,
            session_id: sessionId,
          });
          if (!ok) { controller.close(); return; }
          send({ stage: 1, status: "done", progress: 100, resultPath: `${sessionId}/stage1_output.png` });
        }

        // Stage 2 — Artifact Detection (FakeVLM)
        if (fromStage <= 2) {
          const { ok, status } = await runStage(2, "fakevlm", {
            image_path: path.join(sessionDir, "stage1_output.png"),
            prompt:
              "<image>List any visual artifacts in this image, such as extra fingers, " +
              "deformed faces, unnatural textures, or asymmetric features. " +
              "If the image looks correct and realistic, reply with exactly: NO_ARTIFACTS",
            session_id: sessionId,
          });
          if (!ok) { controller.close(); return; }

          const rawText = (status!.result as string | null) ?? "";
          const hasArtifacts = !/NO_ARTIFACTS/i.test(rawText) && rawText.trim().length > 0;
          const detected = hasArtifacts
            ? rawText.split(/[.\n]+/).map((s) => s.trim()).filter((s) => s.length > 4)
            : [];

          sessionArtifacts.set(sessionId, detected);
          send({ stage: 2, status: "done", progress: 100, artifacts: detected, rawText });

          if (!hasArtifacts) {
            send({ stage: "no_artifacts", status: "done" });
            controller.close();
            return;
          }
        }

        // Stage 3 — Grounded-SAM
        if (fromStage <= 3) {
          const artifacts = sessionArtifacts.get(sessionId) ?? [];
          const { ok } = await runStage(3, "grounded_sam", {
            image_path: path.join(sessionDir, "stage1_output.png"),
            artifact_descriptions: artifacts,
            session_id: sessionId,
          });
          if (!ok) { controller.close(); return; }
          send({ stage: 3, status: "done", progress: 100, maskPath: `${sessionId}/stage3_mask.png` });
          // Pause: tell the client to show the mask editor
          send({ stage: "mask_review", status: "waiting", maskPath: `${sessionId}/stage3_mask.png` });
          controller.close();
          return;
        }

        // Stage 4 — SD Inpainting (fromStage=4, after mask review)
        if (fromStage <= 4) {
          const artifacts = providedArtifacts ?? sessionArtifacts.get(sessionId) ?? [];
          const inpaintPrompt = artifacts.length
            ? `Naturally repair the following defects in the image: ${artifacts.join(", ")}`
            : "Naturally repair any visual defects in the marked region";

          const { ok } = await runStage(4, "sd2", {
            image_path: path.join(sessionDir, "stage1_output.png"),
            mask_path: path.join(sessionDir, "stage3_mask.png"),
            prompt: inpaintPrompt,
            session_id: sessionId,
          });
          if (!ok) { controller.close(); return; }
          send({ stage: 4, status: "done", progress: 100, resultPath: `${sessionId}/stage4_result.png` });
          send({ stage: "done", status: "done" });
          controller.close();
        }
      } catch (err: unknown) {
        send({ stage: "error", status: "error", error: String(err) });
        controller.close();
      } finally {
        abortFlags.delete(sessionId);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

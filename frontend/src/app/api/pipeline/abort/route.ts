import { NextRequest, NextResponse } from "next/server";
import { abortFlags, activeJobs } from "@/lib/pipelineState";
import { abortJob } from "@/lib/serviceClient";

export async function POST(req: NextRequest) {
  const { sessionId } = await req.json();
  if (!sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });

  abortFlags.set(sessionId, true);

  const active = activeJobs.get(sessionId);
  if (active) {
    await abortJob(active.service as Parameters<typeof abortJob>[0], active.jobId).catch(() => {});
    activeJobs.delete(sessionId);
  }

  return NextResponse.json({ ok: true });
}

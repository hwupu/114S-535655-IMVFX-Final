import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { WORKSPACE } from "@/lib/paths";

const SERVICE_PORTS: Record<string, number> = {
  instructpix2pix: 8001,
  artifact_detector: 8002,
  grounded_sam: 8003,
  inpainting: 8004,
  fakevlm: 8005,
};

export async function POST(req: NextRequest) {
  const { service, sessionId, maskSessionId, prompt, artifactDescriptions } =
    await req.json();

  const port = SERVICE_PORTS[service];
  if (!port) {
    return NextResponse.json({ error: `Unknown service: ${service}` }, { status: 400 });
  }
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const imagePath = path.join(WORKSPACE, sessionId, "original.png");

  const body: Record<string, unknown> = {
    image_path: imagePath,
    session_id: sessionId,
  };

  if (prompt !== undefined) body.prompt = prompt;
  if (Array.isArray(artifactDescriptions)) body.artifact_descriptions = artifactDescriptions;
  if (maskSessionId) {
    body.mask_path = path.join(WORKSPACE, maskSessionId, "original.png");
  }

  let serviceRes: Response;
  try {
    serviceRes = await fetch(`http://127.0.0.1:${port}/infer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return NextResponse.json(
      { error: `Cannot reach service on port ${port} — is it running?` },
      { status: 502 }
    );
  }

  if (!serviceRes.ok) {
    const text = await serviceRes.text();
    return NextResponse.json({ error: text }, { status: serviceRes.status });
  }

  const { job_id } = await serviceRes.json();
  return NextResponse.json({ jobId: job_id, port });
}

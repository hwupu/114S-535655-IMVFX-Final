import { NextRequest, NextResponse } from "next/server";
import path from "path";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const port = searchParams.get("port");
  const jobId = searchParams.get("jobId");
  const sessionId = searchParams.get("sessionId");

  if (!port || !jobId) {
    return NextResponse.json({ error: "Missing port or jobId" }, { status: 400 });
  }

  let serviceRes: Response;
  try {
    serviceRes = await fetch(`http://127.0.0.1:${port}/jobs/${jobId}`);
  } catch {
    return NextResponse.json(
      { error: `Cannot reach service on port ${port}` },
      { status: 502 }
    );
  }

  if (!serviceRes.ok) {
    return NextResponse.json({ error: "Service error" }, { status: serviceRes.status });
  }

  const data = await serviceRes.json();

  let resultImageUrl: string | undefined;
  if (data.result_path && sessionId) {
    const filename = path.basename(data.result_path as string);
    resultImageUrl = `/api/images/${sessionId}/${filename}`;
  }

  return NextResponse.json({
    status: data.status,
    progress: data.progress ?? 0,
    resultImageUrl,
    result: data.result ?? null,
    detail: data.detail ?? null,
  });
}

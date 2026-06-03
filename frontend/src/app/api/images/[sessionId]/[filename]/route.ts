import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import { WORKSPACE } from "@/lib/paths";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string; filename: string }> },
) {
  const { sessionId, filename } = await params;

  // Guard against path traversal
  const safe = path.basename(filename);
  const filePath = path.join(WORKSPACE, path.basename(sessionId), safe);

  try {
    const data = await readFile(filePath);
    return new NextResponse(data, {
      headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { writeFile } from "fs/promises";
import path from "path";
import { WORKSPACE } from "@/lib/paths";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const blob = form.get("image") as File | null;
  const sessionId = form.get("sessionId") as string | null;
  if (!blob || !sessionId) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  const sessionDir = path.join(WORKSPACE, path.basename(sessionId));
  const buffer = Buffer.from(await blob.arrayBuffer());
  await writeFile(path.join(sessionDir, "stage3_mask.png"), buffer);
  return NextResponse.json({ ok: true });
}

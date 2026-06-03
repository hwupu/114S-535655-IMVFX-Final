import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { WORKSPACE } from "@/lib/paths";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("image") as File | null;
  if (!file) return NextResponse.json({ error: "No image" }, { status: 400 });

  const sessionId = uuidv4();
  const sessionDir = path.join(WORKSPACE, sessionId);
  await mkdir(sessionDir, { recursive: true });

  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(path.join(sessionDir, "original.png"), buffer);

  return NextResponse.json({ sessionId });
}

import { NextResponse } from "next/server";

// Liveness for the deploy probe. Does not touch the database.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, version: process.env.IMAGE_TAG || "dev" });
}

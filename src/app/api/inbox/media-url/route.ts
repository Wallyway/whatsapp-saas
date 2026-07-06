import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSignedUrl } from "@/features/inbox/services/media-handler";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const requestSchema = z.object({
  storagePath: z.string().min(1),
});

/**
 * POST /api/inbox/media-url
 *
 * Generates a 1-hour signed URL for a file in the whatsapp-media bucket.
 *
 * getSignedUrl signs with the service role, which BYPASSES storage RLS — so the
 * old "authenticated is enough" check was an IDOR: any logged-in user could sign
 * any workspace's media by guessing/leaking a storage path. The path is
 * {workspaceId}/{conversationId}/..., so we require the caller to be a member of
 * that first-segment workspace before signing.
 *
 * Body: { storagePath: string }
 * Response: { url: string }
 */
export async function POST(req: NextRequest) {
  try {
    // 1. Validate body
    const body: unknown = await req.json();
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "storagePath is required" },
        { status: 400 },
      );
    }

    // 2. Derive the owning workspace from the path and verify membership.
    const workspaceId = parsed.data.storagePath.split("/")[0];
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
      return NextResponse.json(
        { error: "storagePath inválido" },
        { status: 400 },
      );
    }
    const auth = await requireWorkspaceMember(workspaceId);
    if (!auth.ok) return auth.response;

    // 3. Generate signed URL (service role, 1 hour TTL)
    const url = await getSignedUrl(parsed.data.storagePath);
    if (!url) {
      return NextResponse.json(
        { error: "No se pudo generar la URL" },
        { status: 404 },
      );
    }

    return NextResponse.json({ url });
  } catch (error) {
    console.error("[POST /api/inbox/media-url]:", error);
    return NextResponse.json(
      { error: "Error interno del servidor" },
      { status: 500 },
    );
  }
}

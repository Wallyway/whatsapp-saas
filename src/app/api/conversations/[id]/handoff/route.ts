// F3-T2: Manual handoff — request or cancel a handoff for a conversation.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient as createSbClient } from "@supabase/supabase-js";
import { applyTransition } from "@/features/inbox/services/decision-engine";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";

const bodySchema = z.object({
  action: z.enum(["request", "cancel"]),
});

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: conversationId } = await params;

  // 1. Validate body
  const body = await req.json();
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // 2. Resolve the conversation's workspace and require an active member with at
  //    least the agent role. applyTransition runs with the service-role client
  //    (bypassing RLS), so without this gate any authenticated user could drive
  //    handoff transitions on any conversation by id (IDOR).
  const { data: conv } = await svc()
    .from("conversations")
    .select("workspace_id")
    .eq("id", conversationId)
    .single();

  if (!conv) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  const auth = await requireWorkspaceMember(conv.workspace_id, {
    minRole: "agent",
  });
  if (!auth.ok) return auth.response;
  const user = { id: auth.userId };

  const { action } = parsed.data;

  try {
    // 3. Determine target state
    // 'request' → handoff_pending (from ai_active or human_active)
    // 'cancel'  → ai_active (from handoff_pending)
    const to = action === "request" ? "handoff_pending" : "ai_active";

    await applyTransition(conversationId, to, user.id);

    // 4. Return updated state
    return NextResponse.json({ ok: true, state: to });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/conversations/[id]/handoff]:", message);

    // Surface transition validation errors as 422
    if (message.startsWith("Invalid transition:")) {
      return NextResponse.json({ error: message }, { status: 422 });
    }

    return NextResponse.json(
      { error: "Error interno del servidor" },
      { status: 500 },
    );
  }
}

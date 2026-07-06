// F1-E1: Human agent sends a free-text message from the inbox composer.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createSbClient } from "@supabase/supabase-js";
import { z } from "zod";
import { dispatchText } from "@/features/inbox/services/dispatch";
import { applyTransition } from "@/features/inbox/services/decision-engine";
import { getActiveAgent } from "@/features/agents/services/active-agent";
import {
  readJsonBody,
  requireWorkspaceMember,
} from "@/lib/auth/workspace-access";

const BodySchema = z.object({
  body: z.string().min(1).max(4096),
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

  // 1. Validate request body
  const parsed_body = await readJsonBody(req);
  if (!parsed_body.ok) return parsed_body.response;
  const parsed = BodySchema.safeParse(parsed_body.body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // 2. Resolve the conversation's workspace (service-role: we authorize below).
  //    Without this the route only checked "is logged in" — any authenticated
  //    user could send a real WhatsApp to any conversation in any workspace
  //    (cross-tenant IDOR), and a viewer could send at all.
  const admin = svc();
  const { data: conv } = await admin
    .from("conversations")
    .select("workspace_id, window_expires_at, ai_enabled")
    .eq("id", conversationId)
    .single();

  if (!conv) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // 3. Require an active member of THAT workspace with at least the agent role
  //    (viewers are read-only and must not send outbound messages).
  const auth = await requireWorkspaceMember(conv.workspace_id, {
    minRole: "agent",
  });
  if (!auth.ok) return auth.response;
  const user = { id: auth.userId };

  // 4. Dispatch via the single exit point
  const result = await dispatchText({
    workspaceId: conv.workspace_id,
    conversationId,
    body: parsed.data.body,
    senderUserId: user.id,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 422 });
  }

  // Sleep the bot when a human intervenes (configurable per agent, default on).
  // Transition ai_active → human_active so the AI stops replying this thread.
  if (conv.ai_enabled) {
    try {
      const activeAgent = await getActiveAgent(conv.workspace_id);
      const sleepOnManual = activeAgent?.config.sleepOnManualMessage !== false;
      if (sleepOnManual) {
        await applyTransition(conversationId, "human_active", user.id);
      }
    } catch (e) {
      // Non-fatal: the message was already sent. Most likely the conversation
      // wasn't in a state that allows the transition (already human_active).
      console.warn(
        "[messages] sleep-on-manual skipped:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  return NextResponse.json({ ok: true, wamid: result.wamid });
}

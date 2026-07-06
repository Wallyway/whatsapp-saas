import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  canTransition,
  type ConversationState,
} from "@/features/inbox/services/state-machine";

const toggleAiSchema = z.object({
  ai_enabled: z.boolean(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    // 1. Parse and validate body
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = toggleAiSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid input" },
        { status: 400 },
      );
    }

    const { ai_enabled } = parsed.data;

    // 2. Verify authenticated user session
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 3. Resolve conversation id from route params
    const { id } = await params;

    if (!id) {
      return NextResponse.json(
        { error: "Missing conversation id" },
        { status: 400 },
      );
    }

    // 4. Load current state so we move state + ai_enabled together. The decision
    //    engine keys off `state` (aiShouldRespond), so writing ai_enabled alone
    //    desyncs them: toggling off left state=ai_active and the AI replied
    //    anyway; re-enabling after a handoff left state=handoff_pending and the
    //    conversation went mute while the UI claimed "IA activa". RLS still
    //    scopes this read/write to the caller's workspace rows.
    const { data: conv, error: loadError } = await supabase
      .from("conversations")
      .select("state")
      .eq("id", id)
      .single();

    if (loadError || !conv) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 },
      );
    }

    const currentState = conv.state as ConversationState;

    // Turning the AI ON  → move to ai_active (unless already there).
    // Turning the AI OFF → pause it (only meaningful when it was ai_active;
    //   from a human/handoff state it's already off, so keep that state).
    let targetState = currentState;
    if (ai_enabled && currentState !== "ai_active") {
      targetState = "ai_active";
    } else if (!ai_enabled && currentState === "ai_active") {
      targetState = "paused";
    }

    if (targetState !== currentState && !canTransition(currentState, targetState)) {
      // e.g. a closed conversation can't be reactivated by the toggle.
      return NextResponse.json(
        {
          error: `No se puede ${ai_enabled ? "activar" : "desactivar"} la IA desde el estado "${currentState}"`,
        },
        { status: 422 },
      );
    }

    const { data, error: updateError } = await supabase
      .from("conversations")
      .update({
        ai_enabled,
        state: targetState,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select("id, ai_enabled, state")
      .single();

    if (updateError) {
      if (updateError.code === "PGRST116") {
        return NextResponse.json(
          { error: "Conversation not found" },
          { status: 404 },
        );
      }
      console.error("[toggle-ai] update error:", updateError);
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      ai_enabled: data.ai_enabled,
      state: data.state,
    });
  } catch (err) {
    console.error("[toggle-ai] unhandled error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

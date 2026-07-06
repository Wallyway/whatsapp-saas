// Dashboard metrics — service role queries (no RLS needed for aggregates)

import { createClient as createSbClient } from "@supabase/supabase-js";
import type { ConversationState } from "@/features/inbox/types";
import { estimateCostUsd } from "@/features/agents/lib/model-pricing";

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export interface WorkspaceMetrics {
  messagesToday: number;
  activeConversations: number;
  handoffPending: number;
  llmCostWeekUsd: number;
  templatesSentWeek: number;
}

export interface RecentConversation {
  id: string;
  contactName: string | null;
  contactPhone: string;
  lastMessagePreview: string | null;
  state: ConversationState;
  lastMessageAt: string | null;
}

export async function getWorkspaceMetrics(
  workspaceId: string,
): Promise<WorkspaceMetrics> {
  const supabase = svc();

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const weekStart = new Date();
  weekStart.setUTCDate(weekStart.getUTCDate() - 7);
  weekStart.setUTCHours(0, 0, 0, 0);

  const [
    messagesResult,
    activeResult,
    handoffResult,
    llmEventsResult,
    templatesResult,
  ] = await Promise.all([
    // Messages today (all directions)
    supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .gte("created_at", todayStart.toISOString()),

    // Active conversations
    supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .in("state", ["ai_active", "human_active"]),

    // Handoff pending
    supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("state", "handoff_pending"),

    // LLM usage events this week
    supabase
      .from("events")
      .select("payload")
      .eq("workspace_id", workspaceId)
      .eq("type", "llm_usage")
      .gte("created_at", weekStart.toISOString()),

    // Templates sent this week
    supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("type", "template")
      .gte("created_at", weekStart.toISOString()),
  ]);

  // Weight each call by its actual model and input/output split. A single flat
  // $/token rate underestimated premium-model spend 5-20x.
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const llmCostWeekUsd = (llmEventsResult.data ?? []).reduce((sum, row) => {
    const payload = row.payload as Record<string, unknown> | null;
    const model =
      typeof payload?.model === "string" ? (payload.model as string) : null;
    // Fall back to total_tokens as input when the split is missing (older rows).
    const prompt = num(payload?.prompt_tokens);
    const completion = num(payload?.completion_tokens);
    const fallbackInput =
      prompt === 0 && completion === 0 ? num(payload?.total_tokens) : prompt;
    return sum + estimateCostUsd(model, fallbackInput, completion);
  }, 0);

  return {
    messagesToday: messagesResult.count ?? 0,
    activeConversations: activeResult.count ?? 0,
    handoffPending: handoffResult.count ?? 0,
    llmCostWeekUsd,
    templatesSentWeek: templatesResult.count ?? 0,
  };
}

export async function getRecentConversations(
  workspaceId: string,
  limit = 5,
): Promise<RecentConversation[]> {
  const supabase = svc();

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const { data } = await supabase
    .from("conversations")
    .select(
      `
      id,
      state,
      last_message_at,
      contacts!inner(name, phone),
      messages(body, direction, created_at)
    `,
    )
    .eq("workspace_id", workspaceId)
    .gte("last_message_at", todayStart.toISOString())
    .order("last_message_at", { ascending: false })
    .limit(limit);

  if (!data) return [];

  return data.map((row) => {
    const contact = Array.isArray(row.contacts)
      ? row.contacts[0]
      : row.contacts;
    const msgs = Array.isArray(row.messages) ? row.messages : [];
    const lastMsg = msgs.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )[0];

    return {
      id: row.id,
      contactName: (contact as { name: string | null })?.name ?? null,
      contactPhone: (contact as { phone: string })?.phone ?? "",
      lastMessagePreview: lastMsg?.body ?? null,
      state: row.state as ConversationState,
      lastMessageAt: row.last_message_at,
    };
  });
}

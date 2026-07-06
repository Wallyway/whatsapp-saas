import { createClient as createSbClient } from "@supabase/supabase-js";
import { performance } from "node:perf_hooks";

const LLM_TURNS_PER_CONTACT_PER_HOUR = 20;
const LLM_DAILY_BUDGET_TOKENS = 1_000_000;

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

interface RecordLlmUsageOpts {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Inserts an llm_usage event into the events table for observability and
 * rate-limit accounting.
 */
export async function recordLlmUsage(opts: RecordLlmUsageOpts): Promise<void> {
  const supabase = svc();

  const {
    workspaceId,
    conversationId,
    contactId,
    model,
    promptTokens,
    completionTokens,
  } = opts;

  const totalTokens = promptTokens + completionTokens;

  await supabase.from("events").insert({
    type: "llm_usage",
    level: "info",
    workspace_id: workspaceId,
    conversation_id: conversationId,
    payload: {
      model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      contact_id: contactId,
    },
  });
}

interface RateLimitResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Checks per-contact hourly turn limit and workspace daily token budget.
 *
 * Returns { allowed: false, reason } when either ceiling is breached,
 * { allowed: true } otherwise.
 */
export async function checkRateLimits(
  workspaceId: string,
  contactId: string,
): Promise<RateLimitResult> {
  const supabase = svc();

  const nowMs = performance.timeOrigin + performance.now();

  // ── 1. Per-contact hourly turn limit ──────────────────────────────────────
  // Aggregate in SQL: a raw SELECT is capped at ~1000 rows by PostgREST and
  // would undercount past that, defeating the limit at high volume.
  const hourAgo = new Date(nowMs - 3_600_000).toISOString();

  const { data: hourlyCount, error: hourlyError } = await supabase.rpc(
    "count_llm_turns_for_contact_since",
    {
      p_workspace_id: workspaceId,
      p_contact_id: contactId,
      p_since: hourAgo,
    },
  );

  if (hourlyError) {
    console.error("[cost-tracker] hourly check error:", hourlyError);
    // Fail open — don't block on DB errors
    return { allowed: true };
  }

  if (Number(hourlyCount ?? 0) >= LLM_TURNS_PER_CONTACT_PER_HOUR) {
    return { allowed: false, reason: "rate_limit_contact_hour" };
  }

  // ── 2. Workspace daily token budget ───────────────────────────────────────
  const dayStart = new Date(nowMs);
  dayStart.setUTCHours(0, 0, 0, 0);

  const { data: totalTokensToday, error: dailyError } = await supabase.rpc(
    "sum_llm_tokens_since",
    {
      p_workspace_id: workspaceId,
      p_since: dayStart.toISOString(),
    },
  );

  if (dailyError) {
    console.error("[cost-tracker] daily check error:", dailyError);
    return { allowed: true };
  }

  if (Number(totalTokensToday ?? 0) >= LLM_DAILY_BUDGET_TOKENS) {
    return { allowed: false, reason: "daily_token_budget_exceeded" };
  }

  return { allowed: true };
}

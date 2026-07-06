-- ============================================================
-- Migration: 20260618000002_llm_usage_aggregates
-- SEC/CORRECTNESS: aggregate LLM usage in SQL, not in JS.
--
-- checkRateLimits() and enforceCostPolicy() SELECTed raw llm_usage rows and
-- summed them in JS. PostgREST caps a response at ~1000 rows, so past ~1000
-- calls/day the sum silently undercounts and the daily token budget / rate
-- limits stop firing exactly when volume is highest. Do the SUM()/COUNT() in
-- the database instead.
-- ============================================================

-- Total LLM tokens for a workspace since a timestamp.
CREATE OR REPLACE FUNCTION public.sum_llm_tokens_since(
  p_workspace_id uuid,
  p_since        timestamptz
)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(SUM((payload->>'total_tokens')::bigint), 0)
  FROM public.events
  WHERE type = 'llm_usage'
    AND workspace_id = p_workspace_id
    AND created_at >= p_since;
$$;

-- Number of LLM turns for a specific contact in a workspace since a timestamp.
CREATE OR REPLACE FUNCTION public.count_llm_turns_for_contact_since(
  p_workspace_id uuid,
  p_contact_id   uuid,
  p_since        timestamptz
)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COUNT(*)
  FROM public.events
  WHERE type = 'llm_usage'
    AND workspace_id = p_workspace_id
    AND payload->>'contact_id' = p_contact_id::text
    AND created_at >= p_since;
$$;

REVOKE EXECUTE ON FUNCTION public.sum_llm_tokens_since(uuid, timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION public.count_llm_turns_for_contact_since(uuid, uuid, timestamptz) FROM anon;

-- ============================================================
-- End of migration: 20260618000002_llm_usage_aggregates
-- ============================================================

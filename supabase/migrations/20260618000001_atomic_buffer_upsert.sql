-- ============================================================
-- Migration: 20260618000001_atomic_buffer_upsert
-- SCALE/CORRECTNESS: make buffer batch upsert atomic to kill two races.
--
-- (#2) Double AI reply: upsertBatch() did check-then-insert with no lock or
--      unique constraint, so two concurrent webhooks (the normal 2-message
--      buffer case) each created a batch -> two LLM replies.
--
-- (#3) Orphaned message: the extend UPDATE was guarded by status='buffering';
--      when the cron had already claimed the batch (status='processing') the
--      UPDATE matched 0 rows WITHOUT error, but the message was linked to that
--      already-processed batch anyway -> its text never made it into a reply.
--
-- Fix: one SECURITY DEFINER RPC that (a) extends the live buffering batch while
-- holding its row lock, or (b) creates a fresh one, and links the message in the
-- SAME transaction. A partial unique index guarantees at most one buffering
-- batch per conversation; a racing INSERT raises 23505 and the loop retries the
-- extend path. Because the row is locked (and the cron's claim uses FOR UPDATE
-- SKIP LOCKED), the message is always linked before the batch can be claimed.
-- ============================================================

-- 1. Collapse any pre-existing duplicate buffering batches so the unique index
--    can be created. Keep the newest per conversation; cancel the rest.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY conversation_id ORDER BY created_at DESC
         ) AS rn
  FROM public.message_batches
  WHERE status = 'buffering'
)
UPDATE public.message_batches b
SET status = 'cancelled',
    updated_at = NOW(),
    meta = b.meta || jsonb_build_object('cancelled_reason', 'dedup_buffering_on_migration')
FROM ranked
WHERE b.id = ranked.id AND ranked.rn > 1;

-- 2. At most one buffering batch per conversation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_batches_one_buffering_per_conversation
  ON public.message_batches (conversation_id)
  WHERE status = 'buffering';

-- 3. Atomic extend-or-create + link the inbound message.
CREATE OR REPLACE FUNCTION public.upsert_buffering_batch(
  p_workspace_id   uuid,
  p_conversation_id uuid,
  p_message_id     uuid,
  p_silence_ms     integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_id uuid;
  v_flush    timestamptz := NOW() + make_interval(secs => p_silence_ms / 1000.0);
BEGIN
  LOOP
    -- (a) Extend the live buffering batch. Locking it here means a concurrent
    --     claim_next_batch() (FOR UPDATE SKIP LOCKED) skips it until we commit,
    --     so it can't flip to 'processing' mid-update.
    UPDATE public.message_batches
      SET flush_at      = v_flush,
          message_count = message_count + 1,
          updated_at    = NOW()
      WHERE conversation_id = p_conversation_id
        AND status = 'buffering'
      RETURNING id INTO v_batch_id;

    EXIT WHEN v_batch_id IS NOT NULL;

    -- (b) None buffering -> create one. The partial unique index makes this
    --     safe: a racing INSERT raises 23505 and we loop back to extend the
    --     row the other transaction just created.
    BEGIN
      INSERT INTO public.message_batches
        (workspace_id, conversation_id, status, silence_ms,
         flush_at, message_count, meta)
      VALUES
        (p_workspace_id, p_conversation_id, 'buffering', p_silence_ms,
         v_flush, 1, '{}'::jsonb)
      RETURNING id INTO v_batch_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      -- Another webhook won the create race; retry the extend path.
      v_batch_id := NULL;
    END;
  END LOOP;

  -- Link the inbound message in the same transaction, before the batch can be
  -- claimed, so consolidateBatch never misses it.
  UPDATE public.messages
    SET batch_id = v_batch_id
    WHERE id = p_message_id;

  RETURN v_batch_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.upsert_buffering_batch(uuid, uuid, uuid, integer) FROM anon;

-- ============================================================
-- End of migration: 20260618000001_atomic_buffer_upsert
-- ============================================================

-- ============================================================
-- Migration: 20260618000000_lock_users_privileged_columns
-- SEC: prevent self-escalation to super admin (and self-toggling is_active).
--
-- Problem: the "users_update_own" RLS policy lets a user UPDATE their own row
-- with WITH CHECK (id = auth.uid()) but does NOT restrict WHICH columns. Because
-- Supabase grants table-level UPDATE on public.users to `authenticated`, any
-- logged-in user (even a viewer) could PATCH is_super_admin = true and take over
-- the whole agency (cross-tenant compromise).
--
-- A column-level REVOKE alone does NOT help: a table-level UPDATE grant already
-- covers every column, and REVOKE UPDATE (col) does not subtract from it. So we
-- drop the table-level grant and re-grant UPDATE only on the safe profile
-- columns, plus a defensive BEFORE UPDATE trigger as belt-and-suspenders.
--
-- service_role (used by seed-admin, provisioning, signup-gate) bypasses grants
-- and RLS, so all server-side writes keep working unchanged.
-- ============================================================

-- 1. Drop the blanket table-level UPDATE grant, re-grant only safe columns.
REVOKE UPDATE ON public.users FROM authenticated;
REVOKE UPDATE ON public.users FROM anon;
GRANT UPDATE (full_name, avatar_url, updated_at) ON public.users TO authenticated;

-- 2. Defensive trigger: reject any change to privileged columns unless the
--    caller is a privileged Postgres role (service_role / postgres / admin).
--    NOTE: must be SECURITY INVOKER (the default) so current_user reflects the
--    real caller ('authenticated' vs 'service_role'); a SECURITY DEFINER
--    function would always see the owner role and defeat the check.
CREATE OR REPLACE FUNCTION public.protect_user_privileged_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF (NEW.is_super_admin IS DISTINCT FROM OLD.is_super_admin
      OR NEW.is_active IS DISTINCT FROM OLD.is_active)
     AND current_user NOT IN ('service_role', 'postgres', 'supabase_admin')
  THEN
    RAISE EXCEPTION
      'no permitido: is_super_admin / is_active solo pueden cambiarse desde el servidor'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_user_privileged_columns ON public.users;
CREATE TRIGGER trg_protect_user_privileged_columns
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_user_privileged_columns();

-- ============================================================
-- End of migration: 20260618000000_lock_users_privileged_columns
-- ============================================================

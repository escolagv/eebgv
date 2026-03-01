-- ===============================================================
-- Detalha criação e confirmação no auth.users por lista de e-mails
-- ===============================================================
CREATE OR REPLACE FUNCTION public.auth_user_status_by_email(
    p_emails text[]
) RETURNS TABLE(
    email text,
    created_at timestamptz,
    confirmed_at timestamptz,
    email_confirmed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT
        u.email,
        u.created_at,
        u.confirmed_at,
        u.email_confirmed_at
    FROM auth.users u
    WHERE u.email = ANY(p_emails);
$$;

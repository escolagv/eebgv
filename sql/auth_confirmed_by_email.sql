-- ===============================================================
-- Verifica confirmação de e-mail no auth.users por lista de e-mails
-- ===============================================================
CREATE OR REPLACE FUNCTION public.auth_confirmed_by_email(
    p_emails text[]
) RETURNS TABLE(email text, confirmed boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT
        u.email,
        (u.confirmed_at IS NOT NULL OR u.email_confirmed_at IS NOT NULL) AS confirmed
    FROM auth.users u
    WHERE u.email = ANY(p_emails);
$$;


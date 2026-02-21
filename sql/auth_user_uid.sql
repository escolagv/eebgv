-- ===============================================================
-- Procura o user_uid no auth.users a partir do e-mail
-- ===============================================================

CREATE OR REPLACE FUNCTION public.auth_user_uid_by_email(
    p_email text
) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT id
    FROM auth.users
    WHERE email = p_email
    LIMIT 1;
$$;

-- ===============================================================
-- OPCIONAL: POLITICAS SOMENTE LEITURA NO APOIA
-- Use APENAS se o sync falhar por falta de permissao (RLS).
-- Este script NAO habilita RLS; apenas cria politicas se necessario.
-- ===============================================================

DO $$
BEGIN
    -- ALUNOS (apenas leitura para admin)
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'alunos'
          AND policyname = 'apoia_alunos_admin_read'
    ) THEN
        CREATE POLICY apoia_alunos_admin_read
        ON public.alunos
        FOR SELECT
        TO authenticated
        USING (public.is_admin(auth.uid()));
    END IF;

    -- USUARIOS (apenas leitura para admin)
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'usuarios'
          AND policyname = 'apoia_usuarios_admin_read'
    ) THEN
        CREATE POLICY apoia_usuarios_admin_read
        ON public.usuarios
        FOR SELECT
        TO authenticated
        USING (public.is_admin(auth.uid()));
    END IF;

    -- TURMAS (apenas leitura para admin)
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'turmas'
          AND policyname = 'apoia_turmas_admin_read'
    ) THEN
        CREATE POLICY apoia_turmas_admin_read
        ON public.turmas
        FOR SELECT
        TO authenticated
        USING (public.is_admin(auth.uid()));
    END IF;
END $$;

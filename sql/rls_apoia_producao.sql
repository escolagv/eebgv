-- ===============================================================
-- RLS PARA APOIA (CHAMADA) - PRODUCAO
-- Objetivo: proteger dados sem quebrar o front.
-- ===============================================================

-- ===============================================================
-- TABELAS AUXILIARES (ADMIN/PROF) PARA EVITAR RECURSAO EM RLS
-- ===============================================================

CREATE TABLE IF NOT EXISTS public.admin_uids (
    user_uid uuid PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS public.professor_uids (
    user_uid uuid PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS public.suporte_uids (
    user_uid uuid PRIMARY KEY
);

-- Protecao direta das tabelas auxiliares (evita auto-promocao)
ALTER TABLE public.admin_uids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.professor_uids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suporte_uids ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.admin_uids FROM PUBLIC;
REVOKE ALL ON TABLE public.professor_uids FROM PUBLIC;
REVOKE ALL ON TABLE public.suporte_uids FROM PUBLIC;
REVOKE ALL ON TABLE public.admin_uids FROM anon, authenticated;
REVOKE ALL ON TABLE public.professor_uids FROM anon, authenticated;
REVOKE ALL ON TABLE public.suporte_uids FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_uids TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.professor_uids TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.suporte_uids TO service_role;

DROP POLICY IF EXISTS admin_uids_service_only ON public.admin_uids;
CREATE POLICY admin_uids_service_only
ON public.admin_uids
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS professor_uids_service_only ON public.professor_uids;
CREATE POLICY professor_uids_service_only
ON public.professor_uids
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS suporte_uids_service_only ON public.suporte_uids;
CREATE POLICY suporte_uids_service_only
ON public.suporte_uids
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Sincroniza admin_uids com usuarios (papel/status)
CREATE OR REPLACE FUNCTION public.sync_admin_uids()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM public.admin_uids WHERE user_uid = OLD.user_uid;
        RETURN OLD;
    END IF;

    IF NEW.papel = 'admin' AND NEW.status = 'ativo' THEN
        INSERT INTO public.admin_uids(user_uid)
        VALUES (NEW.user_uid)
        ON CONFLICT (user_uid) DO NOTHING;
    ELSE
        DELETE FROM public.admin_uids WHERE user_uid = NEW.user_uid;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS usuarios_admin_uids_sync ON public.usuarios;
CREATE TRIGGER usuarios_admin_uids_sync
AFTER INSERT OR UPDATE OR DELETE ON public.usuarios
FOR EACH ROW EXECUTE FUNCTION public.sync_admin_uids();

-- Bootstrap inicial (rodar uma vez)
INSERT INTO public.admin_uids(user_uid)
SELECT user_uid FROM public.usuarios
WHERE papel = 'admin' AND status = 'ativo'
ON CONFLICT (user_uid) DO NOTHING;

-- Sincroniza professor_uids com usuarios (papel/status)
CREATE OR REPLACE FUNCTION public.sync_professor_uids()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM public.professor_uids WHERE user_uid = OLD.user_uid;
        RETURN OLD;
    END IF;

    IF NEW.papel = 'professor' AND NEW.status = 'ativo' THEN
        INSERT INTO public.professor_uids(user_uid)
        VALUES (NEW.user_uid)
        ON CONFLICT (user_uid) DO NOTHING;
    ELSE
        DELETE FROM public.professor_uids WHERE user_uid = NEW.user_uid;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS usuarios_professor_uids_sync ON public.usuarios;
CREATE TRIGGER usuarios_professor_uids_sync
AFTER INSERT OR UPDATE OR DELETE ON public.usuarios
FOR EACH ROW EXECUTE FUNCTION public.sync_professor_uids();

-- Bootstrap inicial (rodar uma vez)
INSERT INTO public.professor_uids(user_uid)
SELECT user_uid FROM public.usuarios
WHERE papel = 'professor' AND status = 'ativo'
ON CONFLICT (user_uid) DO NOTHING;

-- Sincroniza suporte_uids com usuarios (papel/status)
CREATE OR REPLACE FUNCTION public.sync_suporte_uids()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM public.suporte_uids WHERE user_uid = OLD.user_uid;
        RETURN OLD;
    END IF;

    IF NEW.papel = 'suporte' AND NEW.status = 'ativo' THEN
        INSERT INTO public.suporte_uids(user_uid)
        VALUES (NEW.user_uid)
        ON CONFLICT (user_uid) DO NOTHING;
    ELSE
        DELETE FROM public.suporte_uids WHERE user_uid = NEW.user_uid;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS usuarios_suporte_uids_sync ON public.usuarios;
CREATE TRIGGER usuarios_suporte_uids_sync
AFTER INSERT OR UPDATE OR DELETE ON public.usuarios
FOR EACH ROW EXECUTE FUNCTION public.sync_suporte_uids();

-- Bootstrap inicial (rodar uma vez)
INSERT INTO public.suporte_uids(user_uid)
SELECT user_uid FROM public.usuarios
WHERE papel = 'suporte' AND status = 'ativo'
ON CONFLICT (user_uid) DO NOTHING;

-- Funcoes auxiliares
CREATE OR REPLACE FUNCTION public.is_admin(p_uid uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
    v_exists boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM public.admin_uids a
        WHERE a.user_uid = p_uid
    ) INTO v_exists;
    RETURN v_exists;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_professor(p_uid uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
    v_exists boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM public.professor_uids p
        WHERE p.user_uid = p_uid
    ) INTO v_exists;
    RETURN v_exists;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_suporte(p_uid uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
    v_exists boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM public.suporte_uids s
        WHERE s.user_uid = p_uid
    ) INTO v_exists;
    RETURN v_exists;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_professor_of_turma(p_uid uuid, p_turma_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
    v_exists boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM public.professores_turmas pt
        WHERE pt.professor_id = p_uid
          AND pt.turma_id = p_turma_id
    ) INTO v_exists;
    RETURN v_exists;
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_professor(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_suporte(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_professor_of_turma(uuid, bigint) TO authenticated;

-- ===============================================================
-- ENABLE RLS
-- ===============================================================
ALTER TABLE public.usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alunos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turmas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.professores_turmas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.presencas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eventos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.configuracoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.apoia_encaminhamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alertas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Garantir permissao basica de leitura/atualizacao para usuarios autenticados
GRANT SELECT, UPDATE ON TABLE public.usuarios TO authenticated;

-- ===============================================================
-- POLITICAS: USUARIOS
-- (usa admin_uids direto para evitar recursao)
-- ===============================================================

DROP POLICY IF EXISTS usuarios_admin_all ON public.usuarios;
DROP POLICY IF EXISTS usuarios_self_read ON public.usuarios;
DROP POLICY IF EXISTS usuarios_self_update ON public.usuarios;

CREATE POLICY usuarios_admin_all
ON public.usuarios
FOR ALL
TO authenticated
USING (public.is_admin(auth.uid()))
WITH CHECK (public.is_admin(auth.uid()));

CREATE POLICY usuarios_self_read
ON public.usuarios
FOR SELECT
TO authenticated
USING (user_uid = auth.uid());

CREATE POLICY usuarios_self_update
ON public.usuarios
FOR UPDATE
TO authenticated
USING (user_uid = auth.uid())
WITH CHECK (user_uid = auth.uid());

-- ===============================================================
-- POLITICAS: TURMAS
-- ===============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'turmas'
          AND policyname = 'turmas_admin_all'
    ) THEN
        CREATE POLICY turmas_admin_all
        ON public.turmas
        FOR ALL
        TO authenticated
        USING (public.is_admin(auth.uid()))
        WITH CHECK (public.is_admin(auth.uid()));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'turmas'
          AND policyname = 'turmas_professor_read'
    ) THEN
        CREATE POLICY turmas_professor_read
        ON public.turmas
        FOR SELECT
        TO authenticated
        USING (
            public.is_admin(auth.uid())
            OR EXISTS (
                SELECT 1 FROM public.professores_turmas pt
                WHERE pt.professor_id = auth.uid()
                  AND pt.turma_id = turmas.id
            )
        );
    END IF;
END $$;

-- ===============================================================
-- POLITICAS: PROFESSORES_TURMAS
-- ===============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'professores_turmas'
          AND policyname = 'professores_turmas_admin_all'
    ) THEN
        CREATE POLICY professores_turmas_admin_all
        ON public.professores_turmas
        FOR ALL
        TO authenticated
        USING (public.is_admin(auth.uid()))
        WITH CHECK (public.is_admin(auth.uid()));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'professores_turmas'
          AND policyname = 'professores_turmas_professor_read'
    ) THEN
        CREATE POLICY professores_turmas_professor_read
        ON public.professores_turmas
        FOR SELECT
        TO authenticated
        USING (professor_id = auth.uid() OR public.is_admin(auth.uid()));
    END IF;
END $$;

-- ===============================================================
-- POLITICAS: ALUNOS
-- ===============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'alunos'
          AND policyname = 'alunos_admin_all'
    ) THEN
        CREATE POLICY alunos_admin_all
        ON public.alunos
        FOR ALL
        TO authenticated
        USING (public.is_admin(auth.uid()))
        WITH CHECK (public.is_admin(auth.uid()));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'alunos'
          AND policyname = 'alunos_professor_read'
    ) THEN
        CREATE POLICY alunos_professor_read
        ON public.alunos
        FOR SELECT
        TO authenticated
        USING (
            public.is_admin(auth.uid())
            OR public.is_professor_of_turma(auth.uid(), alunos.turma_id)
        );
    END IF;
END $$;

-- ===============================================================
-- POLITICAS: PRESENCAS
-- ===============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'presencas'
          AND policyname = 'presencas_admin_all'
    ) THEN
        CREATE POLICY presencas_admin_all
        ON public.presencas
        FOR ALL
        TO authenticated
        USING (public.is_admin(auth.uid()))
        WITH CHECK (public.is_admin(auth.uid()));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'presencas'
          AND policyname = 'presencas_professor_read'
    ) THEN
        CREATE POLICY presencas_professor_read
        ON public.presencas
        FOR SELECT
        TO authenticated
        USING (
            public.is_admin(auth.uid())
            OR public.is_professor_of_turma(auth.uid(), presencas.turma_id)
        );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'presencas'
          AND policyname = 'presencas_professor_insert'
    ) THEN
        CREATE POLICY presencas_professor_insert
        ON public.presencas
        FOR INSERT
        TO authenticated
        WITH CHECK (
            public.is_admin(auth.uid())
            OR (public.is_professor_of_turma(auth.uid(), presencas.turma_id)
                AND presencas.registrado_por_uid = auth.uid())
        );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'presencas'
          AND policyname = 'presencas_professor_update'
    ) THEN
        CREATE POLICY presencas_professor_update
        ON public.presencas
        FOR UPDATE
        TO authenticated
        USING (
            public.is_admin(auth.uid())
            OR (public.is_professor_of_turma(auth.uid(), presencas.turma_id)
                AND presencas.registrado_por_uid = auth.uid())
        )
        WITH CHECK (
            public.is_admin(auth.uid())
            OR (public.is_professor_of_turma(auth.uid(), presencas.turma_id)
                AND presencas.registrado_por_uid = auth.uid())
        );
    END IF;
END $$;

-- ===============================================================
-- POLITICAS: EVENTOS
-- ===============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'eventos'
          AND policyname = 'eventos_admin_all'
    ) THEN
        CREATE POLICY eventos_admin_all
        ON public.eventos
        FOR ALL
        TO authenticated
        USING (public.is_admin(auth.uid()))
        WITH CHECK (public.is_admin(auth.uid()));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'eventos'
          AND policyname = 'eventos_authenticated_read'
    ) THEN
        CREATE POLICY eventos_authenticated_read
        ON public.eventos
        FOR SELECT
        TO authenticated
        USING (public.is_admin(auth.uid()) OR public.is_professor(auth.uid()));
    END IF;
END $$;

-- ===============================================================
-- POLITICAS: CONFIGURACOES
-- ===============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'configuracoes'
          AND policyname = 'configuracoes_admin_all'
    ) THEN
        CREATE POLICY configuracoes_admin_all
        ON public.configuracoes
        FOR ALL
        TO authenticated
        USING (public.is_admin(auth.uid()))
        WITH CHECK (public.is_admin(auth.uid()));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'configuracoes'
          AND policyname = 'configuracoes_authenticated_read'
    ) THEN
        CREATE POLICY configuracoes_authenticated_read
        ON public.configuracoes
        FOR SELECT
        TO authenticated
        USING (public.is_admin(auth.uid()) OR public.is_professor(auth.uid()));
    END IF;
END $$;

-- ===============================================================
-- POLITICAS: APOIA_ENCAMINHAMENTOS
-- ===============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'apoia_encaminhamentos'
          AND policyname = 'apoia_encaminhamentos_admin_all'
    ) THEN
        CREATE POLICY apoia_encaminhamentos_admin_all
        ON public.apoia_encaminhamentos
        FOR ALL
        TO authenticated
        USING (public.is_admin(auth.uid()))
        WITH CHECK (public.is_admin(auth.uid()));
    END IF;
END $$;

-- ===============================================================
-- POLITICAS: ALERTAS
-- ===============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'alertas'
          AND policyname = 'alertas_admin_all'
    ) THEN
        CREATE POLICY alertas_admin_all
        ON public.alertas
        FOR ALL
        TO authenticated
        USING (public.is_admin(auth.uid()))
        WITH CHECK (public.is_admin(auth.uid()));
    END IF;
END $$;

-- ===============================================================
-- POLITICAS: AUDIT_LOGS
-- ===============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'audit_logs'
          AND policyname = 'audit_logs_admin_read'
    ) THEN
        CREATE POLICY audit_logs_admin_read
        ON public.audit_logs
        FOR SELECT
        TO authenticated
        USING (public.is_admin(auth.uid()));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'audit_logs'
          AND policyname = 'audit_logs_authenticated_insert'
    ) THEN
        CREATE POLICY audit_logs_authenticated_insert
        ON public.audit_logs
        FOR INSERT
        TO authenticated
        WITH CHECK (auth.uid() IS NOT NULL);
    END IF;
END $$;

-- ===============================================================
-- TABELAS DO SISTEMA DE ENCAMINHAMENTOS (ENC_*)
-- ===============================================================

CREATE TABLE IF NOT EXISTS public.enc_alunos (
    id bigint PRIMARY KEY,
    nome_completo text NOT NULL,
    matricula text,
    turma_id bigint,
    nome_responsavel text,
    telefone text,
    status text DEFAULT 'ativo',
    copied_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.enc_professores (
    user_uid uuid PRIMARY KEY,
    nome text NOT NULL,
    email text,
    telefone text,
    status text DEFAULT 'ativo',
    vinculo text,
    copied_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.enc_encaminhamentos (
    id bigserial PRIMARY KEY,
    data_encaminhamento date NOT NULL,
    aluno_id bigint NOT NULL REFERENCES public.enc_alunos(id),
    aluno_nome text NOT NULL,
    professor_uid uuid REFERENCES public.enc_professores(user_uid),
    professor_nome text,
    turma_id bigint,
    turma_nome text,
    motivos text,
    detalhes_motivo text,
    acoes_tomadas text,
    detalhes_acao text,
    numero_telefone text,
    horario_ligacao time,
    status_ligacao text,
    recado_com text,
    providencias text,
    solicitacao_comparecimento text,
    status text DEFAULT 'Aberto',
    outras_informacoes text,
    registrado_por_uid uuid,
    registrado_por_nome text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.enc_alunos TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.enc_professores TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.enc_encaminhamentos TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.enc_encaminhamentos_id_seq TO authenticated;

-- ===============================================================
-- FUNCAO AUXILIAR PARA RLS (ADMIN)
-- ===============================================================
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
    ) OR EXISTS (
        SELECT 1
        FROM public.suporte_uids s
        WHERE s.user_uid = p_uid
    )
    INTO v_exists;
    RETURN v_exists;
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_admin(uuid) TO authenticated;

-- ===============================================================
-- POLITICAS RLS (APENAS ADMIN)
-- ===============================================================
ALTER TABLE public.enc_alunos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enc_professores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enc_encaminhamentos ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'enc_alunos'
          AND policyname = 'enc_alunos_admin_all'
    ) THEN
        CREATE POLICY enc_alunos_admin_all
        ON public.enc_alunos
        FOR ALL
        TO authenticated
        USING (public.is_admin(auth.uid()))
        WITH CHECK (public.is_admin(auth.uid()));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'enc_professores'
          AND policyname = 'enc_professores_admin_all'
    ) THEN
        CREATE POLICY enc_professores_admin_all
        ON public.enc_professores
        FOR ALL
        TO authenticated
        USING (public.is_admin(auth.uid()))
        WITH CHECK (public.is_admin(auth.uid()));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'enc_encaminhamentos'
          AND policyname = 'enc_encaminhamentos_admin_all'
    ) THEN
        CREATE POLICY enc_encaminhamentos_admin_all
        ON public.enc_encaminhamentos
        FOR ALL
        TO authenticated
        USING (public.is_admin(auth.uid()))
        WITH CHECK (public.is_admin(auth.uid()));
    END IF;
END $$;

-- ===============================================================
-- FUNCAO DE SINCRONIZACAO
-- ===============================================================
CREATE OR REPLACE FUNCTION public.sync_enc_cache()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        PERFORM set_config(
            'request.jwt.claim.sub',
            COALESCE(
                (SELECT a.user_uid::text FROM public.admin_uids a LIMIT 1),
                (SELECT s.user_uid::text FROM public.suporte_uids s LIMIT 1)
            ),
            true
        );
    END IF;

    IF auth.uid() IS NOT NULL AND NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Acesso negado';
    END IF;

    -- Inserir alunos novos
    INSERT INTO public.enc_alunos (id, nome_completo, matricula, turma_id, nome_responsavel, telefone, status)
    SELECT a.id, a.nome_completo, a.matricula, a.turma_id, a.nome_responsavel, a.telefone, a.status
    FROM public.alunos a
    WHERE NOT EXISTS (SELECT 1 FROM public.enc_alunos e WHERE e.id = a.id);

    -- Inserir professores novos
    INSERT INTO public.enc_professores (user_uid, nome, email, telefone, status, vinculo)
    SELECT u.user_uid, u.nome, u.email, u.telefone, u.status, u.vinculo
    FROM public.usuarios u
    WHERE u.papel = 'professor'
      AND NOT EXISTS (SELECT 1 FROM public.enc_professores e WHERE e.user_uid = u.user_uid);

    -- Inativar alunos que nao existem mais no APOIA
    UPDATE public.enc_alunos e
    SET status = 'inativo'
    WHERE NOT EXISTS (SELECT 1 FROM public.alunos a WHERE a.id = e.id);

    -- Inativar professores que nao existem mais no APOIA
    UPDATE public.enc_professores e
    SET status = 'inativo'
    WHERE NOT EXISTS (
        SELECT 1 FROM public.usuarios u
        WHERE u.user_uid = e.user_uid AND u.papel = 'professor'
    );

    -- Inativar alunos e professores marcados como inativos no APOIA
    UPDATE public.enc_alunos e
    SET status = 'inativo'
    FROM public.alunos a
    WHERE a.id = e.id AND a.status = 'inativo' AND e.status <> 'inativo';

    UPDATE public.enc_professores e
    SET status = 'inativo'
    FROM public.usuarios u
    WHERE u.user_uid = e.user_uid AND u.papel = 'professor' AND u.status = 'inativo' AND e.status <> 'inativo';
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_enc_cache() TO authenticated;

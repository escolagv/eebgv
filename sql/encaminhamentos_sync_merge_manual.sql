-- ===============================================================
-- ENCAMINHAMENTOS - SYNC ROBUSTO (SEM MUDANCA DE FRONT)
-- Objetivo:
-- 1) Receber atualizacao do "chamada" sem duplicar.
-- 2) Permitir que cadastro manual seja "absorvido" quando aparecer no chamada.
-- 3) Manter PK atual de enc_alunos / enc_professores (nao quebra front).
-- ===============================================================

BEGIN;

-- ---------------------------------------------------------------
-- 1) Colunas tecnicas para vinculo com origem oficial (chamada/apoia)
-- ---------------------------------------------------------------
ALTER TABLE public.enc_alunos
    ADD COLUMN IF NOT EXISTS apoia_aluno_id bigint;

ALTER TABLE public.enc_professores
    ADD COLUMN IF NOT EXISTS apoia_user_uid uuid;

-- Preenche vinculo tecnico para registros que ja sao origem oficial.
UPDATE public.enc_alunos
SET apoia_aluno_id = id
WHERE origem = 'apoia'
  AND apoia_aluno_id IS NULL;

UPDATE public.enc_professores
SET apoia_user_uid = user_uid
WHERE origem = 'apoia'
  AND apoia_user_uid IS NULL;

-- ---------------------------------------------------------------
-- 2) Indices/constraints de apoio ao merge sem duplicacao
-- ---------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS enc_alunos_apoia_aluno_id_uidx
ON public.enc_alunos (apoia_aluno_id)
WHERE apoia_aluno_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS enc_professores_apoia_user_uid_uidx
ON public.enc_professores (apoia_user_uid)
WHERE apoia_user_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS enc_alunos_matricula_norm_idx
ON public.enc_alunos ((nullif(lower(trim(matricula)), '')));

CREATE INDEX IF NOT EXISTS enc_professores_email_norm_idx
ON public.enc_professores ((nullif(lower(trim(email)), '')));

-- ---------------------------------------------------------------
-- 3) Sync com merge de manual -> oficial por chave estavel
-- Aluno: primeiro apoia_aluno_id, depois matricula.
-- Professor: primeiro apoia_user_uid, depois email.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_enc_cache()
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
    -- =========================
    -- ALUNOS
    -- =========================

    -- 3.1 Atualiza alunos ja vinculados ao oficial (apoia_aluno_id)
    UPDATE public.enc_alunos e
    SET nome_completo = a.nome_completo,
        matricula = a.matricula,
        turma_id = a.turma_id,
        nome_responsavel = a.nome_responsavel,
        telefone = a.telefone,
        status = a.status,
        origem = 'apoia',
        copied_at = now()
    FROM public.alunos a
    WHERE e.apoia_aluno_id = a.id
      AND (
        e.nome_completo IS DISTINCT FROM a.nome_completo OR
        e.matricula IS DISTINCT FROM a.matricula OR
        e.turma_id IS DISTINCT FROM a.turma_id OR
        e.nome_responsavel IS DISTINCT FROM a.nome_responsavel OR
        e.telefone IS DISTINCT FROM a.telefone OR
        e.status IS DISTINCT FROM a.status OR
        e.origem IS DISTINCT FROM 'apoia'
      );

    -- 3.2 Promove cadastro manual para oficial por matricula (sem duplicar)
    UPDATE public.enc_alunos e
    SET apoia_aluno_id = a.id,
        nome_completo = a.nome_completo,
        matricula = a.matricula,
        turma_id = a.turma_id,
        nome_responsavel = a.nome_responsavel,
        telefone = a.telefone,
        status = a.status,
        origem = 'apoia',
        copied_at = now()
    FROM public.alunos a
    WHERE e.apoia_aluno_id IS NULL
      AND nullif(lower(trim(e.matricula)), '') IS NOT NULL
      AND nullif(lower(trim(a.matricula)), '') = nullif(lower(trim(e.matricula)), '')
      AND NOT EXISTS (
        SELECT 1
        FROM public.enc_alunos e2
        WHERE e2.apoia_aluno_id = a.id
      )
      AND e.id = (
        SELECT e3.id
        FROM public.enc_alunos e3
        WHERE e3.apoia_aluno_id IS NULL
          AND nullif(lower(trim(e3.matricula)), '') = nullif(lower(trim(a.matricula)), '')
        ORDER BY CASE WHEN e3.origem = 'manual' THEN 0 ELSE 1 END, e3.id
        LIMIT 1
      );

    -- 3.3 Insere novos do oficial que ainda nao existem no cache
    INSERT INTO public.enc_alunos (
        id, apoia_aluno_id, nome_completo, matricula, turma_id,
        nome_responsavel, telefone, status, origem, copied_at
    )
    SELECT a.id, a.id, a.nome_completo, a.matricula, a.turma_id,
           a.nome_responsavel, a.telefone, a.status, 'apoia', now()
    FROM public.alunos a
    WHERE NOT EXISTS (
        SELECT 1 FROM public.enc_alunos e WHERE e.apoia_aluno_id = a.id
    );

    -- =========================
    -- PROFESSORES
    -- =========================

    -- 3.4 Atualiza professores ja vinculados ao oficial (apoia_user_uid)
    UPDATE public.enc_professores e
    SET nome = u.nome,
        email = u.email,
        telefone = u.telefone,
        status = u.status,
        vinculo = u.vinculo,
        origem = 'apoia',
        copied_at = now()
    FROM public.usuarios u
    WHERE u.papel = 'professor'
      AND e.apoia_user_uid = u.user_uid
      AND (
        e.nome IS DISTINCT FROM u.nome OR
        e.email IS DISTINCT FROM u.email OR
        e.telefone IS DISTINCT FROM u.telefone OR
        e.status IS DISTINCT FROM u.status OR
        e.vinculo IS DISTINCT FROM u.vinculo OR
        e.origem IS DISTINCT FROM 'apoia'
      );

    -- 3.5 Promove manual para oficial por email (normalizado)
    UPDATE public.enc_professores e
    SET apoia_user_uid = u.user_uid,
        nome = u.nome,
        email = u.email,
        telefone = u.telefone,
        status = u.status,
        vinculo = u.vinculo,
        origem = 'apoia',
        copied_at = now()
    FROM public.usuarios u
    WHERE u.papel = 'professor'
      AND e.apoia_user_uid IS NULL
      AND nullif(lower(trim(e.email)), '') IS NOT NULL
      AND nullif(lower(trim(u.email)), '') = nullif(lower(trim(e.email)), '')
      AND NOT EXISTS (
        SELECT 1
        FROM public.enc_professores e2
        WHERE e2.apoia_user_uid = u.user_uid
      )
      AND e.user_uid = (
        SELECT e3.user_uid
        FROM public.enc_professores e3
        WHERE e3.apoia_user_uid IS NULL
          AND nullif(lower(trim(e3.email)), '') = nullif(lower(trim(u.email)), '')
        ORDER BY CASE WHEN e3.origem = 'manual' THEN 0 ELSE 1 END, e3.user_uid
        LIMIT 1
      );

    -- 3.6 Insere novos do oficial que ainda nao existem no cache
    INSERT INTO public.enc_professores (
        user_uid, apoia_user_uid, nome, email, telefone, status, vinculo, origem, copied_at
    )
    SELECT u.user_uid, u.user_uid, u.nome, u.email, u.telefone, u.status, u.vinculo, 'apoia', now()
    FROM public.usuarios u
    WHERE u.papel = 'professor'
      AND NOT EXISTS (
        SELECT 1 FROM public.enc_professores e WHERE e.apoia_user_uid = u.user_uid
      );

    -- =========================
    -- INATIVACAO (somente oficial)
    -- =========================
    UPDATE public.enc_alunos e
    SET status = 'inativo',
        copied_at = now()
    WHERE e.apoia_aluno_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.alunos a WHERE a.id = e.apoia_aluno_id
      );

    UPDATE public.enc_professores e
    SET status = 'inativo',
        copied_at = now()
    WHERE e.apoia_user_uid IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.usuarios u
        WHERE u.user_uid = e.apoia_user_uid
          AND u.papel = 'professor'
      );

    -- Respeita status inativo do oficial.
    UPDATE public.enc_alunos e
    SET status = 'inativo',
        copied_at = now()
    FROM public.alunos a
    WHERE e.apoia_aluno_id = a.id
      AND a.status = 'inativo'
      AND e.status <> 'inativo';

    UPDATE public.enc_professores e
    SET status = 'inativo',
        copied_at = now()
    FROM public.usuarios u
    WHERE e.apoia_user_uid = u.user_uid
      AND u.papel = 'professor'
      AND u.status = 'inativo'
      AND e.status <> 'inativo';
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_enc_cache() TO authenticated;

COMMIT;


-- ===============================================================
-- ENCAMINHAMENTOS: FIXAR TURMA NO MOMENTO DO REGISTRO
-- Garante historico por turma/turno (nao muda quando aluno troca)
-- ===============================================================

CREATE OR REPLACE FUNCTION public.enc_set_turma_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
    IF NEW.turma_id IS NULL THEN
        SELECT ea.turma_id
        INTO NEW.turma_id
        FROM public.enc_alunos ea
        WHERE ea.id = NEW.aluno_id;
    END IF;

    IF NEW.turma_id IS NULL THEN
        RAISE EXCEPTION 'turma_id nao encontrado para aluno %', NEW.aluno_id;
    END IF;

    IF NEW.turma_nome IS NULL THEN
        SELECT t.nome_turma
        INTO NEW.turma_nome
        FROM public.turmas t
        WHERE t.id = NEW.turma_id;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enc_block_turma_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
    IF NEW.turma_id IS DISTINCT FROM OLD.turma_id THEN
        RAISE EXCEPTION 'turma_id nao pode ser alterado. Para corrigir, crie novo registro.';
    END IF;
    RETURN NEW;
END;
$$;

-- Tabela base
DROP TRIGGER IF EXISTS enc_set_turma_on_insert ON public.enc_encaminhamentos;
CREATE TRIGGER enc_set_turma_on_insert
BEFORE INSERT ON public.enc_encaminhamentos
FOR EACH ROW EXECUTE FUNCTION public.enc_set_turma_on_insert();

DROP TRIGGER IF EXISTS enc_block_turma_change ON public.enc_encaminhamentos;
CREATE TRIGGER enc_block_turma_change
BEFORE UPDATE OF turma_id ON public.enc_encaminhamentos
FOR EACH ROW EXECUTE FUNCTION public.enc_block_turma_change();

-- Tabelas por ano (enc_encaminhamentos_YYYY)
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename LIKE 'enc_encaminhamentos_%'
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS enc_set_turma_on_insert ON public.%I;', r.tablename);
        EXECUTE format('CREATE TRIGGER enc_set_turma_on_insert BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.enc_set_turma_on_insert();', r.tablename);

        EXECUTE format('DROP TRIGGER IF EXISTS enc_block_turma_change ON public.%I;', r.tablename);
        EXECUTE format('CREATE TRIGGER enc_block_turma_change BEFORE UPDATE OF turma_id ON public.%I FOR EACH ROW EXECUTE FUNCTION public.enc_block_turma_change();', r.tablename);
    END LOOP;
END $$;

-- ===============================================================
-- CHAMADA (PRESENCAS): FIXAR TURMA NO MOMENTO DO REGISTRO
-- Garante historico por turma/turno (nao muda quando aluno troca)
-- ===============================================================

CREATE OR REPLACE FUNCTION public.presencas_set_turma_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
    IF NEW.turma_id IS NULL THEN
        SELECT a.turma_id
        INTO NEW.turma_id
        FROM public.alunos a
        WHERE a.id = NEW.aluno_id;
    END IF;

    IF NEW.turma_id IS NULL THEN
        RAISE EXCEPTION 'turma_id nao encontrado para aluno %', NEW.aluno_id;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.presencas_block_turma_change()
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

DROP TRIGGER IF EXISTS presencas_set_turma_on_insert ON public.presencas;
CREATE TRIGGER presencas_set_turma_on_insert
BEFORE INSERT ON public.presencas
FOR EACH ROW EXECUTE FUNCTION public.presencas_set_turma_on_insert();

DROP TRIGGER IF EXISTS presencas_block_turma_change ON public.presencas;
CREATE TRIGGER presencas_block_turma_change
BEFORE UPDATE OF turma_id ON public.presencas
FOR EACH ROW EXECUTE FUNCTION public.presencas_block_turma_change();

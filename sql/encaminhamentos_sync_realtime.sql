-- ===============================================================
-- SINCRONIZACAO AUTOMATICA: ALUNOS (CHAMADA -> ENCAMINHAMENTOS)
-- Qualquer alteracao em public.alunos reflete em public.enc_alunos
-- ===============================================================

ALTER TABLE public.enc_alunos
    ADD COLUMN IF NOT EXISTS origem text DEFAULT 'apoia';

ALTER TABLE public.enc_alunos
    ADD COLUMN IF NOT EXISTS copied_at timestamptz;

UPDATE public.enc_alunos SET origem = 'apoia' WHERE origem IS NULL;

CREATE OR REPLACE FUNCTION public.enc_alunos_sync_from_apoia()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        UPDATE public.enc_alunos
        SET status = 'inativo',
            copied_at = now()
        WHERE id = OLD.id
          AND origem = 'apoia';
        RETURN OLD;
    END IF;

    INSERT INTO public.enc_alunos (
        id, nome_completo, matricula, turma_id, nome_responsavel, telefone, status, origem, copied_at
    ) VALUES (
        NEW.id, NEW.nome_completo, NEW.matricula, NEW.turma_id, NEW.nome_responsavel, NEW.telefone, NEW.status, 'apoia', now()
    )
    ON CONFLICT (id) DO UPDATE
    SET nome_completo = EXCLUDED.nome_completo,
        matricula = EXCLUDED.matricula,
        turma_id = EXCLUDED.turma_id,
        nome_responsavel = EXCLUDED.nome_responsavel,
        telefone = EXCLUDED.telefone,
        status = EXCLUDED.status,
        origem = 'apoia',
        copied_at = now()
    WHERE public.enc_alunos.origem = 'apoia';

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS alunos_sync_enc_alunos ON public.alunos;
CREATE TRIGGER alunos_sync_enc_alunos
AFTER INSERT OR UPDATE OR DELETE ON public.alunos
FOR EACH ROW EXECUTE FUNCTION public.enc_alunos_sync_from_apoia();

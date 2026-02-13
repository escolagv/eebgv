-- ===============================================================
-- Vinculo e contrato para professores
-- ===============================================================

ALTER TABLE public.usuarios
    ADD COLUMN IF NOT EXISTS vinculo text;

ALTER TABLE public.usuarios
    ADD COLUMN IF NOT EXISTS contrato_fim date;

UPDATE public.usuarios
SET vinculo = COALESCE(vinculo, 'efetivo');

ALTER TABLE public.usuarios
    ALTER COLUMN vinculo SET DEFAULT 'efetivo';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'usuarios_vinculo_chk'
    ) THEN
        ALTER TABLE public.usuarios
            ADD CONSTRAINT usuarios_vinculo_chk
            CHECK (vinculo IN ('efetivo', 'act'));
    END IF;
END $$;

-- Opcional: inativar professores ACT com contrato expirado
CREATE OR REPLACE FUNCTION public.inativar_professores_act_expirados()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    updated_count integer;
BEGIN
    UPDATE public.usuarios
    SET status = 'inativo'
    WHERE papel = 'professor'
      AND vinculo = 'act'
      AND contrato_fim IS NOT NULL
      AND contrato_fim < CURRENT_DATE
      AND status <> 'inativo';

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$;

-- ===============================================================
-- Registro do horario da chamada
-- ===============================================================

ALTER TABLE public.presencas
    ADD COLUMN IF NOT EXISTS registrado_em timestamptz;

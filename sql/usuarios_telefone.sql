-- ===============================================================
-- Telefone para contato no cadastro de professores
-- ===============================================================

ALTER TABLE public.usuarios
    ADD COLUMN IF NOT EXISTS telefone text;

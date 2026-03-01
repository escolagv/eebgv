-- ===============================================================
-- Forçar troca de senha no primeiro acesso
-- ===============================================================
ALTER TABLE public.usuarios
    ADD COLUMN IF NOT EXISTS precisa_trocar_senha boolean NOT NULL DEFAULT false;

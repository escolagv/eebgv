-- ===============================================================
-- Foto do professor (base64/data URL) no cadastro
-- ===============================================================

ALTER TABLE public.usuarios
    ADD COLUMN IF NOT EXISTS foto_url text;

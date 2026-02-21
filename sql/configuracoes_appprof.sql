-- ===============================================================
-- Configuracoes do App do Professor (versao e APK)
-- ===============================================================

ALTER TABLE public.configuracoes
    ADD COLUMN IF NOT EXISTS appprof_versao text,
    ADD COLUMN IF NOT EXISTS appprof_apk_url text;

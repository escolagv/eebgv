-- ===============================================================
-- SUPORTE A IMAGENS NO DRIVE (COLUNAS + FILA)
-- ===============================================================

-- Colunas no encaminhamento (base)
ALTER TABLE public.enc_encaminhamentos
    ADD COLUMN IF NOT EXISTS foto_drive_url text,
    ADD COLUMN IF NOT EXISTS foto_drive_file_id text,
    ADD COLUMN IF NOT EXISTS foto_storage_path text;

-- Garantir colunas nas tabelas anuais existentes
DO $$
DECLARE
    t record;
BEGIN
    FOR t IN
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename LIKE 'enc_encaminhamentos_%'
    LOOP
        EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS foto_drive_url text', t.tablename);
        EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS foto_drive_file_id text', t.tablename);
        EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS foto_storage_path text', t.tablename);
    END LOOP;
END $$;

-- Fila de imagens enviadas pelo PWA
CREATE TABLE IF NOT EXISTS public.enc_scan_jobs (
    id bigserial PRIMARY KEY,
    status text DEFAULT 'novo',
    storage_path text NOT NULL,
    mime_type text,
    file_size_bytes bigint,
    created_at timestamptz DEFAULT now(),
    uploaded_by uuid,
    device_id text,
    ocr_json jsonb,
    drive_file_id text,
    drive_url text,
    encaminhamento_id bigint
);

ALTER TABLE public.enc_scan_jobs
    ADD COLUMN IF NOT EXISTS file_size_bytes bigint;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.enc_scan_jobs TO authenticated;

ALTER TABLE public.enc_scan_jobs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'enc_scan_jobs'
          AND policyname = 'enc_scan_jobs_admin_all'
    ) THEN
        CREATE POLICY enc_scan_jobs_admin_all
        ON public.enc_scan_jobs
        FOR ALL
        TO authenticated
        USING (public.is_admin(auth.uid()))
        WITH CHECK (public.is_admin(auth.uid()));
    END IF;
END $$;

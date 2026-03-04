-- ===============================================================
-- ATUALIZACAO DO FORMULARIO (CAMPOS WHATSAPP)
-- ===============================================================
-- Executar apos o script base de encaminhamentos.

ALTER TABLE public.enc_encaminhamentos
    ADD COLUMN IF NOT EXISTS whatsapp_enviado boolean,
    ADD COLUMN IF NOT EXISTS whatsapp_status text;

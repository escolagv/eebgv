-- ===============================================================
-- Log de envios de e-mail (confirmação/recuperação)
-- ===============================================================
CREATE TABLE IF NOT EXISTS public.email_envios (
    id bigserial PRIMARY KEY,
    email text NOT NULL,
    tipo text NOT NULL,
    status text NOT NULL,
    detalhe text,
    enviado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_envios_email_idx ON public.email_envios (email);
CREATE INDEX IF NOT EXISTS email_envios_enviado_em_idx ON public.email_envios (enviado_em DESC);


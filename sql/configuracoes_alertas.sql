-- ===============================================================
-- Configuracoes de alertas (faltas e chamadas)
-- ===============================================================

ALTER TABLE public.configuracoes
    ADD COLUMN IF NOT EXISTS faltas_consecutivas integer,
    ADD COLUMN IF NOT EXISTS faltas_intercaladas integer,
    ADD COLUMN IF NOT EXISTS faltas_dias integer,
    ADD COLUMN IF NOT EXISTS alerta_horario time,
    ADD COLUMN IF NOT EXISTS alerta_faltas_ativo boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS alerta_chamada_ativo boolean DEFAULT false;

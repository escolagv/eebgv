-- ===============================================================
-- Relatório unificado: envios x confirmação real (auth)
-- ===============================================================
CREATE OR REPLACE VIEW public.email_envios_relatorio AS
SELECT
    u.id AS usuario_id,
    u.nome,
    u.email,
    u.status AS status_usuario,
    u.vinculo,
    u.email_confirmado,
    a.confirmed_at,
    a.email_confirmed_at,
    (a.confirmed_at IS NOT NULL OR a.email_confirmed_at IS NOT NULL) AS confirmado_no_auth,
    e.tipo AS envio_tipo,
    e.status AS envio_status,
    e.detalhe AS envio_detalhe,
    e.enviado_em
FROM public.usuarios u
LEFT JOIN auth.users a ON a.email = u.email
LEFT JOIN LATERAL (
    SELECT *
    FROM public.email_envios
    WHERE email = u.email
    ORDER BY enviado_em DESC
    LIMIT 1
) e ON TRUE
WHERE u.papel = 'professor';


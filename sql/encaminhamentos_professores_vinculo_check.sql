-- ===============================================================
-- CHECAR VINCULO DOS PROFESSORES (APOIA)
-- ===============================================================
-- Lista valores existentes em usuarios.vinculo para professores

SELECT
    u.vinculo,
    u.status,
    COUNT(*) AS total
FROM public.usuarios u
WHERE u.papel = 'professor'
GROUP BY u.vinculo, u.status
ORDER BY u.vinculo NULLS LAST, u.status;

-- Opcional: listar nomes para validar o preenchimento
-- SELECT u.user_uid, u.nome, u.email, u.vinculo, u.status
-- FROM public.usuarios u
-- WHERE u.papel = 'professor'
-- ORDER BY u.vinculo NULLS LAST, u.nome;

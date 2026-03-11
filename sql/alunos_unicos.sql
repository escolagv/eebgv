-- ===============================================================
-- REGRA: NAO PERMITIR ALUNO DUPLICADO (MESMO NOME + MATRICULA)
-- ===============================================================

-- 1) Verifique duplicados antes (precisa zerar antes de criar o indice)
-- SELECT nome_completo, matricula, COUNT(*)
-- FROM public.alunos
-- WHERE matricula IS NOT NULL AND trim(matricula) <> ''
-- GROUP BY nome_completo, matricula
-- HAVING COUNT(*) > 1;

-- 2) Regra na base APOIA
CREATE UNIQUE INDEX IF NOT EXISTS alunos_nome_matricula_uidx
ON public.alunos (lower(trim(nome_completo)), nullif(trim(matricula), ''))
WHERE matricula IS NOT NULL AND trim(matricula) <> '';

-- 3) (Opcional) Regra na base de encaminhamentos
-- CREATE UNIQUE INDEX IF NOT EXISTS enc_alunos_nome_matricula_uidx
-- ON public.enc_alunos (lower(trim(nome_completo)), nullif(trim(matricula), ''))
-- WHERE matricula IS NOT NULL AND trim(matricula) <> '';

-- ===============================================================
-- Consultas de consistencia e auditoria rapida
-- ===============================================================

-- Turmas duplicadas por nome/ano
SELECT nome_turma, ano_letivo, COUNT(*) AS total
FROM public.turmas
GROUP BY nome_turma, ano_letivo
HAVING COUNT(*) > 1;

-- Turmas duplicadas por codigo/ano (apos adicionar codigo_turma)
SELECT codigo_turma, ano_letivo, COUNT(*) AS total
FROM public.turmas
GROUP BY codigo_turma, ano_letivo
HAVING COUNT(*) > 1;

-- Alunos ativos sem turma
SELECT id, nome_completo
FROM public.alunos
WHERE status = 'ativo' AND turma_id IS NULL;

-- Alunos com turma inexistente
SELECT a.id, a.nome_completo, a.turma_id
FROM public.alunos a
LEFT JOIN public.turmas t ON t.id = a.turma_id
WHERE a.turma_id IS NOT NULL AND t.id IS NULL;

-- Professores sem vinculo de turma
SELECT u.id, u.nome, u.user_uid
FROM public.usuarios u
WHERE u.papel = 'professor'
  AND NOT EXISTS (
      SELECT 1 FROM public.professores_turmas pt
      WHERE pt.professor_id = u.user_uid
  );

-- Professores ACT com contrato expirado
SELECT u.id, u.nome, u.contrato_fim
FROM public.usuarios u
WHERE u.papel = 'professor'
  AND u.vinculo = 'act'
  AND u.contrato_fim IS NOT NULL
  AND u.contrato_fim < CURRENT_DATE;

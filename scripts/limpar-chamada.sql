-- Limpa chamadas de uma turma em um dia específico.
-- Substitua os valores entre <> antes de executar.

DELETE FROM presencas
WHERE data = '<YYYY-MM-DD>'
  AND turma_id = <ID_DA_TURMA>;

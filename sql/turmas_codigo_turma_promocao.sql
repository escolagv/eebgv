-- ===============================================================
-- Codigo de turma + promocao em massa com professores efetivos
-- ===============================================================

-- Normaliza nome da turma em um codigo estavel
CREATE OR REPLACE FUNCTION public.normalizar_codigo_turma(nome text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT regexp_replace(lower(trim(nome)), '[^a-z0-9]+', '_', 'g');
$$;

ALTER TABLE public.turmas
    ADD COLUMN IF NOT EXISTS codigo_turma text;

UPDATE public.turmas
SET codigo_turma = COALESCE(codigo_turma, public.normalizar_codigo_turma(nome_turma))
WHERE codigo_turma IS NULL;

-- Atenção: se houver turmas duplicadas no mesmo ano, ajuste antes deste passo
CREATE UNIQUE INDEX IF NOT EXISTS turmas_codigo_ano_unique
    ON public.turmas (codigo_turma, ano_letivo);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'professores_turmas_unique'
    ) THEN
        ALTER TABLE public.professores_turmas
            ADD CONSTRAINT professores_turmas_unique UNIQUE (professor_id, turma_id);
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.promover_turmas_em_massa(
    origem_turma_ids integer[],
    ano_destino integer,
    promover_professores_efetivos boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
    turma_origem record;
    turma_destino_mesma_id integer;
    turma_destino_promovida_id integer;
    codigo_origem text;
    codigo_promovido text;
    nome_promovido text;
    numero_turma integer;
BEGIN
    FOR turma_origem IN
        SELECT *
        FROM turmas
        WHERE id = ANY(origem_turma_ids)
    LOOP
        codigo_origem := COALESCE(turma_origem.codigo_turma, public.normalizar_codigo_turma(turma_origem.nome_turma));

        -- Sempre cria/garante a turma "espelho" no ano destino.
        INSERT INTO turmas (nome_turma, ano_letivo, codigo_turma)
        VALUES (turma_origem.nome_turma, ano_destino, codigo_origem)
        ON CONFLICT (codigo_turma, ano_letivo) DO UPDATE
            SET nome_turma = EXCLUDED.nome_turma
        RETURNING id INTO turma_destino_mesma_id;

        codigo_promovido := NULL;
        nome_promovido := NULL;

        IF codigo_origem ~ '^[0-9]+$' THEN
            numero_turma := codigo_origem::integer;

            -- Regras de promoção de alunos:
            --  < 100  -> +10   (ex: 94 -> 104)
            -- 100-199 -> +100  (ex: 101 -> 201)
            -- 200-299 -> +100  (ex: 203 -> 303)
            -- >= 300  -> não promove (último ano)
            IF numero_turma < 100 THEN
                numero_turma := numero_turma + 10;
                codigo_promovido := numero_turma::text;
                nome_promovido := numero_turma::text;
            ELSIF numero_turma >= 100 AND numero_turma < 300 THEN
                numero_turma := numero_turma + 100;
                codigo_promovido := numero_turma::text;
                nome_promovido := numero_turma::text;
            END IF;
        ELSIF codigo_origem ILIKE '%multisser%' OR turma_origem.nome_turma ILIKE '%multisser%' THEN
            -- Multisseriada sempre promove para a mesma turma no ano destino.
            codigo_promovido := codigo_origem;
            nome_promovido := turma_origem.nome_turma;
        END IF;

        IF codigo_promovido IS NOT NULL THEN
            INSERT INTO turmas (nome_turma, ano_letivo, codigo_turma)
            VALUES (nome_promovido, ano_destino, codigo_promovido)
            ON CONFLICT (codigo_turma, ano_letivo) DO UPDATE
                SET nome_turma = EXCLUDED.nome_turma
            RETURNING id INTO turma_destino_promovida_id;

            UPDATE alunos
            SET turma_id = turma_destino_promovida_id
            WHERE turma_id = turma_origem.id
              AND status = 'ativo';
        END IF;

        IF promover_professores_efetivos THEN
            INSERT INTO professores_turmas (professor_id, turma_id)
            SELECT pt.professor_id, turma_destino_mesma_id
            FROM professores_turmas pt
            JOIN usuarios u ON u.user_uid = pt.professor_id
            WHERE pt.turma_id = turma_origem.id
              AND u.papel = 'professor'
              AND u.status = 'ativo'
              AND u.vinculo = 'efetivo'
            ON CONFLICT DO NOTHING;
        END IF;
    END LOOP;
END;
$function$;

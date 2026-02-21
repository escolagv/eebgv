const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  // cole a URL do projeto aqui se preferir não usar ENV:
  'https://agivmrhwytnfprsjsvpy.supabase.co';

const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  // cole o role key abaixo entre aspas (evite versionar este arquivo com a chave)
  // 'COLE_A_SERVICE_ROLE_KEY_AQUI';
  '';

if (!SUPABASE_URL) {
  console.error('Cole a SUPABASE_URL no script ou defina como variável de ambiente.');
  process.exit(1);
}

if (!SERVICE_KEY) {
  console.error('Cole sua SUPABASE_SERVICE_ROLE_KEY no script ou defina como variável de ambiente.');
  process.exit(1);
}

function getArgValue(flag, fallback) {
  const found = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (!found) {
    return fallback;
  }
  const value = found.split('=')[1];
  return value ?? fallback;
}

const DELAY_MS = Number(getArgValue('--delay-ms', '180000'));
const LIMIT = Number(getArgValue('--limit', '0'));
const INCLUDE_INATIVOS = process.argv.includes('--include-inativos');
const DRY_RUN = process.argv.includes('--dry-run');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callSupabase(pathname, { method = 'POST', body, headers = {} } = {}) {
  const hasBody = body !== undefined;
  const response = await fetch(`${SUPABASE_URL}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apiKey: SERVICE_KEY,
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    ...(hasBody ? { body: JSON.stringify(body) } : {})
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`${response.status}: ${text}`);
    error.status = response.status;
    error.body = text;
    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function fetchProfessoresNaoConfirmados() {
  let path =
    '/rest/v1/usuarios?select=id,email,email_confirmado,status,papel&papel=eq.professor&email=not.is.null&email_confirmado=eq.false';
  if (!INCLUDE_INATIVOS) {
    path += '&status=eq.ativo';
  }
  if (LIMIT > 0) {
    path += `&limit=${LIMIT}`;
  }
  const data = await callSupabase(path, { method: 'GET' });
  return Array.isArray(data) ? data : [];
}

async function resendConfirmation(email) {
  try {
    await callSupabase('/auth/v1/resend', { body: { type: 'signup', email } });
    return { status: 'sent' };
  } catch (error) {
    const body = String(error.body || error.message || '');
    if (error.status === 429) {
      console.warn(`Rate limit para ${email}. Aguardando ${DELAY_MS / 60000} min e tentando novamente...`);
      await sleep(DELAY_MS);
      await callSupabase('/auth/v1/resend', { body: { type: 'signup', email } });
      return { status: 'sent_after_wait' };
    }
    if (body.toLowerCase().includes('already confirmed')) {
      return { status: 'already_confirmed' };
    }
    throw error;
  }
}

async function main() {
  const professores = await fetchProfessoresNaoConfirmados();
  if (!professores.length) {
    console.log('Nenhum professor com e-mail não confirmado encontrado.');
    return;
  }

  console.log(`Encontrados ${professores.length} professores não confirmados.`);

  let sent = 0;
  let skipped = 0;
  let already = 0;
  for (const prof of professores) {
    const email = (prof.email || '').trim();
    if (!email) {
      skipped += 1;
      continue;
    }
    if (DRY_RUN) {
      console.log(`(dry-run) ${email}`);
      continue;
    }

    try {
      const result = await resendConfirmation(email);
      if (result.status === 'already_confirmed') {
        already += 1;
        console.log(`• ${email} já confirmado (sem envio).`);
      } else {
        sent += 1;
        console.log(`✔ Confirmação enviada para ${email}.`);
      }
    } catch (error) {
      skipped += 1;
      console.error(`Erro ao enviar para ${email}: ${error.message}`);
    }

    await sleep(DELAY_MS);
  }

  console.log(`Resumo: enviados=${sent}, já_confirmados=${already}, falhas=${skipped}`);
}

main().catch((error) => {
  console.error('Erro ao reenviar confirmações:', error);
  process.exit(1);
});

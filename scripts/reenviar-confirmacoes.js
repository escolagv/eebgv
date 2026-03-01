const fs = require('fs');
const path = require('path');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(__dirname, '..', '.env'));

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  // cole a URL do projeto aqui se preferir não usar ENV:
  'https://agivmrhwytnfprsjsvpy.supabase.co';

const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  // cole o role key abaixo entre aspas (evite versionar este arquivo com a chave)
  // 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFnaXZtcmh3eXRuZnByc2pzdnB5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjI1NDc4OCwiZXhwIjoyMDcxODMwNzg4fQ.a20lHVWJhcroy-QNMJjebo974KKmmMmL0rh3LYu-T90';
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

const DELAY_MS = Number(getArgValue('--delay-ms', '300000'));
const LIMIT = Number(getArgValue('--limit', '0'));
const INCLUDE_INATIVOS = process.argv.includes('--include-inativos');
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE_RESEND = process.argv.includes('--force');
const MODE = (getArgValue('--mode', 'confirm') || 'confirm').toLowerCase();
const LOG_FILE = path.join(__dirname, 'reenviar-confirmacoes.log.csv');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logResult(email, status, detail = '') {
  const now = new Date().toISOString();
  const line = `"${now}","${email}","${status}","${detail.replace(/"/g, '""')}"\n`;
  fs.appendFileSync(LOG_FILE, line, 'utf8');
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

  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function logEnvio(email, status, detalhe = '', tipo = 'confirmacao') {
  if (DRY_RUN) return;
  try {
    await callSupabase('/rest/v1/email_envios', {
      method: 'POST',
      body: { email, tipo, status, detalhe },
      headers: { Prefer: 'return=representation' }
    });
  } catch (error) {
    console.warn(`Aviso: falha ao registrar envio no banco para ${email}: ${error.message}`);
  }
}

async function fetchProfessoresNaoConfirmados() {
  let path;
  if (FORCE_RESEND) {
    path = '/rest/v1/usuarios?select=id,email,email_confirmado,status,papel&papel=eq.professor&email=not.is.null';
  } else {
    path = '/rest/v1/usuarios?select=id,email,email_confirmado,status,papel&papel=eq.professor&email=not.is.null&email_confirmado=eq.false';
  }
  if (!INCLUDE_INATIVOS) path += '&status=eq.ativo';
  if (LIMIT > 0) path += `&limit=${LIMIT}`;
  const data = await callSupabase(path, { method: 'GET' });
  return Array.isArray(data) ? data : [];
}

async function fetchAuthConfirmation(email) {
  const data = await callSupabase('/rest/v1/rpc/auth_confirmed_by_email', {
    body: { p_emails: [email] }
  });
  if (!Array.isArray(data) || data.length === 0) {
    return { confirmed: false, found: false };
  }
  return { confirmed: !!data[0].confirmed, found: true };
}

async function markUsuarioConfirmado(email) {
  await callSupabase(`/rest/v1/usuarios?email=eq.${encodeURIComponent(email)}`, {
    method: 'PATCH',
    body: { email_confirmado: true },
    headers: { Prefer: 'return=representation' }
  });
}

async function sendAuthEmail(email, mode) {
  try {
    if (mode === 'recover') {
      await callSupabase('/auth/v1/recover', { body: { email } });
    } else {
      await callSupabase('/auth/v1/resend', { body: { type: 'signup', email } });
    }
    return { status: 'sent' };
  } catch (error) {
    const body = String(error.body || error.message || '');
    if (error.status === 429) {
      console.warn(`Rate limit para ${email}. Aguardando ${DELAY_MS / 60000} min e tentando novamente...`);
      await sleep(DELAY_MS);
      if (mode === 'recover') {
        await callSupabase('/auth/v1/recover', { body: { email } });
      } else {
        await callSupabase('/auth/v1/resend', { body: { type: 'signup', email } });
      }
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

  const modeLabel = MODE === 'recover' ? 'recuperacao' : 'confirmacao';
  console.log(`Encontrados ${professores.length} professores ${FORCE_RESEND ? 'para reenvio' : 'não confirmados'}.`);
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, '"data","email","status","detalhe"\n', 'utf8');
  }

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

    let shouldDelay = false;
    try {
      const authStatus = await fetchAuthConfirmation(email);
      const confirmed = authStatus.confirmed;
      const effectiveMode = confirmed && FORCE_RESEND && MODE === 'confirm' ? 'recover' : MODE;

      if (confirmed && !FORCE_RESEND && MODE === 'confirm') {
        await markUsuarioConfirmado(email);
        already += 1;
        console.log(`• ${email} já confirmado no auth. Marcado no painel.`);
        logResult(email, 'already_confirmed', 'confirmado no auth');
        await logEnvio(email, 'already_confirmed', 'confirmado no auth', modeLabel);
        shouldDelay = false;
      } else {
        const result = await sendAuthEmail(email, effectiveMode);
        if (result.status === 'already_confirmed') {
          await markUsuarioConfirmado(email);
          already += 1;
          console.log(`• ${email} já confirmado (sem envio).`);
          logResult(email, 'already_confirmed', 'resend informou já confirmado');
          await logEnvio(email, 'already_confirmed', 'resend informou já confirmado', modeLabel);
          shouldDelay = false;
        } else {
          sent += 1;
          const label = effectiveMode === 'recover' ? 'Recuperação enviada' : 'Confirmação enviada';
          console.log(`✔ ${label} para ${email}.`);
          logResult(email, 'sent', `${effectiveMode} ok`);
          await logEnvio(email, 'sent', `${effectiveMode} ok`, effectiveMode === 'recover' ? 'recuperacao' : 'confirmacao');
          shouldDelay = result.status === 'sent' || result.status === 'sent_after_wait';
        }
      }
    } catch (error) {
      skipped += 1;
      console.error(`Erro ao enviar para ${email}: ${error.message}`);
      logResult(email, 'error', error.message || 'erro');
      await logEnvio(email, 'error', error.message || 'erro', modeLabel);
      shouldDelay = true;
    }

    if (shouldDelay) {
      await sleep(DELAY_MS);
    }
  }
  console.log(`Resumo: enviados=${sent}, já_confirmados=${already}, falhas=${skipped}`);
}

main().catch((error) => {
  console.error('Erro ao reenviar confirmações:', error);
  process.exit(1);
});

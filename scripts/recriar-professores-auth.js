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
  'https://agivmrhwytnfprsjsvpy.supabase.co';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL) {
  console.error('Defina SUPABASE_URL no .env.');
  process.exit(1);
}
if (!SERVICE_KEY) {
  console.error('Defina SUPABASE_SERVICE_ROLE_KEY no .env.');
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
const FORCE = process.argv.includes('--force');
const SKIP_LOGGED = process.argv.includes('--skip-logged');
const SKIP_DAYS = Number(getArgValue('--skip-days', '7'));
const DEFAULT_PASSWORD = getArgValue('--password', '123456');
const EMAIL_FILTER_RAW = getArgValue('--email', '') || getArgValue('--emails', '');
const EMAIL_FILTER = EMAIL_FILTER_RAW
  ? EMAIL_FILTER_RAW.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
  : [];

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

  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchProfessores() {
  let path =
    '/rest/v1/usuarios?select=id,user_uid,nome,email,telefone,vinculo,status,papel&papel=eq.professor&email=not.is.null';
  if (!INCLUDE_INATIVOS) {
    path += '&status=eq.ativo';
  }
  if (LIMIT > 0) {
    path += `&limit=${LIMIT}`;
  }
  const data = await callSupabase(path, { method: 'GET' });
  return Array.isArray(data) ? data : [];
}

async function wasRecentlyLogged(email) {
  if (!SKIP_LOGGED) return false;
  const since = new Date(Date.now() - SKIP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const path = `/rest/v1/email_envios?select=id&email=eq.${encodeURIComponent(email)}&enviado_em=gte.${encodeURIComponent(since)}&limit=1`;
  const data = await callSupabase(path, { method: 'GET' });
  return Array.isArray(data) && data.length > 0;
}

async function fetchAuthUserUidByEmail(email) {
  try {
    const data = await callSupabase('/rest/v1/rpc/auth_user_uid_by_email', {
      body: { p_email: email }
    });
    if (typeof data === 'string' && data) {
      return data;
    }
    if (Array.isArray(data) && data.length > 0) {
      return data[0];
    }
    return null;
  } catch {
    return null;
  }
}

async function deleteAuthUser(userUid) {
  await callSupabase(`/auth/v1/admin/users/${userUid}`, { method: 'DELETE' });
}

async function createAuthUser({ email, nome, telefone, vinculo }) {
  return callSupabase('/auth/v1/admin/users', {
    body: {
      email,
      password: DEFAULT_PASSWORD,
      email_confirm: false,
      user_metadata: { nome, telefone, vinculo }
    }
  });
}

async function updateUsuario(id, userUid) {
  const data = await callSupabase(`/rest/v1/usuarios?id=eq.${id}`, {
    method: 'PATCH',
    body: { user_uid: userUid, email_confirmado: false, precisa_trocar_senha: true, senha_aviso_count: 0 },
    headers: { Prefer: 'return=representation' }
  });
  return Array.isArray(data) ? data.length > 0 : !!data;
}

async function updateUsuarioByEmail(email, userUid) {
  const data = await callSupabase(`/rest/v1/usuarios?email=eq.${encodeURIComponent(email)}&papel=eq.professor`, {
    method: 'PATCH',
    body: { user_uid: userUid, email_confirmado: false, precisa_trocar_senha: true, senha_aviso_count: 0 },
    headers: { Prefer: 'return=representation' }
  });
  return Array.isArray(data) ? data.length > 0 : !!data;
}

async function insertUsuario(prof, userUid) {
  await callSupabase('/rest/v1/usuarios', {
    method: 'POST',
    body: {
      user_uid: userUid,
      nome: prof.nome || '',
      email: prof.email,
      telefone: prof.telefone || '',
      papel: 'professor',
      status: prof.status || 'ativo',
      vinculo: prof.vinculo || 'efetivo',
      email_confirmado: false,
      precisa_trocar_senha: true,
      senha_aviso_count: 0
    },
    headers: { Prefer: 'return=representation' }
  });
}

async function upsertUsuario(prof, userUid) {
  const payloadRetry = { email: prof.email, userUid };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      let updated = false;
      if (prof.id) {
        updated = await updateUsuario(prof.id, userUid);
      }
      if (!updated) {
        updated = await updateUsuarioByEmail(prof.email, userUid);
      }
      if (!updated) {
        await insertUsuario(prof, userUid);
      }
      return;
    } catch (error) {
      const message = error?.message || '';
      const isFk = message.includes('foreign key') || message.includes('violates foreign key');
      if (isFk && attempt < 2) {
        console.warn(`Aviso: FK ao atualizar ${payloadRetry.email}. Tentando novamente...`);
        await sleep(2000);
        continue;
      }
      throw error;
    }
  }
}

async function replaceUserUid(oldUid, newUid) {
  if (!oldUid || oldUid === newUid) return;
  await callSupabase(`/rest/v1/professores_turmas?professor_id=eq.${oldUid}`, {
    method: 'PATCH',
    body: { professor_id: newUid },
    headers: { Prefer: 'return=representation' }
  });
  await callSupabase(`/rest/v1/presencas?registrado_por_uid=eq.${oldUid}`, {
    method: 'PATCH',
    body: { registrado_por_uid: newUid },
    headers: { Prefer: 'return=representation' }
  });
}

async function sendConfirmation(email) {
  try {
    await callSupabase('/auth/v1/resend', { body: { type: 'signup', email } });
    return { status: 'sent' };
  } catch (error) {
    if (error.status === 429) {
      console.warn(`Rate limit para ${email}. Aguardando ${DELAY_MS / 60000} min e tentando novamente...`);
      await sleep(DELAY_MS);
      await callSupabase('/auth/v1/resend', { body: { type: 'signup', email } });
      return { status: 'sent_after_wait' };
    }
    throw error;
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

async function main() {
  if (!DRY_RUN && !FORCE) {
    console.error('Use --force para recriar os professores no auth.');
    process.exit(1);
  }

  const professores = await fetchProfessores();
  if (!professores.length) {
    console.log('Nenhum professor encontrado.');
    return;
  }

  let selecionados = professores;
  if (EMAIL_FILTER.length > 0) {
    const filtroSet = new Set(EMAIL_FILTER);
    selecionados = professores.filter((prof) => {
      const email = (prof.email || '').trim().toLowerCase();
      return email && filtroSet.has(email);
    });
    if (!selecionados.length) {
      console.log('Nenhum professor encontrado para os e-mails informados.');
      return;
    }
  }

  console.log(`Encontrados ${selecionados.length} professores para recriar no auth.`);

  for (let i = 0; i < selecionados.length; i += 1) {
    const prof = selecionados[i];
    const email = (prof.email || '').trim();
    if (!email) continue;
    if (DRY_RUN) {
      console.log(`(dry-run) ${email}`);
      continue;
    }
    if (await wasRecentlyLogged(email)) {
      console.log(`• ${email} já teve envio recente. Pulando.`);
      await logEnvio(email, 'skipped', `envio recente (<= ${SKIP_DAYS} dias)`);
      continue;
    }

    try {
      const existingUid = await fetchAuthUserUidByEmail(email);
      const oldUid = prof.user_uid || existingUid || null;
      if (existingUid) await deleteAuthUser(existingUid);

      const created = await createAuthUser({
        email,
        nome: prof.nome || '',
        telefone: prof.telefone || '',
        vinculo: prof.vinculo || 'efetivo'
      });

      const newUid = created?.id || created?.user?.id || null;
      if (!newUid) {
        console.error(`Falha ao recriar ${email}: uid não retornado.`);
        await logEnvio(email, 'error', 'uid não retornado');
        continue;
      }

      await replaceUserUid(oldUid, newUid);
      await upsertUsuario(prof, newUid);
      const result = await sendConfirmation(email);
      await logEnvio(email, 'sent', `confirmacao ${result.status}`);
      console.log(`✔ Confirmação enviada para ${email}.`);
    } catch (error) {
      console.error(`Erro em ${email}: ${error.message}`);
      await logEnvio(email, 'error', error.message || 'erro');
    }

    const isLast = i === selecionados.length - 1;
    if (!isLast && DELAY_MS > 0) {
      await sleep(DELAY_MS);
    }
  }
}

main().catch((error) => {
  console.error('Erro geral:', error);
  process.exit(1);
});

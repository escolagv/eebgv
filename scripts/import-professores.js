const fs = require('fs');
const path = require('path');
const csvParse = require('csv-parse/sync');

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  // cole a URL do projeto aqui se preferir não usar ENV:
  'https://agivmrhwytnfprsjsvpy.supabase.co';

const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  // cole o role key abaixo entre aspas (evite versionar este arquivo com a chave)
  // 'COLE_A_SERVICE_ROLE_KEY_AQUI';
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFnaXZtcmh3eXRuZnByc2pzdnB5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjI1NDc4OCwiZXhwIjoyMDcxODMwNzg4fQ.a20lHVWJhcroy-QNMJjebo974KKmmMmL0rh3LYu-T90';

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

const SEND_CONFIRMATION = !process.argv.includes('--no-confirmation');
const CONFIRM_DELAY_MS = Number(getArgValue('--delay-ms', '180000'));

function getProjectRefFromKey(key) {
  const parts = (key || '').split('.');
  if (parts.length !== 3) {
    return null;
  }
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(payload, 'base64').toString('utf8');
    const data = JSON.parse(json);
    return data.ref || null;
  } catch {
    return null;
  }
}

const keyRef = getProjectRefFromKey(SERVICE_KEY);
if (keyRef && !SUPABASE_URL.includes(`${keyRef}.supabase.co`)) {
  console.error(
    `A service_role parece ser de outro projeto (ref: ${keyRef}). Ajuste SUPABASE_URL para https://${keyRef}.supabase.co ou use a chave correta.`
  );
  process.exit(1);
}

function normalizePhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  return digits;
}

function isMarked(value) {
  return (value || '').toString().trim().toLowerCase().startsWith('x');
}

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
    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function sendConfirmation(email) {
  try {
    await callSupabase('/auth/v1/resend', { body: { type: 'signup', email } });
  } catch (error) {
    if (error.status === 429) {
      console.warn(`Rate limit no envio de confirmação para ${email}. Aguardando ${CONFIRM_DELAY_MS / 60000} min e tentando novamente...`);
      await sleep(CONFIRM_DELAY_MS);
      await callSupabase('/auth/v1/resend', { body: { type: 'signup', email } });
      return;
    }
    throw error;
  }
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
  } catch (error) {
    console.warn(`Aviso: não foi possível buscar user_uid no auth para ${email}.`);
    return null;
  }
}

async function getUsuarioByEmail(email) {
  const path = `/rest/v1/usuarios?select=id,user_uid,nome,email,telefone,vinculo,status,papel,email_confirmado&email=eq.${encodeURIComponent(email)}&limit=1`;
  const data = await callSupabase(path, { method: 'GET' });
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function upsertUsuario({ user_uid, nome, email, telefone, vinculo, status }) {
  const existing = await getUsuarioByEmail(email);
  if (existing) {
    const payload = {
      nome: existing.nome || nome || null,
      telefone: existing.telefone || telefone || null,
      vinculo: existing.vinculo || vinculo || null,
      papel: existing.papel || 'professor',
      status: status || existing.status || 'ativo',
      email_confirmado: existing.email_confirmado ?? false
    };
    if (!existing.user_uid && user_uid) {
      payload.user_uid = user_uid;
    }
    await callSupabase(`/rest/v1/usuarios?email=eq.${encodeURIComponent(email)}`, {
      method: 'PATCH',
      body: payload,
      headers: { Prefer: 'return=representation' }
    });
    return { action: 'update' };
  }

  if (!user_uid) {
    return { action: 'skip_no_user_uid' };
  }

  await callSupabase('/rest/v1/usuarios', {
    method: 'POST',
    body: {
      user_uid,
      nome,
      email,
      telefone,
      papel: 'professor',
      status: status || 'ativo',
      vinculo,
      email_confirmado: false
    },
    headers: { Prefer: 'return=representation' }
  });
  return { action: 'insert' };
}

async function createProfessor(record) {
  const email = (record['e-mail'] || '').trim();
  if (!email) {
    throw new Error('Email obrigatório');
  }

  const vinculo = isMarked(record.ACT) ? 'act' : 'efetivo';
  const status = isMarked(record.Chamada || record.chamada || record.CHAMADA) ? 'ativo' : 'inativo';
  const nome = (record.nome || '').trim();
  const telefone = normalizePhone(record.telefone);

  const payload = {
    email,
    password: '123456',
    email_confirm: false,
    user_metadata: { nome, telefone, vinculo }
  };

  let userUid = null;
  try {
    const created = await callSupabase('/auth/v1/admin/users', { body: payload });
    userUid = created?.id || created?.user?.id || null;
  } catch (error) {
    const message = String(error.message || '');
    if (!(message.includes('already') || message.includes('exists') || message.includes('duplicate'))) {
      throw error;
    }
  }

  if (!userUid) {
    userUid = await fetchAuthUserUidByEmail(email);
  }

  const usuarioResult = await upsertUsuario({ user_uid: userUid, nome, email, telefone, vinculo, status });

  if (SEND_CONFIRMATION) {
    await sendConfirmation(email);
  }

  console.log(`✔ ${email} (${vinculo}/${status}) processado (${usuarioResult.action}).`);
}

async function main() {
  const csvFile = process.argv[2] || path.join(__dirname, '../dados professores apoia.CSV');
  if (!fs.existsSync(csvFile)) {
    console.error(`Arquivo ${csvFile} não encontrado.`);
    process.exit(1);
  }

  const source = fs.readFileSync(csvFile, 'utf8');
  const records = csvParse.parse(source, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    delimiter: ';'
  });

  for (const [index, row] of records.entries()) {
    try {
      await createProfessor(row);
    } catch (error) {
      console.error(`Linha ${index + 1}: ${error.message}`);
    }
    await sleep(SEND_CONFIRMATION ? CONFIRM_DELAY_MS : 1500);
  }
}

main().catch((error) => {
  console.error('Erro na importação:', error);
  process.exit(1);
});

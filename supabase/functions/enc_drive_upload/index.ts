import { serve } from 'https://deno.land/std@0.192.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SignJWT, importPKCS8 } from 'https://esm.sh/jose@5.6.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function cleanSecretValue(value?: string | null) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

async function requestAccessToken(clientEmail: string, privateKey: string, subject: string) {
  const now = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(privateKey, 'RS256');
  const jwt = await new SignJWT({
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(clientEmail)
    .setSubject(subject)
    .sign(key);

  const form = new URLSearchParams();
  form.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  form.set('assertion', jwt);

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  const tokenJson = await tokenResp.json();
  if (!tokenResp.ok) throw new Error(tokenJson?.error_description || 'Falha ao obter token do Google.');
  return {
    accessToken: tokenJson.access_token as string,
    subjectUsed: subject
  };
}

async function requestAccessTokenFromRefreshToken(clientId: string, clientSecret: string, refreshToken: string) {
  const form = new URLSearchParams();
  form.set('client_id', clientId);
  form.set('client_secret', clientSecret);
  form.set('refresh_token', refreshToken);
  form.set('grant_type', 'refresh_token');

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  const tokenJson = await tokenResp.json();
  if (!tokenResp.ok) throw new Error(tokenJson?.error_description || tokenJson?.error || 'Falha ao obter token OAuth.');
  return {
    accessToken: tokenJson.access_token as string
  };
}

async function getAccessToken(clientEmail: string, privateKey: string, delegatedUser?: string) {
  const normalizedClientEmail = cleanSecretValue(clientEmail);
  const normalizedDelegated = cleanSecretValue(delegatedUser);
  const normalizedPrivateKey = String(privateKey || '').replace(/\\n/g, '\n').replace(/\r\n/g, '\n');

  if (normalizedDelegated) {
    try {
      return await requestAccessToken(normalizedClientEmail, normalizedPrivateKey, normalizedDelegated);
    } catch (err: any) {
      const msg = String(err?.message || '').toLowerCase();
      const invalidDelegated = /invalid email or user id|invalid_grant/.test(msg);
      if (!invalidDelegated) throw err;
    }
  }

  return await requestAccessToken(normalizedClientEmail, normalizedPrivateKey, normalizedClientEmail);
}

async function resolveDriveAccessToken(config: {
  clientEmail?: string | null,
  privateKey?: string | null,
  delegatedUser?: string | null,
  oauthClientId?: string | null,
  oauthClientSecret?: string | null,
  oauthRefreshToken?: string | null,
  allowServiceFallback?: boolean
}) {
  const normalizedOAuthClientId = cleanSecretValue(config.oauthClientId);
  const normalizedOAuthClientSecret = cleanSecretValue(config.oauthClientSecret);
  const normalizedOAuthRefreshToken = cleanSecretValue(config.oauthRefreshToken);
  const hasOAuth = !!normalizedOAuthClientId && !!normalizedOAuthClientSecret && !!normalizedOAuthRefreshToken;

  const normalizedClientEmail = cleanSecretValue(config.clientEmail);
  const normalizedPrivateKey = cleanSecretValue(config.privateKey);
  const normalizedDelegated = cleanSecretValue(config.delegatedUser);
  const hasService = !!normalizedClientEmail && !!normalizedPrivateKey;
  const allowServiceFallback = !!config.allowServiceFallback;

  let oauthError = '';
  if (hasOAuth) {
    try {
      const token = await requestAccessTokenFromRefreshToken(
        normalizedOAuthClientId,
        normalizedOAuthClientSecret,
        normalizedOAuthRefreshToken
      );
      return {
        accessToken: token.accessToken,
        subjectUsed: null,
        authMode: 'oauth_refresh'
      };
    } catch (err: any) {
      oauthError = String(err?.message || err || '');
      if (!allowServiceFallback) {
        throw new Error(`OAuth refresh token falhou: ${oauthError}`);
      }
    }
  }

  let serviceError = '';
  if (hasService) {
    try {
      const token = await getAccessToken(
        normalizedClientEmail,
        normalizedPrivateKey,
        normalizedDelegated
      );
      return {
        accessToken: token.accessToken,
        subjectUsed: token.subjectUsed || null,
        authMode: 'service_account'
      };
    } catch (err: any) {
      serviceError = String(err?.message || err || '');
    }
  }

  const parts = [];
  if (oauthError) parts.push(`OAuth: ${oauthError}`);
  if (serviceError) parts.push(`Service: ${serviceError}`);
  const msg = parts.length ? parts.join(' | ') : 'Falha ao autenticar no Google.';
  throw new Error(msg);
}

async function findOrCreateFolder(accessToken: string, name: string, parentId: string) {
  const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${name}' and '${parentId}' in parents and trashed=false`);
  const listResp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,driveId,createdTime)&orderBy=createdTime&corpora=allDrives&includeItemsFromAllDrives=true&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const listJson = await listResp.json();
  if (listJson.files && listJson.files.length > 0) return listJson.files[0].id;

  const createResp = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    })
  });
  const createJson = await createResp.json();
  if (!createResp.ok) throw new Error(createJson?.error?.message || 'Falha ao criar pasta.');
  return createJson.id;
}

function escapeDriveQueryValue(value: string) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function normalizeStoragePath(path: string) {
  const raw = String(path || '').trim().replace(/^\/+/, '');
  if (!raw) return '';
  return raw.replace(/^enc_temp\//i, '');
}

function buildStoragePathCandidates(path: string) {
  const raw = String(path || '').trim().replace(/^\/+/, '');
  if (!raw) return [];
  const normalized = normalizeStoragePath(raw);
  const prefixed = normalized ? `enc_temp/${normalized}` : '';

  const ordered: string[] = [];
  if (/^enc_temp\//i.test(raw)) {
    ordered.push(raw, normalized, prefixed);
  } else {
    ordered.push(prefixed, raw, normalized);
  }
  return Array.from(new Set(ordered.filter(Boolean)));
}

async function cleanupSupabaseResidue(
  supaAdmin: ReturnType<typeof createClient>,
  candidates: string[],
  driveFileId: string | null,
  driveUrl: string | null
) {
  const uniqCandidates = Array.from(new Set((candidates || []).filter(Boolean)));
  if (!uniqCandidates.length) return;

  try {
    await supaAdmin
      .from('enc_scan_jobs')
      .update({
        drive_file_id: driveFileId,
        drive_url: driveUrl,
        status: 'vinculado'
      })
      .in('storage_path', uniqCandidates);
  } catch (err) {
    console.warn('Falha ao atualizar enc_scan_jobs na limpeza:', err);
  }

  try {
    await supaAdmin.storage.from('enc_temp').remove(uniqCandidates);
  } catch (err) {
    console.warn('Falha ao remover arquivos do enc_temp na limpeza:', err);
  }
}

async function findFileByNameInFolder(accessToken: string, name: string, parentId: string) {
  const safeName = escapeDriveQueryValue(name);
  const safeParent = escapeDriveQueryValue(parentId);
  const q = encodeURIComponent(`name='${safeName}' and '${safeParent}' in parents and trashed=false`);
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,webViewLink,driveId)&pageSize=1&corpora=allDrives&includeItemsFromAllDrives=true&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json?.error?.message || 'Falha ao consultar arquivo no Drive.');
  return (json?.files && json.files.length > 0) ? json.files[0] : null;
}

async function getFileMeta(accessToken: string, fileId: string) {
  const safeId = encodeURIComponent(String(fileId || '').trim());
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${safeId}?fields=id,name,mimeType,driveId,parents&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json?.error?.message || 'Falha ao consultar metadados da pasta raiz no Drive.');
  return json;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const driveClientEmail = Deno.env.get('GDRIVE_CLIENT_EMAIL');
    const drivePrivateKey = Deno.env.get('GDRIVE_PRIVATE_KEY');
    const driveRootFolder = Deno.env.get('GDRIVE_ROOT_FOLDER_ID');
    const delegatedUser = Deno.env.get('GDRIVE_DELEGATED_USER') || '';
    const driveClientId = Deno.env.get('GDRIVE_CLIENT_ID');
  const driveClientSecret = Deno.env.get('GDRIVE_CLIENT_SECRET');
  const driveRefreshToken = Deno.env.get('GDRIVE_REFRESH_TOKEN');
  const allowServiceFallback = String(Deno.env.get('GDRIVE_ALLOW_SERVICE_FALLBACK') || '').trim().toLowerCase() === 'true';

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return new Response(JSON.stringify({ error: 'Missing Supabase env vars.', stage: 'env_supabase' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const hasOAuth = !!cleanSecretValue(driveClientId) && !!cleanSecretValue(driveClientSecret) && !!cleanSecretValue(driveRefreshToken);
    const hasService = !!cleanSecretValue(driveClientEmail) && !!cleanSecretValue(drivePrivateKey);
    if (!driveRootFolder || (!hasOAuth && !hasService)) {
      return new Response(JSON.stringify({ error: 'Missing Google Drive env vars.', stage: 'env_drive' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const authHeader = req.headers.get('Authorization') ?? '';
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized.', stage: 'auth_user' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false }
    });
    const { data: adminProfile } = await adminClient
      .from('usuarios')
      .select('papel, status')
      .eq('user_uid', userData.user.id)
      .maybeSingle();
    if (!adminProfile || !['admin', 'suporte'].includes(adminProfile.papel) || adminProfile.status !== 'ativo') {
      return new Response(JSON.stringify({ error: 'Forbidden.', stage: 'auth_profile' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const payload = await req.json();
    const storagePath = payload?.storage_path as string;
    const codigo = payload?.codigo as string;
    const dataEncaminhamento = payload?.data_encaminhamento as string;
    const mimeType = payload?.mime_type || 'image/jpeg';

    if (!storagePath || !codigo || !dataEncaminhamento) {
      return new Response(JSON.stringify({ error: 'Missing storage_path, codigo or data_encaminhamento.', stage: 'payload' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    let accessToken = '';
    let accessTokenSubject = '';
    let accessTokenMode = '';
    const normalizedServiceEmail = cleanSecretValue(driveClientEmail).toLowerCase();
    try {
      const tokenData = await resolveDriveAccessToken({
        clientEmail: driveClientEmail,
        privateKey: drivePrivateKey,
        delegatedUser,
        oauthClientId: driveClientId,
        oauthClientSecret: driveClientSecret,
        oauthRefreshToken: driveRefreshToken,
        allowServiceFallback
      });
      accessToken = tokenData.accessToken;
      accessTokenSubject = tokenData.subjectUsed || '';
      accessTokenMode = tokenData.authMode || '';
    } catch (tokenErr: any) {
      return new Response(JSON.stringify({
        error: tokenErr?.message || 'Falha ao autenticar no Google.',
        stage: 'google_auth',
        delegated_user: cleanSecretValue(delegatedUser) || null,
        auth_mode: hasOAuth
          ? (allowServiceFallback ? 'oauth_refresh_then_service' : 'oauth_refresh_only')
          : 'service_account'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const supaAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    const year = dataEncaminhamento.slice(0, 4);
    const month = dataEncaminhamento.slice(5, 7);
    let monthFolder = '';
    let filename = `${codigo}.jpg`;
    let existingFile: any = null;
    let rootIsShared = false;
    try {
      const rootMeta = await getFileMeta(accessToken, driveRootFolder);
      rootIsShared = !!rootMeta?.driveId;
      const subjectNormalized = cleanSecretValue(accessTokenSubject).toLowerCase();
      const pureServiceToken = accessTokenMode === 'service_account'
        && (!subjectNormalized || subjectNormalized === normalizedServiceEmail);
      if (!rootIsShared && pureServiceToken) {
        return new Response(JSON.stringify({
          error: 'Pasta raiz está no Meu Drive e o token ativo é de Service Account sem delegação válida. Configure OAuth de usuário (refresh token) ou use Shared Drive.',
          stage: 'drive_oauth_required_my_drive',
          root_folder_id: driveRootFolder,
          auth_mode: accessTokenMode || null,
          token_subject_used: accessTokenSubject || null,
          has_oauth_configured: hasOAuth,
          has_service_configured: hasService
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      const rootName = String(rootMeta?.name || '').trim();
      const rootIsYearFolder = rootName === year;
      const rootIsMonthFolder = rootName === month;

      if (rootIsMonthFolder) {
        monthFolder = driveRootFolder;
      } else {
        const yearFolder = rootIsYearFolder
          ? driveRootFolder
          : await findOrCreateFolder(accessToken, year, driveRootFolder);
        monthFolder = await findOrCreateFolder(accessToken, month, yearFolder);
      }

      existingFile = await findFileByNameInFolder(accessToken, filename, monthFolder);
    } catch (driveErr: any) {
      const driveMsg = String(driveErr?.message || '').trim();
      const isRootMissing = /file not found/i.test(driveMsg) || /notfound/i.test(driveMsg);
      return new Response(JSON.stringify({
        error: driveErr?.message || 'Falha na integração com Google Drive.',
        stage: isRootMissing ? 'drive_root_missing_or_no_access' : 'drive_api',
        root_folder_id: driveRootFolder
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const candidates = buildStoragePathCandidates(storagePath);
    if (existingFile?.id) {
      await cleanupSupabaseResidue(
        supaAdmin,
        candidates,
        existingFile.id,
        existingFile.webViewLink || `https://drive.google.com/file/d/${existingFile.id}/view`
      );
      return new Response(JSON.stringify({
        file_id: existingFile.id,
        webViewLink: existingFile.webViewLink || `https://drive.google.com/file/d/${existingFile.id}/view`,
        already_exists: true
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    let fileData: Blob | null = null;
    let lastError: any = null;
    for (const candidate of candidates) {
      const { data, error } = await supaAdmin.storage.from('enc_temp').download(candidate);
      if (!error && data) {
        fileData = data;
        lastError = null;
        break;
      }
      lastError = error || new Error('Arquivo não encontrado no bucket.');
    }
    if (!fileData) {
      return new Response(JSON.stringify({
        error: lastError?.message || 'Falha ao baixar arquivo.',
        stage: 'storage_download',
        storage_path: storagePath,
        tried_paths: candidates
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const arrayBuffer = await fileData.arrayBuffer();

    const boundary = '-------supabase-boundary';
    const metadata = {
      name: filename,
      parents: [monthFolder]
    };
    const body = new Uint8Array([
      ...new TextEncoder().encode(`--${boundary}\r\n` +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) + '\r\n'),
      ...new TextEncoder().encode(`--${boundary}\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`),
      ...new Uint8Array(arrayBuffer),
      ...new TextEncoder().encode(`\r\n--${boundary}--`)
    ]);

    const uploadResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,driveId&supportsAllDrives=true', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body
    });
    const uploadJson = await uploadResp.json();
    if (!uploadResp.ok) {
      const driveMessage = String(uploadJson?.error?.message || '');
      const quotaError = /service accounts do not have storage quota/i.test(driveMessage);
      return new Response(JSON.stringify({
        error: uploadJson?.error?.message || 'Falha ao enviar para o Drive.',
        stage: quotaError ? 'drive_quota_my_drive' : 'drive_upload',
        drive_error: uploadJson?.error || null,
        root_is_shared: rootIsShared,
        auth_mode: accessTokenMode || null,
        delegated_user: cleanSecretValue(delegatedUser) || null,
        token_subject_used: accessTokenSubject || null,
        has_oauth_configured: hasOAuth,
        has_service_configured: hasService
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Permitir acesso via link
    await fetch(`https://www.googleapis.com/drive/v3/files/${uploadJson.id}/permissions?supportsAllDrives=true`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ role: 'reader', type: 'anyone' })
    });

    await cleanupSupabaseResidue(
      supaAdmin,
      candidates,
      uploadJson.id || null,
      uploadJson.webViewLink || null
    );

    return new Response(JSON.stringify({
      file_id: uploadJson.id,
      webViewLink: uploadJson.webViewLink,
      already_exists: false
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('enc_drive_upload unexpected:', err?.message || err, err?.stack || null);
    return new Response(JSON.stringify({
      error: err?.message || 'Unexpected error.',
      stage: 'unexpected',
      error_type: err?.name || 'Error'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

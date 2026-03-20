import { serve } from 'https://deno.land/std@0.192.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SignJWT, importPKCS8 } from 'https://esm.sh/jose@5.6.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

async function getAccessToken(clientEmail: string, privateKey: string) {
  const now = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(privateKey, 'RS256');
  const jwt = await new SignJWT({
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(clientEmail)
    .setSubject(clientEmail)
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
  return tokenJson.access_token as string;
}

async function findOrCreateFolder(accessToken: string, name: string, parentId: string) {
  const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${name}' and '${parentId}' in parents and trashed=false`);
  const listResp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const listJson = await listResp.json();
  if (listJson.files && listJson.files.length > 0) return listJson.files[0].id;

  const createResp = await fetch('https://www.googleapis.com/drive/v3/files', {
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

async function findFileByNameInFolder(accessToken: string, name: string, parentId: string) {
  const safeName = escapeDriveQueryValue(name);
  const safeParent = escapeDriveQueryValue(parentId);
  const q = encodeURIComponent(`name='${safeName}' and '${safeParent}' in parents and trashed=false`);
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,webViewLink)&pageSize=1`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json?.error?.message || 'Falha ao consultar arquivo no Drive.');
  return (json?.files && json.files.length > 0) ? json.files[0] : null;
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

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return new Response(JSON.stringify({ error: 'Missing Supabase env vars.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (!driveClientEmail || !drivePrivateKey || !driveRootFolder) {
      return new Response(JSON.stringify({ error: 'Missing Google Drive env vars.' }), {
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
      return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
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
      return new Response(JSON.stringify({ error: 'Forbidden.' }), {
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
      return new Response(JSON.stringify({ error: 'Missing storage_path, codigo or data_encaminhamento.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supaAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const { data: fileData, error: fileError } = await supaAdmin.storage.from('enc_temp').download(storagePath);
    if (fileError || !fileData) {
      return new Response(JSON.stringify({ error: fileError?.message || 'Falha ao baixar arquivo.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const arrayBuffer = await fileData.arrayBuffer();
    const accessToken = await getAccessToken(driveClientEmail, drivePrivateKey.replace(/\\n/g, '\n'));

    const year = dataEncaminhamento.slice(0, 4);
    const month = dataEncaminhamento.slice(5, 7);
    const yearFolder = await findOrCreateFolder(accessToken, year, driveRootFolder);
    const monthFolder = await findOrCreateFolder(accessToken, month, yearFolder);

    const filename = `${codigo}.jpg`;
    const existingFile = await findFileByNameInFolder(accessToken, filename, monthFolder);
    if (existingFile?.id) {
      return new Response(JSON.stringify({
        file_id: existingFile.id,
        webViewLink: existingFile.webViewLink || `https://drive.google.com/file/d/${existingFile.id}/view`,
        already_exists: true
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

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

    const uploadResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body
    });
    const uploadJson = await uploadResp.json();
    if (!uploadResp.ok) {
      return new Response(JSON.stringify({ error: uploadJson?.error?.message || 'Falha ao enviar para o Drive.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Permitir acesso via link
    await fetch(`https://www.googleapis.com/drive/v3/files/${uploadJson.id}/permissions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ role: 'reader', type: 'anyone' })
    });

    return new Response(JSON.stringify({
      file_id: uploadJson.id,
      webViewLink: uploadJson.webViewLink,
      already_exists: false
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || 'Unexpected error.' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

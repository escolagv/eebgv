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
    scope: 'https://www.googleapis.com/auth/cloud-vision',
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

function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function normalizeText(value: string) {
  return (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractValueAfterLabel(text: string, pattern: RegExp) {
  const match = (text || '').match(pattern);
  if (!match) return '';
  return (match[1] || '').replace(/^[\s:;.,|_-]+/, '').trim();
}

function extractFieldFromLines(lines: string[], pattern: RegExp, labelPattern: RegExp) {
  for (let i = 0; i < lines.length; i += 1) {
    const raw = (lines[i] || '').trim();
    if (!raw) continue;
    const normalized = normalizeText(raw);
    const directValue = extractValueAfterLabel(raw, pattern);
    if (directValue) return directValue;
    if (!labelPattern.test(normalized)) continue;
    const next = (lines[i + 1] || '').trim();
    if (next && !labelPattern.test(normalizeText(next))) return next;
  }
  return '';
}

function extractDateFromText(text: string) {
  const raw = (text || '').trim();
  if (!raw) return '';
  const match = raw.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
  if (match) return match[0];
  const isoMatch = raw.match(/\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/);
  if (isoMatch) return isoMatch[0];
  return '';
}

function extractHeaderFields(rawText: string) {
  const lines = (rawText || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const professorLabelPattern = /(?:professor|profes+sor|profe+sor|profes0r|profesor)/;
  const alunoLabelPattern = /(?:aluno|alun0|estudante|estudant[ea3]?)/;
  const matriculaLabelPattern = /(?:matricula|matricu1a|matricuia|matr1cula|matri?cula)/;
  const dataLabelPattern = /(?:data|dat[a4])/;

  const professor = extractFieldFromLines(lines, /prof(?:e|o|0)?s{1,2}or(?:\(a\))?\s*[:;\-_.|]*\s*(.*)$/i, professorLabelPattern);
  const estudante = extractFieldFromLines(lines, /(?:estudante|aluno)\s*[:;\-_.|]*\s*(.*)$/i, alunoLabelPattern);
  let matricula = extractFieldFromLines(lines, /matr(?:[íi]cula|icula|icu1a|icuia)\s*[:;\-_.|]*\s*(.*)$/i, matriculaLabelPattern);
  let data = extractFieldFromLines(lines, /data\s*[:;\-_.|]*\s*(.*)$/i, dataLabelPattern);

  if (!matricula) {
    const match = rawText.match(/matr[íi]cula[^\d]*([0-9]{4,})/i);
    if (match) matricula = match[1];
  }
  if (!data) {
    const dateMatch = rawText.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
    if (dateMatch) data = dateMatch[0];
  }

  if (matricula) matricula = matricula.replace(/\D+/g, '').trim();
  return { professor, estudante, matricula, data };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const visionCredsRaw = Deno.env.get('GOOGLE_VISION_CREDENTIALS');

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return new Response(JSON.stringify({ error: 'Missing Supabase env vars.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (!visionCredsRaw) {
      return new Response(JSON.stringify({ error: 'Missing GOOGLE_VISION_CREDENTIALS.' }), {
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
    if (!adminProfile || adminProfile.status !== 'ativo' || !['admin', 'suporte'].includes(adminProfile.papel)) {
      return new Response(JSON.stringify({ error: 'Forbidden.' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const payload = await req.json();
    const storagePath = payload?.storage_path as string;
    if (!storagePath) {
      return new Response(JSON.stringify({ error: 'Missing storage_path.' }), {
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

    const creds = JSON.parse(visionCredsRaw);
    const clientEmail = creds.client_email;
    const privateKey = String(creds.private_key || '').replace(/\\n/g, '\n');
    if (!clientEmail || !privateKey) {
      return new Response(JSON.stringify({ error: 'Invalid GOOGLE_VISION_CREDENTIALS.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const accessToken = await getAccessToken(clientEmail, privateKey);
    const content = toBase64(arrayBuffer);

    const visionResp = await fetch('https://vision.googleapis.com/v1/images:annotate', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requests: [
          {
            image: { content },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION' }]
          }
        ]
      })
    });
    const visionJson = await visionResp.json();
    if (!visionResp.ok) {
      return new Response(JSON.stringify({ error: visionJson?.error?.message || 'Falha no OCR do Vision.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const rawText = visionJson?.responses?.[0]?.fullTextAnnotation?.text || '';
    const fields = extractHeaderFields(rawText);

    return new Response(JSON.stringify({
      fields,
      raw_text: rawText
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || 'Unexpected error.' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

import { serve } from 'https://deno.land/std@0.192.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SignJWT, importPKCS8 } from 'https://esm.sh/jose@5.6.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function respondError(status: number, message: string, details?: unknown) {
  const payload: Record<string, unknown> = { error: message };
  if (details) payload.details = details;
  console.error('enc_vision_ocr error:', message, details ?? '');
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

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

function cleanHeaderName(value: string) {
  return (value || '')
    .replace(/[|_]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;.,|_-]+/, '')
    .trim();
}

function isLikelyPersonName(value: string) {
  const text = cleanHeaderName(value);
  if (!text) return false;
  if (/\d/.test(text)) return false;
  if (/profissionais|unidade escolar|acima citado|direcionado|encaminhamento|orientacao|coordenacao|motivo/i.test(text)) return false;
  const words = text.split(' ').filter(Boolean);
  const letters = (text.match(/[a-zà-ÿ]/gi) || []).length;
  if (words.length < 2) return text.length >= 5 && letters >= 4;
  const meaningfulWords = words.filter(word => /[a-zà-ÿ]{2,}/i.test(word));
  return meaningfulWords.length >= 2 && letters >= Math.max(6, Math.floor(text.length * 0.7));
}

function pickBestName(...candidates: string[]) {
  const cleaned = candidates.map(cleanHeaderName).filter(Boolean);
  const valid = cleaned.filter(isLikelyPersonName);
  if (!valid.length) return cleaned[0] || '';
  valid.sort((a, b) => b.length - a.length);
  return valid[0];
}

function pickBestGeneric(...candidates: string[]) {
  const cleaned = candidates.map(value => String(value || '').trim()).filter(Boolean);
  if (!cleaned.length) return '';
  cleaned.sort((a, b) => b.length - a.length);
  return cleaned[0];
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
    if (directValue) return cleanHeaderName(directValue);
    if (!labelPattern.test(normalized)) continue;
    const next = (lines[i + 1] || '').trim();
    if (next && !labelPattern.test(normalizeText(next))) return cleanHeaderName(next);
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
  return {
    professor: cleanHeaderName(professor),
    estudante: cleanHeaderName(estudante),
    matricula,
    data
  };
}

type VisionWord = { text: string; x: number; y: number };

function getWordText(word: any) {
  const symbols = Array.isArray(word?.symbols) ? word.symbols : [];
  return symbols.map((s: any) => s?.text || '').join('');
}

type VisionWordBox = { text: string; x0: number; x1: number; y: number };

function getBBoxCenter(vertices: any[] = []) {
  if (!vertices.length) return { x: 0, y: 0 };
  const xs = vertices.map(v => Number(v?.x || 0));
  const ys = vertices.map(v => Number(v?.y || 0));
  const x = xs.reduce((a, b) => a + b, 0) / xs.length;
  const y = ys.reduce((a, b) => a + b, 0) / ys.length;
  return { x, y };
}

function getBBoxMinMax(vertices: any[] = []) {
  if (!vertices.length) return { x0: 0, x1: 0, y: 0 };
  const xs = vertices.map(v => Number(v?.x || 0));
  const ys = vertices.map(v => Number(v?.y || 0));
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y = ys.reduce((a, b) => a + b, 0) / ys.length;
  return { x0, x1, y };
}

function extractHeaderTextFromVision(visionJson: any) {
  const full = visionJson?.responses?.[0]?.fullTextAnnotation;
  const page = full?.pages?.[0];
  if (!page) return '';
  const height = Number(page.height || 0);
  const headerLimit = height ? height * 0.42 : 0;
  const words: VisionWord[] = [];

  for (const block of page.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const word of para.words || []) {
        const text = getWordText(word);
        if (!text) continue;
        const { x, y } = getBBoxCenter(word?.boundingBox?.vertices || []);
        if (headerLimit && y > headerLimit) continue;
        words.push({ text, x, y });
      }
    }
  }

  if (!words.length) return '';
  const lineThreshold = height ? Math.max(10, height * 0.015) : 12;
  const sorted = words.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const lines: { y: number; words: VisionWord[] }[] = [];
  for (const word of sorted) {
    const last = lines[lines.length - 1];
    if (!last || Math.abs(word.y - last.y) > lineThreshold) {
      lines.push({ y: word.y, words: [word] });
    } else {
      last.words.push(word);
    }
  }
  return lines
    .map(line => line.words.sort((a, b) => a.x - b.x).map(w => w.text).join(' '))
    .join('\n');
}

function buildWordBoxes(visionJson: any) {
  const full = visionJson?.responses?.[0]?.fullTextAnnotation;
  const page = full?.pages?.[0];
  if (!page) return { words: [] as VisionWordBox[], height: 0, width: 0 };
  const height = Number(page.height || 0);
  const width = Number(page.width || 0);
  const words: VisionWordBox[] = [];
  for (const block of page.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const word of para.words || []) {
        const text = getWordText(word);
        if (!text) continue;
        const { x0, x1, y } = getBBoxMinMax(word?.boundingBox?.vertices || []);
        words.push({ text, x0, x1, y });
      }
    }
  }
  return { words, height, width };
}

function extractLineValue(words: VisionWordBox[], label: VisionWordBox, lineThreshold: number) {
  const sameLine = words.filter(w => Math.abs(w.y - label.y) <= lineThreshold && w.x0 > (label.x1 + 4));
  if (!sameLine.length) return '';
  return cleanHeaderName(sameLine.sort((a, b) => a.x0 - b.x0).map(w => w.text).join(' '));
}

function extractFieldsFromWordBoxes(visionJson: any) {
  const { words, height, width } = buildWordBoxes(visionJson);
  if (!words.length) return { professor: '', estudante: '', matricula: '', data: '' };
  const headerMax = height ? height * 0.45 : Infinity;
  const headerMin = height ? height * 0.08 : 0;
  const headerWords = words
    .filter(w => w.y >= headerMin && w.y <= headerMax)
    .sort((a, b) => (a.y - b.y) || (a.x0 - b.x0));
  const lineThreshold = height ? Math.max(8, height * 0.015) : 10;

  const labelMaxX = width ? width * 0.5 : Infinity;
  const findLabel = (regex: RegExp) =>
    headerWords.find(w => regex.test(normalizeText(w.text)) && w.x0 <= labelMaxX);

  const professorLabel = findLabel(/^(professor|professora|profes+sor|profe+sor|profes0r)$/i);
  const alunoLabel = findLabel(/^(aluno|alun0|estudante)$/i);
  const matriculaLabel = findLabel(/^matr/i);
  const dataLabel = findLabel(/^data$/i);

  let professor = professorLabel ? extractLineValue(headerWords, professorLabel, lineThreshold) : '';
  let estudante = alunoLabel ? extractLineValue(headerWords, alunoLabel, lineThreshold) : '';
  let matricula = matriculaLabel ? extractLineValue(headerWords, matriculaLabel, lineThreshold) : '';
  let data = dataLabel ? extractLineValue(headerWords, dataLabel, lineThreshold) : '';

  if (matricula) {
    const digits = matricula.replace(/\D+/g, '').trim();
    matricula = digits.length >= 4 ? digits : '';
  }
  if (data) {
    data = extractDateFromText(data);
  }

  return {
    professor: cleanHeaderName(professor),
    estudante: cleanHeaderName(estudante),
    matricula,
    data
  };
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
      return respondError(500, 'Missing Supabase env vars.');
    }
    if (!visionCredsRaw) {
      return respondError(500, 'Missing GOOGLE_VISION_CREDENTIALS.');
    }

    const authHeader = req.headers.get('Authorization') ?? '';
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) {
      return respondError(401, 'Unauthorized.', userError?.message || null);
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
      return respondError(403, 'Forbidden.');
    }

    const payload = await req.json();
    const storagePath = payload?.storage_path as string;
    if (!storagePath) {
      return respondError(400, 'Missing storage_path.');
    }

    const supaAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const { data: fileData, error: fileError } = await supaAdmin.storage.from('enc_temp').download(storagePath);
    if (fileError || !fileData) {
      return respondError(400, 'Falha ao baixar arquivo.', fileError?.message || null);
    }
    const arrayBuffer = await fileData.arrayBuffer();

    const creds = JSON.parse(visionCredsRaw);
    const clientEmail = creds.client_email;
    const privateKey = String(creds.private_key || '').replace(/\\n/g, '\n');
    if (!clientEmail || !privateKey) {
      return respondError(500, 'Invalid GOOGLE_VISION_CREDENTIALS.');
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
      return respondError(400, 'Falha no OCR do Vision.', visionJson?.error || visionJson);
    }

    const rawTextFull = visionJson?.responses?.[0]?.fullTextAnnotation?.text || '';
    const headerText = extractHeaderTextFromVision(visionJson);
    const fieldsFromBoxes = extractFieldsFromWordBoxes(visionJson);
    const fieldsFromHeader = extractHeaderFields(headerText);
    const fieldsFromFull = extractHeaderFields(rawTextFull);
    const fields = {
      professor: pickBestName(fieldsFromBoxes.professor, fieldsFromHeader.professor, fieldsFromFull.professor),
      estudante: pickBestName(fieldsFromBoxes.estudante, fieldsFromHeader.estudante, fieldsFromFull.estudante),
      matricula: pickBestGeneric(fieldsFromBoxes.matricula, fieldsFromHeader.matricula, fieldsFromFull.matricula),
      data: pickBestGeneric(fieldsFromBoxes.data, fieldsFromHeader.data, fieldsFromFull.data)
    };

    return new Response(JSON.stringify({
      fields,
      raw_text: headerText || rawTextFull,
      header_text: headerText
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return respondError(500, err?.message || 'Unexpected error.');
  }
});

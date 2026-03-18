import { serve } from 'https://deno.land/std@0.192.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

async function cleanupExpiredShortLinks(adminClient: any) {
  const nowIso = new Date().toISOString();
  await adminClient
    .from('professor_access_short_links')
    .delete()
    .lt('expires_at', nowIso);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      return new Response('Configuração inválida.', { status: 500 });
    }

    const code = new URL(req.url).searchParams.get('c')?.trim().toUpperCase() || '';
    if (!code) {
      return new Response('Link inválido.', { status: 400 });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false }
    });

    await cleanupExpiredShortLinks(adminClient);

    const { data: shortData, error: shortError } = await adminClient
      .from('professor_access_short_links')
      .select('code, action_link, expires_at')
      .eq('code', code)
      .maybeSingle();

    if (shortError || !shortData) {
      return new Response('Link não encontrado.', { status: 404 });
    }

    const expiresAt = shortData.expires_at ? new Date(shortData.expires_at).getTime() : 0;
    if (expiresAt && expiresAt < Date.now()) {
      return new Response('Link expirado.', { status: 410 });
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: shortData.action_link,
        'Cache-Control': 'no-store, max-age=0'
      }
    });
  } catch (_err) {
    return new Response('Erro inesperado.', { status: 500 });
  }
});

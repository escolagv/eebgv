import { serve } from 'https://deno.land/std@0.192.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const SHORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateShortCode(length = 8) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += SHORT_CODE_ALPHABET[bytes[i] % SHORT_CODE_ALPHABET.length];
  }
  return out;
}

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

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return new Response(JSON.stringify({ error: 'Missing Supabase env vars.' }), {
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

    const { data: adminProfile, error: adminError } = await adminClient
      .from('usuarios')
      .select('papel, status')
      .eq('user_uid', userData.user.id)
      .maybeSingle();

    if (adminError || !adminProfile || adminProfile.papel !== 'admin' || adminProfile.status !== 'ativo') {
      return new Response(JSON.stringify({ error: 'Forbidden.' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const payload = await req.json();
    const email = String(payload?.email || '').trim().toLowerCase();
    const redirectTo = String(payload?.redirect_to || '').trim();

    if (!email) {
      return new Response(JSON.stringify({ error: 'Missing email.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: redirectTo ? { redirectTo } : undefined
    });

    if (linkError) {
      return new Response(JSON.stringify({ error: linkError.message }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const actionLink = linkData?.properties?.action_link || null;
    if (!actionLink) {
      return new Response(JSON.stringify({ error: 'Action link was not generated.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    await cleanupExpiredShortLinks(adminClient);

    let shortLink: string | null = null;
    let shortErrorMessage: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const code = generateShortCode(8);
      const expiresAt = new Date(Date.now() + 1000 * 60 * 30).toISOString();
      const { error: shortError } = await adminClient
        .from('professor_access_short_links')
        .insert({
          code,
          action_link: actionLink,
          email,
          created_by: userData.user.id,
          expires_at: expiresAt
        });
      if (!shortError) {
        shortLink = `${supabaseUrl}/functions/v1/professor-access-short-link?c=${encodeURIComponent(code)}`;
        break;
      }
      shortErrorMessage = shortError.message;
    }

    return new Response(JSON.stringify({
      success: true,
      action_link: actionLink,
      short_link: shortLink,
      short_error: shortErrorMessage
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || 'Unexpected error.' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

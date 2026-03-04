// ===============================================================
// CONFIGURACAO, CLIENTE E UTILITARIOS
// ===============================================================
const { createClient } = window.supabase;

export const SUPABASE_URL = 'https://agivmrhwytnfprsjsvpy.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFnaXZtcmh3eXRuZnByc2pzdnB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTYyNTQ3ODgsImV4cCI6MjA3MTgzMDc4OH0.1yL3PaS_anO76q3CUdLkdpNc72EDPYVG5F4cYy6ySS0';

export const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        storageKey: 'encaminhamentos_auth'
    }
});

export function getLocalDateString() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export async function safeQuery(queryBuilder) {
    const { data, error, count } = await queryBuilder;
    if (error) {
        console.error('Supabase Error:', error);
        throw error;
    }
    return { data, error, count };
}

export function showView(showId, hideId) {
    const showEl = document.getElementById(showId);
    const hideEl = document.getElementById(hideId);
    if (hideEl) hideEl.classList.add('hidden');
    if (showEl) showEl.classList.remove('hidden');
}

export function formatDateTimeSP(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        dateStyle: 'short',
        timeStyle: 'short',
        hour12: false
    }).format(date);
}

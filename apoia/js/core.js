// ===============================================================
// CONFIGURACAO, ESTADO E UTILITARIOS
// ===============================================================
const { createClient } = window.supabase;

export const SUPABASE_URL = 'https://agivmrhwytnfprsjsvpy.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFnaXZtcmh3eXRuZnByc2pzdnB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTYyNTQ3ODgsImV4cCI6MjA3MTgzMDc4OH0.1yL3PaS_anO76q3CUdLkdpNc72EDPYVG5F4cYy6ySS0';

export const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
export const INACTIVITY_TIMEOUT = 30 * 60 * 1000;

export const state = {
    currentUser: null,
    turmasCache: [],
    usuariosCache: [],
    alunosCache: [],
    dashboardCalendar: { month: new Date().getMonth(), year: new Date().getFullYear() },
    anosLetivosCache: [],
    dashboardSelectedDate: undefined,
    inactivityTimer: null,
    mustChangePassword: false
};

export function getLocalDateString() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function showView(viewId) {
    document.getElementById('loading-view').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');
    ['login-view', 'professor-view', 'admin-view'].forEach(id => {
        const view = document.getElementById(id);
        if (view) view.classList.add('hidden');
    });
    const viewToShow = document.getElementById(viewId);
    if (viewToShow) {
        viewToShow.classList.remove('hidden');
    }
}

export function resetApplicationState() {
    state.currentUser = null;
    state.turmasCache = [];
    state.usuariosCache = [];
    state.alunosCache = [];
    state.anosLetivosCache = [];
    state.dashboardCalendar = { month: new Date().getMonth(), year: new Date().getFullYear() };
    state.dashboardSelectedDate = getLocalDateString();
    state.mustChangePassword = false;
}

export function resetLoginFormState() {
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        const loginButton = loginForm.querySelector('button[type="submit"]');
        loginForm.reset();
        // Não limpamos o erro aqui para permitir que o usuário o leia antes de tentar novamente
        if (loginButton) {
            loginButton.disabled = false;
            loginButton.innerHTML = 'Entrar';
        }
    }
}

export function showToast(message, isError = false) {
    const toastContainer = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast p-4 rounded-lg shadow-lg text-white ${isError ? 'bg-red-500' : 'bg-green-500'}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('hide');
        toast.addEventListener('transitionend', () => toast.remove());
    }, 5000);
}

export function closeModal(modalElement) {
    if (modalElement) {
        modalElement.classList.add('hidden');
    }
}

export function closeAllModals() {
    document.querySelectorAll('[id$="-modal"]').forEach(modal => modal.classList.add('hidden'));
}

let authErrorHandler = null;

export function setAuthErrorHandler(handler) {
    authErrorHandler = handler;
}

export async function safeQuery(queryBuilder) {
    const { data, error, count } = await queryBuilder;
    if (error) {
        console.error('Supabase Error:', error);
        const errorMessage = error.message || '';
        const errorDetails = error.details || '';
        if (
            errorMessage.includes('JWT') ||
            error.code === '401' ||
            error.status === 401 ||
            (errorDetails && errorDetails.includes('revoked'))
        ) {
            if (authErrorHandler) {
                await authErrorHandler('Sua sessão expirou por segurança. Por favor, faça o login novamente.');
            }
            return { data: null, error, count: null };
        }
        throw error;
    }
    return { data, error, count };
}

export async function logAudit(action, entity, entityId = null, details = null) {
    try {
        const payload = {
            user_uid: state.currentUser?.id || null,
            action,
            entity,
            entity_id: entityId ? String(entityId) : null,
            details
        };
        const { error } = await db.from('audit_logs').insert(payload);
        if (error) console.warn('Audit log error:', error.message);
    } catch (err) {
        console.warn('Audit log exception:', err?.message || err);
    }
}

export function resetInactivityTimer() {
    clearTimeout(state.inactivityTimer);
    state.inactivityTimer = setTimeout(() => {
        if (state.currentUser && authErrorHandler) {
            authErrorHandler('Sessão encerrada por inatividade.');
        }
    }, INACTIVITY_TIMEOUT);
}

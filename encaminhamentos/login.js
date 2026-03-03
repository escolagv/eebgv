import { signIn, signOut, requireAdminSession } from './js/auth.js';

document.addEventListener('DOMContentLoaded', async () => {
    const { session, profile } = await requireAdminSession();
    if (session && profile) {
        window.location.href = 'app.html';
        return;
    }

    const loginForm = document.getElementById('login-form');
    loginForm.addEventListener('submit', handleLogin);
});

async function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value.trim();
    const errorEl = document.getElementById('login-error');
    errorEl.textContent = '';

    const { error } = await signIn(email, password);
    if (error) {
        errorEl.textContent = error.message || 'Falha ao autenticar.';
        return;
    }

    const { session, profile } = await requireAdminSession();
    if (!session || !profile) {
        await signOut();
        errorEl.textContent = 'Acesso permitido apenas para administradores.';
        return;
    }

    window.location.href = 'app.html';
}

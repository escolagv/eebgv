import { signIn, signOut, requireAdminSession } from './js/auth.js';

document.addEventListener('DOMContentLoaded', async () => {
    const { session, profile } = await requireAdminSession();
    if (session && profile) {
        window.location.href = 'dashboard.html';
        return;
    }

    const loginForm = document.getElementById('login-form');
    loginForm.addEventListener('submit', handleLogin);
    initPasswordToggle();
});

function initPasswordToggle() {
    const toggleBtn = document.getElementById('login-password-toggle');
    const input = document.getElementById('login-password');
    const eye = document.getElementById('login-password-eye');
    const eyeOff = document.getElementById('login-password-eye-off');
    if (!toggleBtn || !input) return;

    toggleBtn.addEventListener('click', () => {
        const isHidden = input.type === 'password';
        input.type = isHidden ? 'text' : 'password';
        if (eye) eye.classList.toggle('hidden', !isHidden);
        if (eyeOff) eyeOff.classList.toggle('hidden', isHidden);
        toggleBtn.setAttribute('aria-label', isHidden ? 'Ocultar senha' : 'Mostrar senha');
    });
}

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

    window.location.href = 'dashboard.html';
}

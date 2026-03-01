import { db, state, resetApplicationState, resetLoginFormState, resetInactivityTimer, showToast, showView } from './core.js';
import { safeQuery, setAuthErrorHandler } from './core.js';
import { loadAdminData, renderDashboardPanel, loadNotifications, startNotificationsRealtime, stopNotificationsRealtime, stopNotificationsPolling } from './admin.js';
import { loadProfessorData, initProfessorAccount, refreshProfessorAvatar, checkProfessorAppUpdate, applyProfessorPasswordGate } from './professor.js';

export function initAuthHandlers() {
    setAuthErrorHandler(signOutUser);
}

export async function signOutUser(message) {
    resetLoginFormState();
    if (message) showToast(message, true);
    stopNotificationsRealtime();
    stopNotificationsPolling();
    await db.auth.signOut();
}

export async function handleAuthChange(event, session) {
    if (event === 'PASSWORD_RECOVERY') {
        showView('login-view');
        document.getElementById('reset-password-modal').classList.remove('hidden');
        return;
    }

    if (!session) {
        resetApplicationState();
        clearTimeout(state.inactivityTimer);
        stopNotificationsRealtime();
        stopNotificationsPolling();
        showView('login-view');
        return;
    }

    try {
        state.currentUser = session.user;
        const { data, error } = await safeQuery(
            db.from('usuarios').select('papel, nome, status, vinculo, precisa_trocar_senha').eq('user_uid', state.currentUser.id).single()
        );
        if (error || !data || data.status !== 'ativo') {
            const errorMessage = !data
                ? 'Seu usuário foi autenticado, mas não possui um perfil no sistema. Contate o suporte.'
                : 'Seu perfil de usuário não está ativo. Contate o suporte.';
            showToast(errorMessage, true);
            await db.auth.signOut();
            return;
        }
        const { papel, nome } = data;
        state.mustChangePassword = !!data.precisa_trocar_senha;
        if (papel === 'admin') {
            const adminInfo = document.getElementById('admin-info');
            const adminView = document.getElementById('admin-view');
            if (!adminInfo || !adminView) {
                showToast('Este acesso é exclusivo para professores.', true);
                await signOutUser();
                return;
            }
            document.body.dataset.userRole = 'admin';
            adminInfo.textContent = nome || state.currentUser.email;
            await loadAdminData();
            await renderDashboardPanel();
            await loadNotifications();
            startNotificationsRealtime();
            showView('admin-view');
        } else if (papel === 'professor') {
            const professorInfo = document.getElementById('professor-info');
            const professorView = document.getElementById('professor-view');
            if (!professorInfo || !professorView) {
                showToast('Este acesso não possui a interface do professor.', true);
                await signOutUser();
                return;
            }
            document.body.dataset.userRole = 'professor';
            professorInfo.textContent = nome || state.currentUser.email;
            await loadProfessorData(state.currentUser.id);
            await refreshProfessorAvatar();
            initProfessorAccount();
            stopNotificationsRealtime();
            stopNotificationsPolling();
            showView('professor-view');
            await checkProfessorAppUpdate();
            applyProfessorPasswordGate();
        } else {
            throw new Error('Papel de usuário desconhecido.');
        }
        resetInactivityTimer();
    } catch (err) {
        showToast(err.message || 'Erro ao carregar seu perfil. Tente novamente.', true);
        await signOutUser();
    }
}

import { db, state, resetApplicationState, resetLoginFormState, resetInactivityTimer, showToast, showView } from './core.js';
import { safeQuery, setAuthErrorHandler } from './core.js';
import { loadAdminData, renderDashboardPanel, loadNotifications, startNotificationsRealtime, stopNotificationsRealtime, stopNotificationsPolling } from './admin.js';
import { loadProfessorData, initProfessorAccount, refreshProfessorAvatar, checkProfessorAppUpdate, applyProfessorPasswordGate } from './professor.js';

function isRecoveryFlowInUrl() {
    const query = new URLSearchParams(window.location.search);
    const hashRaw = String(window.location.hash || '').replace(/^#/, '');
    const hash = new URLSearchParams(hashRaw);

    const type = query.get('type') || hash.get('type');
    return String(type || '').toLowerCase() === 'recovery';
}

function clearRecoveryParamsFromUrl() {
    const url = new URL(window.location.href);
    const keysToRemove = ['type', 'code', 'token_hash', 'access_token', 'refresh_token', 'expires_in', 'expires_at'];
    keysToRemove.forEach((k) => url.searchParams.delete(k));
    url.hash = '';
    window.history.replaceState({}, '', url.toString());
}

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
    const resetModal = document.getElementById('reset-password-modal');
    const isRecoveryModalOpen = !!resetModal && !resetModal.classList.contains('hidden');
    const isRecovery = event === 'PASSWORD_RECOVERY' || isRecoveryFlowInUrl() || isRecoveryModalOpen;
    if (isRecovery) {
        showView('login-view');
        resetModal?.classList.remove('hidden');
        clearRecoveryParamsFromUrl();
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
            db.from('usuarios')
                .select('papel, nome, status, vinculo, precisa_trocar_senha, senha_aviso_count')
                .eq('user_uid', state.currentUser.id)
                .maybeSingle()
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
        let mustChange = !!data.precisa_trocar_senha;
        let avisoCount = data.senha_aviso_count || 0;
        const usedDefaultPassword = state.lastLoginPassword === '123456';
        if (papel === 'admin' || papel === 'suporte') {
            const adminInfo = document.getElementById('admin-info');
            const adminView = document.getElementById('admin-view');
            if (!adminInfo || !adminView) {
                showToast('Este acesso é exclusivo para professores.', true);
                await signOutUser();
                return;
            }
            const isSupport = papel === 'suporte';
            document.body.dataset.userRole = isSupport ? 'suporte' : 'admin';
            adminInfo.textContent = isSupport
                ? `${nome || state.currentUser.email} (SUPORTE)`
                : (nome || state.currentUser.email);
            await loadAdminData();
            await renderDashboardPanel();
            await loadNotifications();
            startNotificationsRealtime();
            showView('admin-view');
        } else if (papel === 'professor') {
            if (usedDefaultPassword) {
                mustChange = true;
                if (!data.precisa_trocar_senha) {
                    await safeQuery(
                        db.from('usuarios')
                            .update({ precisa_trocar_senha: true, senha_aviso_count: 0 })
                            .eq('user_uid', state.currentUser.id)
                    );
                    avisoCount = 0;
                }
            } else if (data.precisa_trocar_senha) {
                await safeQuery(
                    db.from('usuarios')
                        .update({ precisa_trocar_senha: false, senha_aviso_count: 0 })
                        .eq('user_uid', state.currentUser.id)
                );
                mustChange = false;
                avisoCount = 0;
            }

            state.mustChangePassword = mustChange;
            state.senhaAvisoCount = avisoCount;
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
            if (state.mustChangePassword) {
                const key = `apoia_pwd_notice_${state.currentUser.id}`;
                if (!sessionStorage.getItem(key) && state.senhaAvisoCount < 5) {
                    const nextCount = state.senhaAvisoCount + 1;
                    await safeQuery(
                        db.from('usuarios')
                            .update({ senha_aviso_count: nextCount })
                            .eq('user_uid', state.currentUser.id)
                    );
                    state.senhaAvisoCount = nextCount;
                    sessionStorage.setItem(key, '1');
                }
            }
            applyProfessorPasswordGate();
            state.lastLoginPassword = null;
        } else {
            throw new Error('Papel de usuário desconhecido.');
        }
        resetInactivityTimer();
    } catch (err) {
        showToast(err.message || 'Erro ao carregar seu perfil. Tente novamente.', true);
        await signOutUser();
    }
}

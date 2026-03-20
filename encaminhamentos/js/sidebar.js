function parseVersion(value) {
    const match = String(value || '').match(/\d+(?:\.\d+)*/);
    return match ? match[0] : '';
}

function compareVersions(a, b) {
    const partsA = parseVersion(a).split('.').map(n => parseInt(n, 10)).filter(Number.isFinite);
    const partsB = parseVersion(b).split('.').map(n => parseInt(n, 10)).filter(Number.isFinite);
    const length = Math.max(partsA.length, partsB.length);
    for (let i = 0; i < length; i += 1) {
        const va = partsA[i] || 0;
        const vb = partsB[i] || 0;
        if (va !== vb) return va > vb ? 1 : -1;
    }
    return 0;
}

function ensureSupportQrModal() {
    let modal = document.getElementById('support-qr-modal');
    if (modal) return modal;

    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
        <div id="support-qr-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-[2px]">
            <div class="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
                <div class="px-6 py-4 bg-gradient-to-r from-slate-900 to-slate-700 text-white flex items-center justify-between">
                    <h3 class="text-base font-semibold">Suporte Técnico</h3>
                    <button type="button" id="support-qr-close" class="text-white/80 hover:text-white" aria-label="Fechar">✕</button>
                </div>
                <div class="p-6 text-center">
                    <div class="mx-auto w-48 h-48 bg-white rounded-xl border border-slate-200 shadow-sm flex items-center justify-center">
                        <img src="../apoia/qr_code_altnix.png" alt="QR Code Suporte" class="h-40 w-40">
                    </div>
                    <p class="text-xs text-slate-500 mt-3">Aponte a câmera para abrir o WhatsApp</p>
                    <a id="support-whats-link" href="#" target="_blank" rel="noopener" class="mt-3 inline-flex items-center justify-center px-4 py-2 text-sm font-semibold text-white bg-green-600 rounded-full hover:bg-green-700">
                        Abrir no WhatsApp
                    </a>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(wrapper.firstElementChild);
    modal = document.getElementById('support-qr-modal');
    return modal;
}

function setSupportLink() {
    const link = document.getElementById('support-link-enc');
    const linkCollapsed = document.getElementById('support-link-enc-collapsed');
    if (!link && !linkCollapsed) return;
    const numero = '5548991004780';
    const mensagem = 'Olá! Mensagem enviada do sistema de encaminhamentos da EEB Getúlio Vargas. Preciso de suporte.';
    const url = `https://wa.me/${numero}?text=${encodeURIComponent(mensagem)}`;
    const modal = ensureSupportQrModal();
    const closeBtn = document.getElementById('support-qr-close');
    const whatsLink = document.getElementById('support-whats-link');

    if (whatsLink) whatsLink.href = url;

    const openModal = (event) => {
        event?.preventDefault();
        modal?.classList.remove('hidden');
    };
    const closeModal = () => modal?.classList.add('hidden');

    [link, linkCollapsed].filter(Boolean).forEach((el) => {
        el.href = url;
        el.target = '_blank';
        el.rel = 'noopener';
        if (el.dataset.boundSupportModal === 'true') return;
        el.dataset.boundSupportModal = 'true';
        el.addEventListener('click', openModal);
    });

    if (closeBtn && closeBtn.dataset.boundSupportModal !== 'true') {
        closeBtn.dataset.boundSupportModal = 'true';
        closeBtn.addEventListener('click', closeModal);
    }
    if (modal && modal.dataset.boundSupportModal !== 'true') {
        modal.dataset.boundSupportModal = 'true';
        modal.addEventListener('click', (event) => {
            if (event.target === modal) closeModal();
        });
    }
}

function ensureResetPasswordModal() {
    let modal = document.getElementById('enc-reset-password-modal');
    if (modal) return modal;

    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
        <div id="enc-reset-password-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
            <div class="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
                <div class="flex items-center justify-between mb-4">
                    <h3 class="text-lg font-bold text-gray-900">Alterar Senha</h3>
                    <button type="button" id="enc-reset-password-close" class="text-gray-500 hover:text-gray-700 text-lg">&times;</button>
                </div>
                <div class="space-y-4">
                    <div>
                        <label for="enc-new-password" class="text-sm font-medium text-gray-700">Nova Senha</label>
                        <input type="password" id="enc-new-password" class="w-full px-3 py-2 mt-1 border border-gray-300 rounded-md shadow-sm" autocomplete="new-password">
                    </div>
                    <div>
                        <label for="enc-confirm-password" class="text-sm font-medium text-gray-700">Confirme a Nova Senha</label>
                        <input type="password" id="enc-confirm-password" class="w-full px-3 py-2 mt-1 border border-gray-300 rounded-md shadow-sm" autocomplete="new-password">
                    </div>
                    <p id="enc-reset-password-error" class="text-sm text-red-600 min-h-[20px]"></p>
                </div>
                <div class="mt-5 flex justify-end gap-2">
                    <button type="button" id="enc-reset-password-cancel" class="px-4 py-2 text-sm font-semibold text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300">Cancelar</button>
                    <button type="button" id="enc-reset-password-save" class="px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700">Salvar Nova Senha</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(wrapper.firstElementChild);
    modal = document.getElementById('enc-reset-password-modal');
    return modal;
}

function setupUserPasswordChange() {
    const userNameEl = document.getElementById('user-name');
    if (!userNameEl || userNameEl.dataset.bound === 'true') return;

    const modal = ensureResetPasswordModal();
    const newPasswordEl = document.getElementById('enc-new-password');
    const confirmPasswordEl = document.getElementById('enc-confirm-password');
    const errorEl = document.getElementById('enc-reset-password-error');
    const closeBtn = document.getElementById('enc-reset-password-close');
    const cancelBtn = document.getElementById('enc-reset-password-cancel');
    const saveBtn = document.getElementById('enc-reset-password-save');

    const closeModal = () => {
        modal?.classList.add('hidden');
    };

    const openModal = () => {
        if (newPasswordEl) newPasswordEl.value = '';
        if (confirmPasswordEl) confirmPasswordEl.value = '';
        if (errorEl) errorEl.textContent = '';
        modal?.classList.remove('hidden');
    };

    userNameEl.dataset.bound = 'true';
    userNameEl.classList.add('cursor-pointer', 'hover:text-white');
    userNameEl.title = 'Clique para alterar sua senha';
    userNameEl.addEventListener('click', openModal);

    closeBtn?.addEventListener('click', closeModal);
    cancelBtn?.addEventListener('click', closeModal);
    modal?.addEventListener('click', (event) => {
        if (event.target === modal) closeModal();
    });

    saveBtn?.addEventListener('click', async () => {
        const newPassword = String(newPasswordEl?.value || '');
        const confirmPassword = String(confirmPasswordEl?.value || '');
        if (errorEl) errorEl.textContent = '';

        if (!newPassword || newPassword.length < 6) {
            if (errorEl) errorEl.textContent = 'A senha deve ter pelo menos 6 caracteres.';
            return;
        }
        if (newPassword !== confirmPassword) {
            if (errorEl) errorEl.textContent = 'As senhas não conferem.';
            return;
        }

        const originalText = saveBtn.textContent;
        saveBtn.disabled = true;
        saveBtn.textContent = 'Salvando...';
        try {
            const { error } = await db.auth.updateUser({ password: newPassword });
            if (error) throw error;
            closeModal();
            window.alert('Senha alterada com sucesso.');
        } catch (err) {
            if (errorEl) errorEl.textContent = err?.message || 'Não foi possível alterar a senha.';
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = originalText || 'Salvar Nova Senha';
        }
    });
}

function setEncAppVersion() {
    const versionEl = document.getElementById('enc-app-version');
    if (!versionEl) return;
    const queryVersion = parseVersion(new URLSearchParams(window.location.search).get('app_version') || '');
    if (queryVersion) {
        try { localStorage.setItem('encapp_version', queryVersion); } catch (err) { /* ignore */ }
        versionEl.dataset.version = queryVersion;
        versionEl.textContent = `V${queryVersion}`;
        return;
    }
    let storedVersion = '';
    try { storedVersion = parseVersion(localStorage.getItem('encapp_version') || ''); } catch (err) { storedVersion = ''; }
    if (storedVersion) {
        versionEl.dataset.version = storedVersion;
        versionEl.textContent = `V${storedVersion}`;
        return;
    }
    const dataVersion = parseVersion(versionEl.dataset.version || '');
    const textVersion = parseVersion(versionEl.textContent || '');
    if (dataVersion && textVersion && dataVersion !== textVersion) {
        const chosen = compareVersions(textVersion, dataVersion) >= 0 ? textVersion : dataVersion;
        versionEl.dataset.version = chosen;
        versionEl.textContent = `V${chosen}`;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    setSupportLink();
    setEncAppVersion();
    setupUserPasswordChange();
    document.querySelectorAll('#admin-sidebar-nav .admin-nav-link, #sidebar-sync-block .admin-nav-link').forEach((link) => {
        const title = link.getAttribute('title') || link.textContent || '';
        const label = String(title).trim();
        if (label) {
            link.setAttribute('data-tooltip', label);
            if (!link.getAttribute('aria-label')) link.setAttribute('aria-label', label);
            link.removeAttribute('title');
        }
    });

    const adminViewEl = document.getElementById('admin-view');
    const sidebar = document.querySelector('aside');
    const overlay = document.getElementById('sidebar-overlay');
    const toggleBtn = document.getElementById('mobile-menu-btn');
    const sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');
    const sidebarCollapseIcon = document.getElementById('sidebar-collapse-icon');
    if (!sidebar || !overlay || !toggleBtn) return;

    const SIDEBAR_COLLAPSED_KEY = 'enc_sidebar_collapsed';
    const isMobile = () => window.innerWidth < 768;

    const applySidebarCollapsed = (collapsed) => {
        if (!adminViewEl) return;
        adminViewEl.classList.toggle('sidebar-collapsed', !!collapsed);
        if (sidebarCollapseIcon) sidebarCollapseIcon.textContent = collapsed ? '»' : '«';
        if (sidebarCollapseBtn) {
            sidebarCollapseBtn.title = collapsed ? 'Expandir menu' : 'Recolher menu';
            sidebarCollapseBtn.setAttribute('aria-label', collapsed ? 'Expandir menu' : 'Recolher menu');
        }
    };

    const open = () => {
        sidebar.classList.remove('-translate-x-full');
        if (isMobile()) overlay.classList.remove('hidden');
    };
    const close = () => {
        sidebar.classList.add('-translate-x-full');
        overlay.classList.add('hidden');
    };

    if (adminViewEl) {
        // Igual ao chamadas: sempre inicia minimizado após login/carregamento.
        applySidebarCollapsed(true);
        try {
            localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1');
        } catch (err) {
            // ignore storage errors
        }
    }

    const toggleDesktopCollapse = () => {
        if (!adminViewEl) return;
        adminViewEl.classList.add('sidebar-is-toggling');
        const nextCollapsed = !adminViewEl.classList.contains('sidebar-collapsed');
        applySidebarCollapsed(nextCollapsed);
        window.setTimeout(() => {
            adminViewEl.classList.remove('sidebar-is-toggling');
        }, 220);
        try {
            localStorage.setItem(SIDEBAR_COLLAPSED_KEY, nextCollapsed ? '1' : '0');
        } catch (err) {
            // ignore storage errors
        }
    };

    const toggleMobileSidebar = () => {
        if (sidebar.classList.contains('-translate-x-full')) {
            open();
        } else {
            close();
        }
    };

    // Em mobile começa fechado; em desktop fica visível e recolhido por classe.
    if (isMobile()) close();
    else sidebar.classList.remove('-translate-x-full');

    toggleBtn.addEventListener('click', () => {
        if (isMobile()) toggleMobileSidebar();
        else toggleDesktopCollapse();
    });
    overlay.addEventListener('click', close);
    sidebarCollapseBtn?.addEventListener('click', toggleDesktopCollapse);

    window.addEventListener('resize', () => {
        if (isMobile()) {
            close();
        } else {
            overlay.classList.add('hidden');
            sidebar.classList.remove('-translate-x-full');
        }
    });
});

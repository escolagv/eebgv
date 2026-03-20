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

function setSupportLink() {
    const link = document.getElementById('support-link-enc');
    if (!link) return;
    const numero = '5548991004780';
    const mensagem = 'Olá! Mensagem enviada do Sistema de chamadas da EEB Getúlio Vargas. Preciso de suporte.';
    const url = `https://wa.me/${numero}?text=${encodeURIComponent(mensagem)}`;
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
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

    const sidebar = document.querySelector('aside');
    const overlay = document.getElementById('sidebar-overlay');
    const toggleBtn = document.getElementById('mobile-menu-btn');
    if (!sidebar || !overlay || !toggleBtn) return;

    const open = () => {
        sidebar.classList.remove('-translate-x-full');
        overlay.classList.remove('hidden');
    };
    const close = () => {
        sidebar.classList.add('-translate-x-full');
        overlay.classList.add('hidden');
    };
    const toggle = () => {
        if (sidebar.classList.contains('-translate-x-full')) {
            open();
        } else {
            close();
        }
    };

    // Inicia sempre minimizado (fechado) após login/carregamento da página
    close();

    toggleBtn.addEventListener('click', toggle);
    overlay.addEventListener('click', close);
});

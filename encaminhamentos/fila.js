import { db, safeQuery, formatDateTimeSP } from './js/core.js';
import { requireAdminSession, signOut } from './js/auth.js';

const state = {
    jobs: [],
    signedUrls: new Map()
};

document.addEventListener('DOMContentLoaded', async () => {
    const { session, profile } = await requireAdminSession();
    if (!session || !profile) {
        window.location.href = 'login.html';
        return;
    }

    document.getElementById('user-name').textContent = profile.nome || session.user.email || '-';
    document.getElementById('logout-btn').addEventListener('click', async () => {
        await signOut();
        window.location.href = 'login.html';
    });

    const refreshBtn = document.getElementById('queue-refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', loadQueue);

    await loadQueue();
});

async function loadQueue() {
    try {
        const { data } = await safeQuery(
            db.from('enc_scan_jobs')
                .select('id, status, storage_path, mime_type, created_at, device_id, drive_url, drive_file_id, encaminhamento_id')
                .order('created_at', { ascending: false })
        );
        state.jobs = data || [];
        await buildSignedUrls();
        renderQueue();
    } catch (err) {
        console.error('Erro ao carregar fila:', err?.message || err);
        renderQueueError();
    }
}

async function buildSignedUrls() {
    state.signedUrls.clear();
    const tasks = state.jobs
        .filter(job => !!job.storage_path)
        .map(async (job) => {
            try {
                const { data, error } = await db.storage.from('enc_temp').createSignedUrl(job.storage_path, 60 * 60);
                if (!error && data?.signedUrl) {
                    state.signedUrls.set(job.id, data.signedUrl);
                }
            } catch (err) {
                console.warn('Falha ao gerar preview:', err?.message || err);
            }
        });
    await Promise.all(tasks);
}

function renderQueue() {
    const list = document.getElementById('queue-list');
    const countEl = document.getElementById('queue-count');
    if (!list || !countEl) return;

    countEl.textContent = state.jobs.length;

    if (state.jobs.length === 0) {
        list.innerHTML = '<p class="text-sm text-gray-500">Nenhuma imagem na fila.</p>';
        return;
    }

    list.innerHTML = state.jobs.map(job => {
        const preview = state.signedUrls.get(job.id);
        const created = formatDateTimeSP(job.created_at);
        const status = job.status || 'novo';
        const disabled = status !== 'novo';
        const driveLink = job.drive_url ? `<a href="${job.drive_url}" target="_blank" rel="noopener" class="text-xs text-blue-600 hover:underline">Abrir no Drive</a>` : '';
        const previewHtml = preview
            ? `<img src="${preview}" alt="Prévia" class="w-full h-40 object-cover rounded-md border border-gray-200">`
            : `<div class="w-full h-40 flex items-center justify-center bg-gray-100 rounded-md border border-gray-200 text-xs text-gray-400">Sem prévia</div>`;

        return `
            <div class="bg-gray-50 border border-gray-200 rounded-lg p-3 flex flex-col gap-3">
                ${previewHtml}
                <div class="text-xs text-gray-500">Enviado em: ${created}</div>
                <div class="text-xs text-gray-500">Status: <span class="font-semibold text-gray-700">${status}</span></div>
                ${driveLink}
                <button type="button" class="queue-select-btn px-3 py-2 text-xs font-semibold rounded-md ${disabled ? 'bg-gray-200 text-gray-500 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700'}"
                    data-id="${job.id}" ${disabled ? 'disabled' : ''}>
                    Selecionar para cadastro
                </button>
            </div>
        `;
    }).join('');

    document.querySelectorAll('.queue-select-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-id');
            if (!id) return;
            window.location.href = `encaminhamento.html?scanId=${encodeURIComponent(id)}`;
        });
    });
}

function renderQueueError() {
    const list = document.getElementById('queue-list');
    if (!list) return;
    list.innerHTML = '<p class="text-sm text-red-600">Erro ao carregar a fila. Tente novamente.</p>';
}

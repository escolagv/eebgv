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
                .select('id, status, storage_path, mime_type, created_at, device_id, drive_url, drive_file_id, encaminhamento_id, aluno_matricula, ocr_json')
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

function sanitizeOcrName(value) {
    const text = (value || '').replace(/[|_]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (/profissionais|unidade escolar|acima citado|direcionado/i.test(text)) return '';
    if (/\d/.test(text)) return '';
    const words = text.split(' ').filter(Boolean);
    const meaningfulWords = words.filter(word => /[a-zà-ÿ]{2,}/i.test(word));
    const letters = (text.match(/[a-zà-ÿ]/gi) || []).length;
    if (meaningfulWords.length < 2) return '';
    if (letters < Math.max(6, Math.floor(text.length * 0.7))) return '';
    return text;
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
        const deleteDisabled = status === 'vinculado';
        const matriculaValue = job.aluno_matricula ? String(job.aluno_matricula) : (job.ocr_json?.fields?.matricula || '');
        const alunoNome = sanitizeOcrName(job.ocr_json?.fields?.estudante || '');
        const profNome = sanitizeOcrName(job.ocr_json?.fields?.professor || '');
        const driveLink = job.drive_url ? `<a href="${job.drive_url}" target="_blank" rel="noopener" class="text-xs text-blue-600 hover:underline">Abrir no Drive</a>` : '';
        const previewHtml = preview
            ? `<img src="${preview}" data-url="${preview}" data-aluno="${alunoNome || ''}" data-professor="${profNome || ''}" data-matricula="${matriculaValue || ''}" data-data="${created || ''}" alt="Prévia" class="queue-image w-full h-40 object-cover rounded-md border border-gray-200 cursor-zoom-in">`
            : `<div class="w-full h-40 flex items-center justify-center bg-gray-100 rounded-md border border-gray-200 text-xs text-gray-400">Sem prévia</div>`;
        return `
            <div class="bg-gray-50 border border-gray-200 rounded-lg p-3 flex flex-col gap-3">
                ${previewHtml}
                <div class="flex items-center justify-between gap-2 text-xs text-gray-500">
                    <span>Enviado em: ${created}</span>
                    <span>Status: <strong class="text-gray-700">${status}</strong></span>
                </div>
                <div class="text-xs text-gray-500">Matrícula: <span class="font-semibold text-gray-700">${matriculaValue || '-'}</span></div>
                <div class="text-xs text-gray-600">Aluno: <span class="font-semibold text-gray-800">${alunoNome || '-'}</span></div>
                <div class="text-xs text-gray-600">Professor: <span class="font-semibold text-gray-800">${profNome || '-'}</span></div>
                ${driveLink}
                <div class="flex gap-2">
                    <button type="button" class="queue-select-btn flex-1 px-3 py-2 text-xs font-semibold rounded-md ${disabled ? 'bg-gray-200 text-gray-500 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700'}"
                        data-id="${job.id}" ${disabled ? 'disabled' : ''}>
                        Selecionar para cadastro
                    </button>
                    <button type="button" class="queue-delete-btn px-3 py-2 text-xs font-semibold rounded-md ${deleteDisabled ? 'bg-gray-200 text-gray-500 cursor-not-allowed' : 'bg-red-600 text-white hover:bg-red-700'}"
                        data-id="${job.id}" data-path="${job.storage_path || ''}" ${deleteDisabled ? 'disabled' : ''}>
                        Excluir
                    </button>
                </div>
            </div>
        `;
    }).join('');

document.querySelectorAll('.queue-select-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        if (!id) return;
        const params = new URLSearchParams(window.location.search);
        const editId = params.get('editId');
        const target = editId
            ? `encaminhamento.html?scanId=${encodeURIComponent(id)}&editId=${encodeURIComponent(editId)}`
            : `encaminhamento.html?scanId=${encodeURIComponent(id)}`;
        window.location.href = target;
    });
});

    document.querySelectorAll('.queue-delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const path = btn.getAttribute('data-path');
            if (!id) return;
            if (!window.confirm('Deseja excluir esta imagem da fila?')) return;
            try {
                if (path) {
                    await db.storage.from('enc_temp').remove([path]);
                }
                await safeQuery(db.from('enc_scan_jobs').delete().eq('id', id));
                await loadQueue();
            } catch (err) {
                alert('Falha ao excluir da fila.');
                console.error(err);
            }
        });
    });

    document.querySelectorAll('.queue-image').forEach(img => {
        img.addEventListener('click', () => {
            openZoom(img.getAttribute('data-url') || img.src, {
                aluno: img.getAttribute('data-aluno') || '',
                professor: img.getAttribute('data-professor') || '',
                matricula: img.getAttribute('data-matricula') || '',
                data: img.getAttribute('data-data') || ''
            });
        });
    });
}

function renderQueueError() {
    const list = document.getElementById('queue-list');
    if (!list) return;
    list.innerHTML = '<p class="text-sm text-red-600">Erro ao carregar a fila. Tente novamente.</p>';
}

let zoomScale = 1;
let zoomMeta = null;
function openZoom(url, meta = null) {
    const modal = document.getElementById('zoom-modal');
    const img = document.getElementById('zoom-image');
    const printBtn = document.getElementById('zoom-print-btn');
    if (!modal || !img || !url) return;
    img.src = url;
    zoomScale = 1;
    zoomMeta = meta;
    img.style.transform = `scale(${zoomScale})`;
    if (printBtn) {
        printBtn.onclick = () => printZoomImage(url, zoomMeta);
    }
    modal.classList.remove('hidden');
}

function initZoomControls() {
    const modal = document.getElementById('zoom-modal');
    const img = document.getElementById('zoom-image');
    const closeBtn = document.getElementById('zoom-close-btn');
    const zoomIn = document.getElementById('zoom-in-btn');
    const zoomOut = document.getElementById('zoom-out-btn');
    const reset = document.getElementById('zoom-reset-btn');
    if (!modal || !img) return;

    const applyScale = () => {
        img.style.transform = `scale(${zoomScale})`;
    };

    zoomIn?.addEventListener('click', () => {
        zoomScale = Math.min(3, zoomScale + 0.25);
        applyScale();
    });
    zoomOut?.addEventListener('click', () => {
        zoomScale = Math.max(0.75, zoomScale - 0.25);
        applyScale();
    });
    reset?.addEventListener('click', () => {
        zoomScale = 1;
        applyScale();
    });
    closeBtn?.addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (event) => {
        if (event.target === modal) modal.classList.add('hidden');
    });
}

initZoomControls();

function printZoomImage(url, meta) {
    if (!url) return;
    const aluno = meta?.aluno || '-';
    const matricula = meta?.matricula || '';
    const dataLabel = meta?.data || '';
    const professor = meta?.professor || '';
    const logoUrl = new URL('../apoia/logo.png', window.location.href).href;
    const infoParts = [`Aluno: ${aluno}`];
    if (professor) infoParts.push(`Professor: ${professor}`);
    if (matricula) infoParts.push(`Matricula: ${matricula}`);
    if (dataLabel) infoParts.push(`Enviado em: ${dataLabel}`);

    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(`
        <html>
        <head>
            <title>Imprimir imagem</title>
            <style>
                @page { size: A4 portrait; margin: 12mm; }
                body { font-family: Arial, sans-serif; margin: 0; color: #000; }
                .header { display: flex; align-items: center; gap: 8mm; margin-bottom: 8mm; }
                .logo { height: 24mm; width: auto; }
                .title { font-weight: 700; font-size: 11pt; letter-spacing: 0.3px; margin: 0 0 1mm 0; }
                .line { font-size: 9pt; margin: 0; }
                img { max-width: 100%; height: auto; }
            </style>
        </head>
        <body>
            <div class="header">
                <img class="logo" src="${logoUrl}" alt="Logo" />
                <div>
                    <div class="title">E.E.B GETULIO VARGAS</div>
                    <div class="line">${infoParts.join(' • ')}</div>
                </div>
            </div>
            <img src="${url}" alt="Documento" />
            <script>
                window.onload = () => { window.print(); };
            </script>
        </body>
        </html>
    `);
    win.document.close();
}

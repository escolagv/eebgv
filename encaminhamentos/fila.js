import { db, safeQuery, formatDateTimeSP, SUPABASE_URL, SUPABASE_ANON_KEY, getCurrentYear, getYearFromDateString, getEncaminhamentosTableName, ensureEncaminhamentosTableReady, showAppMessage } from './js/core.js';
import { requireAdminSession, signOut } from './js/auth.js';

const INITIAL_VISIBLE_ITEMS = 24;
const LOAD_MORE_STEP = 24;
const WARM_PREVIEW_LIMIT = 8;
const WARM_PREVIEW_BATCH = 4;

const state = {
    jobs: [],
    jobsById: new Map(),
    jobMetaById: new Map(),
    signedUrls: new Map(),
    previewDisplayUrls: new Map(),
    previewMissing: new Set(),
    previewLoading: new Set(),
    previewToken: 0,
    visibleCount: INITIAL_VISIBLE_ITEMS,
    queueEventsBound: false,
    sortOrder: 'desc'
};

function normalizeStoragePath(path) {
    const raw = String(path || '').trim().replace(/^\/+/, '');
    if (!raw) return '';
    return raw.replace(/^enc_temp\//i, '');
}

function buildStoragePathCandidates(path) {
    const raw = String(path || '').trim().replace(/^\/+/, '');
    if (!raw) return [];
    const normalized = normalizeStoragePath(raw);
    const prefixed = normalized ? `enc_temp/${normalized}` : '';
    return Array.from(new Set([raw, normalized, prefixed].filter(Boolean)));
}

async function createSignedUrlWithFallback(path, expiresIn = 60 * 60, options = null) {
    const candidates = buildStoragePathCandidates(path);
    let lastError = null;
    for (const candidate of candidates) {
        const params = options
            ? [candidate, expiresIn, options]
            : [candidate, expiresIn];
        const { data, error } = await db.storage.from('enc_temp').createSignedUrl(...params);
        if (!error && data?.signedUrl) return { signedUrl: data.signedUrl, path: candidate };
        lastError = error || lastError;
    }
    throw lastError || new Error('Falha ao gerar signed URL.');
}

async function removeFromEncTempWithFallback(path) {
    const candidates = buildStoragePathCandidates(path);
    if (!candidates.length) return;
    try {
        await db.storage.from('enc_temp').remove(candidates);
    } catch (err) {
        console.warn('Falha ao remover arquivo do enc_temp:', err?.message || err, candidates);
    }
}

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
    const sortSelect = document.getElementById('queue-sort-order');
    if (sortSelect) {
        sortSelect.value = state.sortOrder;
        sortSelect.addEventListener('change', () => {
            state.sortOrder = sortSelect.value === 'asc' ? 'asc' : 'desc';
            applyQueueSortAndRender();
        });
    }
    initQueueInteractions();

    await loadQueue();
    initQrModal();
});

function getJobIdKey(jobId) {
    return String(jobId || '');
}

function getJobCreatedTimestamp(job) {
    const time = Date.parse(job?.created_at || '');
    return Number.isFinite(time) ? time : 0;
}

function sortJobsByDate(jobs, order = 'desc') {
    const dir = order === 'asc' ? 1 : -1;
    jobs.sort((a, b) => {
        const diff = getJobCreatedTimestamp(a) - getJobCreatedTimestamp(b);
        if (diff !== 0) return diff * dir;
        const aId = Number(a?.id || 0);
        const bId = Number(b?.id || 0);
        return (aId - bId) * dir;
    });
}

function getPreviewTransformOptions() {
    return {
        transform: {
            width: 960,
            quality: 60,
            resize: 'contain'
        }
    };
}

function buildJobRenderMeta(job) {
    const created = formatDateTimeSP(job.created_at);
    const status = job.status || 'novo';
    const isLinked = !!job.encaminhamento_id;
    const deleteDisabled = isLinked || status === 'vinculado';
    const statusLabel = isLinked ? `${status} (pendente Drive)` : status;
    const canRetryDrive = isLinked && !!job.storage_path && !job.drive_file_id && !job.drive_url;
    const rawText = job.ocr_json?.raw_text || '';
    const headerText = job.ocr_json?.header_text || '';
    const matriculaValue = job.aluno_matricula
        ? String(job.aluno_matricula)
        : (job.ocr_json?.fields?.matricula || extractMatricula(rawText) || '');
    const alunoNomeRaw = pickBestNameField(
        job.ocr_json?.fields?.estudante || '',
        pickBestNameFromRawTexts(extractAlunoFromRawText, headerText, rawText)
    );
    const profNomeRaw = pickBestNameField(
        job.ocr_json?.fields?.professor || '',
        pickBestNameFromRawTexts(extractProfessorFromRawText, headerText, rawText)
    );
    const alunoNome = sanitizeOcrName(alunoNomeRaw);
    const profNome = sanitizeOcrName(profNomeRaw);
    const sizeLabel = formatFileSize(job.file_size_bytes);
    const driveLink = job.drive_url
        ? `<a href="${job.drive_url}" target="_blank" rel="noopener" class="text-xs text-blue-600 hover:underline">Abrir no Drive</a>`
        : '';

    return {
        created,
        status,
        deleteDisabled,
        statusLabel,
        canRetryDrive,
        matriculaValue,
        alunoNome,
        profNome,
        sizeLabel,
        driveLink
    };
}

function prepareQueueData(allJobs) {
    const filteredJobs = (allJobs || []).filter(job => {
        const hasStorage = !!job.storage_path;
        const hasDrive = !!job.drive_file_id || !!job.drive_url;
        const isLinked = !!job.encaminhamento_id;
        const isNovo = (job.status || 'novo') === 'novo';
        return hasStorage && !hasDrive && !isLinked && isNovo;
    });
    sortJobsByDate(filteredJobs, state.sortOrder);

    state.jobs = filteredJobs;
    state.jobsById.clear();
    state.jobMetaById.clear();
    filteredJobs.forEach(job => {
        const key = getJobIdKey(job.id);
        state.jobsById.set(key, job);
        state.jobMetaById.set(key, buildJobRenderMeta(job));
    });
}

function applyQueueSortAndRender() {
    sortJobsByDate(state.jobs, state.sortOrder);
    state.visibleCount = INITIAL_VISIBLE_ITEMS;
    renderQueue();
    void warmSignedUrls(state.previewToken);
}

async function loadQueue() {
    try {
        const { data } = await safeQuery(
            db.from('enc_scan_jobs')
                .select('id, status, storage_path, mime_type, file_size_bytes, created_at, device_id, drive_url, drive_file_id, encaminhamento_id, aluno_matricula, ocr_json')
                .order('created_at', { ascending: false })
        );
        prepareQueueData(data || []);
        state.signedUrls.clear();
        state.previewDisplayUrls.clear();
        state.previewMissing.clear();
        state.previewLoading.clear();
        state.visibleCount = INITIAL_VISIBLE_ITEMS;
        state.previewToken += 1;
        const currentToken = state.previewToken;
        renderQueue();
        void warmSignedUrls(currentToken);
    } catch (err) {
        console.error('Erro ao carregar fila:', err?.message || err);
        renderQueueError();
    }
}

function initQrModal() {
    const openBtn = document.getElementById('qr-open-btn');
    const modal = document.getElementById('qr-modal');
    const closeBtn = document.getElementById('qr-close-btn');
    const newBtn = document.getElementById('qr-new-btn');
    if (!openBtn || !modal) return;

    openBtn.addEventListener('click', async () => {
        modal.classList.remove('hidden');
        await loadQrCode(false);
    });
    if (closeBtn) {
        closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
    }
    if (newBtn) {
        newBtn.addEventListener('click', async () => {
            await loadQrCode(true);
        });
    }
    modal.addEventListener('click', (event) => {
        if (event.target === modal) modal.classList.add('hidden');
    });
}

async function loadQrCode(forceNew = false) {
    const qrEl = document.getElementById('qr-code');
    const statusEl = document.getElementById('qr-status');
    if (!qrEl || !statusEl) return;
    statusEl.textContent = 'Gerando...';
    try {
        const { data: sessionData, error: sessionError } = await db.auth.getSession();
        if (sessionError || !sessionData?.session?.access_token) {
            statusEl.textContent = 'Sessão expirada. Faça login novamente.';
            return;
        }
        const response = await fetch(`${SUPABASE_URL}/functions/v1/enc_qr_issue`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${sessionData.session.access_token}`,
                apikey: SUPABASE_ANON_KEY
            },
            body: JSON.stringify({ force: forceNew })
        });
        const payload = await response.json();
        if (!response.ok) {
            statusEl.textContent = payload?.error || 'Falha ao gerar QR.';
            return;
        }
        const token = payload?.token;
        const expiresAt = payload?.expires_at;
        const usedAt = payload?.used_at;
        if (!token) {
            statusEl.textContent = 'Token não encontrado.';
            return;
        }
        const pwaUrl = new URL('/encaminhamentos/pwa.html', window.location.origin);
        pwaUrl.searchParams.set('token', token);
        pwaUrl.searchParams.set('v', Date.now().toString());
        qrEl.innerHTML = '';
        if (window.QRCode) {
            new QRCode(qrEl, {
                text: pwaUrl.toString(),
                width: 220,
                height: 220
            });
        }
        const usedLabel = usedAt ? ' (já usado)' : '';
        const now = new Date();
        const expDate = expiresAt ? new Date(expiresAt) : null;
        const expired = expDate ? now.getTime() > expDate.getTime() : now.getHours() >= 18;
        statusEl.textContent = expired
            ? `Expirado${usedLabel}`
            : (expiresAt ? `Expira às 18h${usedLabel}` : `QR pronto${usedLabel}`);
    } catch (err) {
        statusEl.textContent = 'Erro ao gerar QR.';
        console.error(err);
    }
}

async function ensureSignedUrlForJob(job) {
    if (!job?.storage_path) return false;
    const key = getJobIdKey(job.id);
    if (state.signedUrls.has(key) || state.previewMissing.has(key)) return false;
    if (state.previewLoading.has(key)) return false;

    state.previewLoading.add(key);
    try {
        const original = await createSignedUrlWithFallback(job.storage_path, 60 * 60);
        if (original?.signedUrl) {
            state.signedUrls.set(key, original.signedUrl);
            let previewUrl = original.signedUrl;
            try {
                const preview = await createSignedUrlWithFallback(
                    job.storage_path,
                    60 * 60,
                    getPreviewTransformOptions()
                );
                if (preview?.signedUrl) previewUrl = preview.signedUrl;
            } catch (_previewErr) {
                previewUrl = original.signedUrl;
            }
            state.previewDisplayUrls.set(key, previewUrl);
            return true;
        }
        state.previewMissing.add(key);
        return true;
    } catch (_err) {
        state.previewMissing.add(key);
        return true;
    } finally {
        state.previewLoading.delete(key);
    }
}

async function warmSignedUrls(token) {
    const warmLimit = Math.min(state.visibleCount, WARM_PREVIEW_LIMIT);
    const candidates = state.jobs
        .filter(job => !!job.storage_path)
        .slice(0, warmLimit);

    for (let index = 0; index < candidates.length; index += WARM_PREVIEW_BATCH) {
        if (token !== state.previewToken) return;
        const batch = candidates.slice(index, index + WARM_PREVIEW_BATCH);
        await Promise.all(batch.map(job => ensureSignedUrlForJob(job)));
        if (token !== state.previewToken) return;
        renderQueue();
    }
}

async function loadPreviewForJob(jobId, button) {
    const key = getJobIdKey(jobId);
    const job = state.jobsById.get(key);
    if (!job) return;
    if (state.signedUrls.has(key) || state.previewMissing.has(key)) return;

    const originalText = button?.textContent || 'Carregar prévia';
    if (button) {
        button.disabled = true;
        button.textContent = 'Carregando...';
    }

    await ensureSignedUrlForJob(job);
    renderQueue();

    if (button) {
        button.disabled = false;
        button.textContent = originalText;
    }
}

function sanitizeOcrName(value) {
    const text = (value || '').replace(/[|_]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (/profissionais|unidade escolar|acima citado|direcionado|encaminhamento|orientacao|coordenacao|motivo/i.test(text)) return '';
    if (/\d/.test(text)) return '';
    const words = text.split(' ').filter(Boolean);
    const meaningfulWords = words.filter(word => /[a-zà-ÿ]{2,}/i.test(word));
    const letters = (text.match(/[a-zà-ÿ]/gi) || []).length;
    if (meaningfulWords.length < 2) {
        if (text.length < 5 || letters < Math.max(4, Math.floor(text.length * 0.7))) return '';
    }
    if (letters < Math.max(4, Math.floor(text.length * 0.7))) return '';
    return text;
}

function scoreNameQuality(value) {
    const text = sanitizeOcrName(value);
    if (!text) return 0;
    const words = text.split(' ').filter(Boolean);
    const letters = (text.match(/[a-zà-ÿ]/gi) || []).length;
    let score = 0;
    score += Math.min(40, letters);
    score += Math.min(20, words.length * 5);
    if (words.length >= 2) score += 15;
    if (!/\d/.test(text)) score += 10;
    return score;
}

function pickBestNameField(currentValue, candidateValue) {
    const current = sanitizeOcrName(currentValue);
    const candidate = sanitizeOcrName(candidateValue);
    if (!candidate) return current;
    if (!current) return candidate;
    return scoreNameQuality(candidate) >= scoreNameQuality(current) ? candidate : current;
}

function pickBestGenericField(currentValue, candidateValue) {
    const current = String(currentValue || '').trim();
    const candidate = String(candidateValue || '').trim();
    if (!candidate) return current;
    if (!current) return candidate;
    return candidate.length >= current.length ? candidate : current;
}

function normalizeText(value) {
    return (value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractLabelValue(rawText, labelPattern, stripPattern) {
    const lines = (rawText || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length) return '';
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const normalized = normalizeText(line);
        if (!labelPattern.test(normalized)) continue;
        const sameLine = line.replace(stripPattern, '').replace(/^[\s:;.\-|_]+/, '').trim();
        if (sameLine) return sameLine;
        const nextLine = lines[i + 1] || '';
        if (nextLine && !labelPattern.test(normalizeText(nextLine))) return nextLine;
        return '';
    }
    return '';
}

function extractMatricula(rawText) {
    const match = (rawText || '').match(/matr[íi]cula[^\d]*([0-9]{4,})/i);
    return match ? match[1] : '';
}

function extractAlunoFromRawText(rawText) {
    return extractLabelValue(
        rawText,
        /(?:aluno|estudante|alun0|estudant[ea3]?)/i,
        /.*?(?:aluno|estudante|alun0|estudant[ea3]?)\s*[:;\-_.|]*/i
    );
}

function extractProfessorFromRawText(rawText) {
    return extractLabelValue(
        rawText,
        /(?:professor|professora|profes+sor|profe+sor|profes0r|profesor)/i,
        /.*?(?:professor|professora|profes+sor|profe+sor|profes0r|profesor)\s*[:;\-_.|]*/i
    );
}

function pickBestNameFromRawTexts(extractor, ...rawTexts) {
    let best = '';
    rawTexts.forEach(raw => {
        const candidate = extractor(raw || '');
        best = pickBestNameField(best, candidate);
    });
    return best;
}

function renderQueueCard(job) {
    const key = getJobIdKey(job.id);
    const previewUrl = state.previewDisplayUrls.get(key);
    const fullPreviewUrl = state.signedUrls.get(key) || previewUrl || '';
    const previewMissing = state.previewMissing.has(key);
    const meta = state.jobMetaById.get(key) || buildJobRenderMeta(job);
    const previewHtml = previewUrl
        ? `<img src="${previewUrl}" loading="lazy" decoding="async" data-id="${key}" data-url="${fullPreviewUrl}" data-aluno="${meta.alunoNome || ''}" data-professor="${meta.profNome || ''}" data-matricula="${meta.matriculaValue || ''}" data-data="${meta.created || ''}" alt="Prévia" class="queue-image w-full h-40 object-cover rounded-md border border-gray-200 cursor-zoom-in">`
        : `
            <div class="w-full h-40 flex flex-col items-center justify-center gap-2 bg-gray-100 rounded-md border border-gray-200 text-xs text-gray-500">
                <span>${previewMissing ? 'Imagem indisponível no storage' : 'Prévia sob demanda'}</span>
                ${previewMissing ? '' : `<button type="button" class="queue-preview-btn px-2 py-1 text-xs font-semibold rounded-md bg-gray-200 text-gray-700 hover:bg-gray-300" data-id="${key}">Carregar prévia</button>`}
            </div>
        `;

    return `
        <div class="queue-card bg-gray-50 border border-gray-200 rounded-lg p-3 flex flex-col gap-2" data-id="${key}">
            ${previewHtml}
            <div class="space-y-1 text-xs leading-tight">
                <div class="flex items-center justify-between gap-2 text-gray-500">
                    <span>Enviado em: ${meta.created}</span>
                    <span>Status: <strong class="text-gray-700">${meta.statusLabel}</strong></span>
                </div>
                ${meta.sizeLabel ? `<div class="text-[11px] text-gray-500">Tamanho: <span class="font-semibold text-gray-700">${meta.sizeLabel}</span></div>` : ''}
                <div class="text-gray-600">Aluno: <span class="font-semibold text-gray-800">${meta.alunoNome || '-'}</span></div>
                <div class="text-gray-600">Professor: <span class="font-semibold text-gray-800">${meta.profNome || '-'}</span></div>
            </div>
            ${meta.driveLink}
            <div class="flex flex-col gap-2">
                <div class="flex gap-2">
                    <button type="button" class="queue-select-btn flex-1 px-3 py-2 text-xs font-semibold rounded-md bg-blue-600 text-white hover:bg-blue-700"
                        data-id="${key}">
                        Selecionar para cadastro
                    </button>
                    <button type="button" class="queue-delete-btn px-3 py-2 text-xs font-semibold rounded-md ${meta.deleteDisabled ? 'bg-gray-200 text-gray-500 cursor-not-allowed' : 'bg-red-600 text-white hover:bg-red-700'}"
                        data-id="${key}" data-path="${job.storage_path || ''}" ${meta.deleteDisabled ? 'disabled' : ''}>
                        Excluir
                    </button>
                </div>
                ${meta.canRetryDrive ? `
                <button type="button" class="queue-drive-btn w-full px-3 py-2 text-xs font-semibold rounded-md bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                    data-id="${key}">
                    Reenviar ao Drive
                </button>
                ` : ''}
            </div>
        </div>
    `;
}

function renderQueue() {
    const list = document.getElementById('queue-list');
    const countEl = document.getElementById('queue-count');
    if (!list || !countEl) return;

    const total = state.jobs.length;
    countEl.textContent = total;

    if (total === 0) {
        list.innerHTML = '<p class="text-sm text-gray-500">Nenhuma imagem na fila.</p>';
        return;
    }

    const visibleJobs = state.jobs.slice(0, state.visibleCount);
    const remaining = Math.max(0, total - visibleJobs.length);
    const cardsHtml = visibleJobs.map(renderQueueCard).join('');
    const loadMoreHtml = remaining > 0
        ? `
        <div class="queue-load-more-wrap col-span-full py-2">
            <button type="button" class="queue-load-more-btn px-3 py-2 text-xs font-semibold rounded-md bg-white text-slate-700 border border-slate-300 hover:bg-slate-100">
                Carregar mais (${remaining})
            </button>
        </div>
        `
        : '';
    list.innerHTML = `${cardsHtml}${loadMoreHtml}`;
}

function initQueueInteractions() {
    if (state.queueEventsBound) return;
    const list = document.getElementById('queue-list');
    if (!list) return;

    list.addEventListener('click', async (event) => {
        const image = event.target.closest('.queue-image');
        if (image) {
            openZoom(image.getAttribute('data-url') || image.getAttribute('src') || '', {
                aluno: image.getAttribute('data-aluno') || '',
                professor: image.getAttribute('data-professor') || '',
                matricula: image.getAttribute('data-matricula') || '',
                data: image.getAttribute('data-data') || ''
            });
            return;
        }

        const button = event.target.closest('button');
        if (!button) return;

        if (button.classList.contains('queue-load-more-btn')) {
            state.visibleCount = Math.min(state.jobs.length, state.visibleCount + LOAD_MORE_STEP);
            renderQueue();
            void warmSignedUrls(state.previewToken);
            return;
        }

        const id = button.getAttribute('data-id');
        if (!id) return;

        if (button.classList.contains('queue-preview-btn')) {
            await loadPreviewForJob(id, button);
            return;
        }

        if (button.classList.contains('queue-select-btn')) {
            const params = new URLSearchParams(window.location.search);
            const editId = params.get('editId');
            const target = editId
                ? `encaminhamento.html?scanId=${encodeURIComponent(id)}&editId=${encodeURIComponent(editId)}`
                : `encaminhamento.html?scanId=${encodeURIComponent(id)}`;
            window.location.href = target;
            return;
        }

        if (button.classList.contains('queue-delete-btn')) {
            const path = button.getAttribute('data-path');
            if (!window.confirm('Deseja excluir esta imagem da fila?')) return;
            try {
                await removeFromEncTempWithFallback(path);
                await safeQuery(db.from('enc_scan_jobs').delete().eq('id', id));
                await loadQueue();
            } catch (err) {
                showAppMessage('Falha ao excluir da fila.', { type: 'error', title: 'Fila de scans' });
                console.error(err);
            }
            return;
        }

        if (button.classList.contains('queue-drive-btn')) {
            await retryDriveUpload(id, button);
        }
    });

    state.queueEventsBound = true;
}

async function retryDriveUpload(jobId, button) {
    const job = state.jobsById.get(getJobIdKey(jobId));
    if (!job || !job.storage_path) return;
    if (!job.encaminhamento_id) {
        showAppMessage('Este scan ainda nao esta vinculado a um encaminhamento.', { type: 'error', title: 'Fila de scans' });
        return;
    }

    const originalText = button?.textContent || 'Reenviar ao Drive';
    if (button) {
        button.disabled = true;
        button.textContent = 'Enviando...';
        button.classList.add('opacity-50', 'cursor-not-allowed');
    }

    try {
        const years = Array.from(new Set([
            getYearFromDateString(job.created_at),
            getCurrentYear()
        ])).filter(Boolean);

        let encData = null;
        for (const year of years) {
            try {
                await ensureEncaminhamentosTableReady(year);
                const table = getEncaminhamentosTableName(year);
                const { data } = await safeQuery(
                    db.from(table)
                        .select('id,codigo,data_encaminhamento')
                        .eq('id', job.encaminhamento_id)
                        .maybeSingle()
                );
                if (data?.codigo && data?.data_encaminhamento) {
                    encData = data;
                    break;
                }
            } catch (err) {
                // tenta próximo ano
            }
        }

        if (!encData) {
            throw new Error(`Não foi possível localizar o encaminhamento #${job.encaminhamento_id} para reenviar ao Drive.`);
        }

        const payload = {
            storage_path: job.storage_path,
            codigo: encData.codigo,
            data_encaminhamento: encData.data_encaminhamento,
            mime_type: job.mime_type || 'image/jpeg'
        };
        const { data, error } = await db.functions.invoke('enc_drive_upload', { body: payload });
        if (error) throw error;

        const driveUrl = data?.webViewLink || data?.drive_url || null;
        const driveFileId = data?.file_id || null;
        if (!driveFileId && !driveUrl) {
            throw new Error('Drive não retornou file_id/link.');
        }

        await safeQuery(
            db.from('enc_scan_jobs')
                .update({
                    drive_url: driveUrl,
                    drive_file_id: driveFileId,
                    status: 'vinculado'
                })
                .eq('id', job.id)
        );

        await removeFromEncTempWithFallback(job.storage_path);

        await loadQueue();
        showAppMessage(`Arquivo ${encData.codigo} reenviado ao Drive com sucesso.`, { type: 'success', title: 'Concluido' });
    } catch (err) {
        showAppMessage(err?.message || 'Falha ao reenviar ao Drive.', { type: 'error', title: 'Falha no reenvio' });
        console.error('retryDriveUpload error:', err);
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText;
            button.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    }
}

function renderQueueError() {
    const list = document.getElementById('queue-list');
    if (!list) return;
    list.innerHTML = '<p class="text-sm text-red-600">Erro ao carregar a fila. Tente novamente.</p>';
}

function formatFileSize(bytes) {
    const size = Number(bytes || 0);
    if (!size || size <= 0) return '';
    if (size < 1024) return `${size} B`;
    const kb = size / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(2)} MB`;
}

async function reprocessOcr(jobId, button) {
    if (!window.Tesseract) {
        showAppMessage('OCR nao disponivel. Verifique a conexao e recarregue a pagina.', { type: 'error', title: 'Reprocessar OCR' });
        return;
    }
    const job = state.jobsById.get(getJobIdKey(jobId));
    if (!job) return;
    let previewUrl = state.signedUrls.get(String(job.id));
    if (!previewUrl) {
        await ensureSignedUrlForJob(job);
        previewUrl = state.signedUrls.get(String(job.id));
    }
    if (!previewUrl) {
        showAppMessage('Previa nao disponivel para reprocessar.', { type: 'error', title: 'Reprocessar OCR' });
        return;
    }
    const originalText = button?.textContent || 'Reprocessar OCR';
    if (button) {
        button.disabled = true;
        button.textContent = 'Processando...';
        button.classList.add('opacity-50', 'cursor-not-allowed');
    }
    try {
        const response = await fetch(previewUrl);
        if (!response.ok) throw new Error('Falha ao baixar a imagem.');
        const blob = await response.blob();
        const ocrJson = await runOcrFromBlob(blob);
        if (!ocrJson) throw new Error('OCR não retornou dados.');
        const visionOcr = await runVisionOcrForJob(job);
        const baseFields = ocrJson.fields || {};
        const visionFields = visionOcr?.fields || {};
        const mergedRawText = visionOcr?.raw_text || visionOcr?.header_text || ocrJson.raw_text || '';
        let mergedProfessor = pickBestNameField(baseFields.professor, visionFields.professor);
        mergedProfessor = pickBestNameField(
            mergedProfessor,
            pickBestNameFromRawTexts(
                extractProfessorFromRawText,
                visionOcr?.header_text || '',
                visionOcr?.raw_text || '',
                ocrJson.header_text || '',
                ocrJson.raw_text || ''
            )
        );
        let mergedEstudante = pickBestNameField(baseFields.estudante, visionFields.estudante);
        mergedEstudante = pickBestNameField(
            mergedEstudante,
            pickBestNameFromRawTexts(
                extractAlunoFromRawText,
                visionOcr?.header_text || '',
                visionOcr?.raw_text || '',
                ocrJson.header_text || '',
                ocrJson.raw_text || ''
            )
        );
        const mergedFields = {
            ...baseFields,
            professor: mergedProfessor,
            estudante: mergedEstudante,
            matricula: pickBestGenericField(baseFields.matricula, visionFields.matricula),
            data: pickBestGenericField(baseFields.data, visionFields.data),
            turma: pickBestGenericField(baseFields.turma, visionFields.turma)
        };
        const mergedOcr = {
            ...ocrJson,
            ...(visionOcr?.header_text ? { header_text: visionOcr.header_text } : {}),
            ...(mergedRawText ? { raw_text: mergedRawText } : {}),
            fields: mergedFields
        };
        const updatePayload = { ocr_json: mergedOcr };
        if (mergedFields?.matricula) {
            updatePayload.aluno_matricula = mergedFields.matricula;
        }
        await safeQuery(
            db.from('enc_scan_jobs')
                .update(updatePayload)
                .eq('id', jobId)
        );
        job.ocr_json = mergedOcr;
        if (mergedFields?.matricula) job.aluno_matricula = mergedFields.matricula;
        await loadQueue();
        showAppMessage('OCR reprocessado com sucesso.', { type: 'success', title: 'Concluido' });
    } catch (err) {
        showAppMessage(err?.message || 'Falha ao reprocessar OCR.', { type: 'error', title: 'Reprocessar OCR' });
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText;
            button.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    }
}

async function runVisionOcrForJob(job) {
    if (!job?.storage_path) return null;
    try {
        const { data: sessionData } = await db.auth.getSession();
        const accessToken = sessionData?.session?.access_token || '';
        if (!accessToken) return null;
        const resp = await fetch(`${SUPABASE_URL}/functions/v1/enc_vision_ocr`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${accessToken}`
            },
            body: JSON.stringify({ storage_path: job.storage_path })
        });
        const text = await resp.text();
        if (!resp.ok) {
            console.warn('Vision OCR HTTP', resp.status, text);
            return null;
        }
        try {
            return JSON.parse(text);
        } catch (err) {
            console.warn('Vision OCR JSON inválido:', err?.message || err);
            return null;
        }
    } catch (err) {
        console.warn('Falha no OCR Vision:', err?.message || err);
        return null;
    }
}

async function ensureOcrBeforeRedirect(jobId, button) {
    const job = state.jobsById.get(getJobIdKey(jobId));
    if (!job) return;
    const fields = job.ocr_json?.fields || {};
    const currentAluno = sanitizeOcrName(fields.estudante || extractAlunoFromRawText(job.ocr_json?.raw_text || ''));
    const currentProfessor = sanitizeOcrName(fields.professor || extractProfessorFromRawText(job.ocr_json?.raw_text || ''));
    if (currentAluno && currentProfessor) return;

    const originalText = button?.textContent || 'Selecionar para cadastro';
    if (button) {
        button.disabled = true;
        button.textContent = 'Buscando aluno/professor...';
        button.classList.add('opacity-50', 'cursor-not-allowed');
    }
    try {
        let localOcr = null;
        let previewUrl = state.signedUrls.get(String(job.id));
        if (!previewUrl) {
            await ensureSignedUrlForJob(job);
            previewUrl = state.signedUrls.get(String(job.id));
        }
        if (previewUrl && window.Tesseract) {
            try {
                const resp = await fetch(previewUrl);
                if (resp.ok) {
                    const blob = await resp.blob();
                    localOcr = await runOcrFromBlob(blob);
                }
            } catch (err) {
                console.warn('Falha no OCR local antes do cadastro:', err?.message || err);
            }
        }

        const visionOcr = await runVisionOcrForJob(job);
        const localFields = localOcr?.fields || {};
        const visionFields = visionOcr?.fields || {};
        const rawLocal = localOcr?.raw_text || '';
        const rawVisionHeader = visionOcr?.header_text || '';
        const rawVision = visionOcr?.raw_text || '';
        const mergedRawText = rawVision || rawVisionHeader || rawLocal || job.ocr_json?.raw_text || '';

        let mergedProfessor = pickBestNameField(
            pickBestNameField(fields.professor, localFields.professor),
            visionFields.professor
        );
        mergedProfessor = pickBestNameField(
            mergedProfessor,
            pickBestNameFromRawTexts(extractProfessorFromRawText, rawVisionHeader, rawVision, rawLocal, job.ocr_json?.header_text || '', job.ocr_json?.raw_text || '')
        );

        let mergedEstudante = pickBestNameField(
            pickBestNameField(fields.estudante, localFields.estudante),
            visionFields.estudante
        );
        mergedEstudante = pickBestNameField(
            mergedEstudante,
            pickBestNameFromRawTexts(extractAlunoFromRawText, rawVisionHeader, rawVision, rawLocal, job.ocr_json?.header_text || '', job.ocr_json?.raw_text || '')
        );

        const mergedFields = {
            ...fields,
            professor: mergedProfessor,
            estudante: mergedEstudante,
            matricula: pickBestGenericField(
                pickBestGenericField(fields.matricula, localFields.matricula),
                visionFields.matricula
            ),
            data: pickBestGenericField(
                pickBestGenericField(fields.data, localFields.data),
                visionFields.data
            ),
            turma: pickBestGenericField(
                pickBestGenericField(fields.turma, localFields.turma),
                visionFields.turma
            )
        };

        const mergedOcr = {
            ...(job.ocr_json || {}),
            ...(visionOcr?.header_text ? { header_text: visionOcr.header_text } : {}),
            ...(mergedRawText ? { raw_text: mergedRawText } : {}),
            fields: mergedFields
        };

        const updatePayload = { ocr_json: mergedOcr };
        if (mergedFields?.matricula) updatePayload.aluno_matricula = mergedFields.matricula;
        await safeQuery(db.from('enc_scan_jobs').update(updatePayload).eq('id', jobId));
        job.ocr_json = mergedOcr;
        if (mergedFields?.matricula) job.aluno_matricula = mergedFields.matricula;
    } catch (err) {
        console.warn('Falha ao forçar OCR antes do cadastro:', err?.message || err);
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText;
            button.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    }
}

let zoomScale = 1;
let zoomMeta = null;
let zoomOffsetX = 0;
let zoomOffsetY = 0;
let zoomDragging = false;
let zoomDragStartX = 0;
let zoomDragStartY = 0;
function openZoom(url, meta = null) {
    const modal = document.getElementById('zoom-modal');
    const img = document.getElementById('zoom-image');
    const printBtn = document.getElementById('zoom-print-btn');
    if (!modal || !img || !url) return;
    img.src = url;
    zoomScale = 1;
    zoomOffsetX = 0;
    zoomOffsetY = 0;
    zoomMeta = meta;
    img.style.transform = `translate(0px, 0px) scale(${zoomScale})`;
    img.style.cursor = 'grab';
    img.style.userSelect = 'none';
    img.style.touchAction = 'none';
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

    const applyTransform = () => {
        img.style.transform = `translate(${zoomOffsetX}px, ${zoomOffsetY}px) scale(${zoomScale})`;
    };

    zoomIn?.addEventListener('click', () => {
        zoomScale = Math.min(3, zoomScale + 0.25);
        applyTransform();
    });
    zoomOut?.addEventListener('click', () => {
        zoomScale = Math.max(0.75, zoomScale - 0.25);
        applyTransform();
    });
    reset?.addEventListener('click', () => {
        zoomScale = 1;
        zoomOffsetX = 0;
        zoomOffsetY = 0;
        applyTransform();
    });

    const closeZoom = () => {
        zoomDragging = false;
        modal.classList.add('hidden');
    };

    img.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        zoomDragging = true;
        zoomDragStartX = event.clientX - zoomOffsetX;
        zoomDragStartY = event.clientY - zoomOffsetY;
        img.style.cursor = 'grabbing';
        img.setPointerCapture?.(event.pointerId);
        event.preventDefault();
    });

    img.addEventListener('pointermove', (event) => {
        if (!zoomDragging) return;
        zoomOffsetX = event.clientX - zoomDragStartX;
        zoomOffsetY = event.clientY - zoomDragStartY;
        applyTransform();
        event.preventDefault();
    });

    const stopDrag = (event) => {
        if (!zoomDragging) return;
        zoomDragging = false;
        img.style.cursor = 'grab';
        if (event?.pointerId !== undefined) {
            img.releasePointerCapture?.(event.pointerId);
        }
    };

    img.addEventListener('pointerup', stopDrag);
    img.addEventListener('pointercancel', stopDrag);
    img.addEventListener('pointerleave', stopDrag);

    closeBtn?.addEventListener('click', closeZoom);
    modal.addEventListener('click', (event) => {
        if (event.target === modal) closeZoom();
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

async function runOcrFromBlob(blob) {
    if (!window.Tesseract) return null;
    try {
        const image = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0);
        preprocessCanvas(ctx, canvas.width, canvas.height);

        const result = await window.Tesseract.recognize(canvas, 'por', {
            logger: () => {},
            tessedit_pageseg_mode: 6,
            preserve_interword_spaces: '1'
        });
        const data = result?.data;
        if (!data) return null;

        const headerData = await runHeaderOcr(image);
        const headerFields = headerData ? extractHeaderFields(headerData, headerData.width || 0, headerData.height || 0) : null;
        const fields = mergeHeaderFields(headerFields, extractHeaderFields(data, canvas.width, canvas.height));
        const cropFields = await extractHeaderFieldsByCrop(image);
        const mergedFields = mergeHeaderFields(cropFields, fields);

        const motivos = extractCheckedLabels(data, ctx, motivoDefs, canvas.width);
        const acoes = extractCheckedLabels(data, ctx, acaoDefs, canvas.width);
        const providencias = extractCheckedLabels(data, ctx, providenciaDefs, canvas.width);

        return {
            fields: mergedFields,
            motivos,
            acoes,
            providencias,
            raw_text: data.text || '',
            header_text: headerData?.text || ''
        };
    } catch (err) {
        console.warn('OCR falhou:', err?.message || err);
        return null;
    }
}

async function runHeaderOcr(image) {
    try {
        const headerCanvas = document.createElement('canvas');
        const headerHeight = Math.floor(image.height * 0.5);
        const scale = 1.5;
        headerCanvas.width = Math.floor(image.width * scale);
        headerCanvas.height = Math.floor(headerHeight * scale);
        const hctx = headerCanvas.getContext('2d', { willReadFrequently: true });
        hctx.drawImage(
            image,
            0,
            0,
            image.width,
            headerHeight,
            0,
            0,
            headerCanvas.width,
            headerCanvas.height
        );
        preprocessCanvas(hctx, headerCanvas.width, headerCanvas.height);

        const headerResult = await window.Tesseract.recognize(headerCanvas, 'por', {
            logger: () => {},
            tessedit_pageseg_mode: 6,
            preserve_interword_spaces: '1'
        });
        const headerData = headerResult?.data;
        if (!headerData) return null;
        return { ...headerData, width: headerCanvas.width, height: headerCanvas.height };
    } catch (err) {
        return null;
    }
}

function mergeHeaderFields(primary, fallback) {
    const base = fallback || { professor: '', estudante: '', turma: '', data: '', matricula: '' };
    if (!primary) return base;
    return {
        professor: primary.professor || base.professor || '',
        estudante: primary.estudante || base.estudante || '',
        turma: primary.turma || base.turma || '',
        data: primary.data || base.data || '',
        matricula: primary.matricula || base.matricula || ''
    };
}

const headerCropDefs = [
    { key: 'professor', x: 0.26, y: 0.17, w: 0.70, h: 0.07, type: 'name' },
    { key: 'estudante', x: 0.23, y: 0.23, w: 0.72, h: 0.07, type: 'name' },
    { key: 'turma', x: 0.18, y: 0.29, w: 0.28, h: 0.07, type: 'text' },
    { key: 'matricula', x: 0.64, y: 0.29, w: 0.32, h: 0.07, type: 'digits' },
    { key: 'data', x: 0.16, y: 0.34, w: 0.26, h: 0.07, type: 'date' }
];

async function extractHeaderFieldsByCrop(image) {
    const result = { professor: '', estudante: '', turma: '', data: '', matricula: '' };
    for (const def of headerCropDefs) {
        const text = await runSingleLineOcrWithOffsets(image, def);
        if (!text) continue;
        if (def.type === 'digits') {
            const digits = text.replace(/\D+/g, '').trim();
            if (digits.length >= 4) result[def.key] = digits;
            continue;
        }
        if (def.type === 'date') {
            const dateValue = extractDateFromText(text);
            if (dateValue) result[def.key] = dateValue;
            continue;
        }
        if (def.type === 'name') {
            const cleaned = cleanHeaderText(text);
            if (cleaned) result[def.key] = cleaned;
            continue;
        }
        const cleaned = cleanHeaderText(text);
        if (cleaned) result[def.key] = cleaned;
    }
    return result;
}

async function runSingleLineOcrWithOffsets(image, def) {
    const offsets = [-0.015, 0, 0.015];
    let bestText = '';
    let bestScore = 0;
    for (const offset of offsets) {
        const candidate = await runSingleLineOcr(image, { ...def, y: Math.max(0, def.y + offset) });
        const score = scoreHeaderCandidate(candidate, def.type);
        if (score > bestScore) {
            bestScore = score;
            bestText = candidate;
        }
    }
    return bestText;
}

function scoreHeaderCandidate(text, type) {
    const raw = (text || '').trim();
    if (!raw) return 0;
    if (type === 'digits') return raw.replace(/\D+/g, '').length;
    if (type === 'date') return extractDateFromText(raw) ? 10 : 0;
    const letters = (raw.match(/[a-zà-ÿ]/gi) || []).length;
    return letters;
}

async function runSingleLineOcr(image, def) {
    try {
        const canvas = document.createElement('canvas');
        const scale = 2;
        const sx = Math.max(0, Math.floor(image.width * def.x));
        const sy = Math.max(0, Math.floor(image.height * def.y));
        const sw = Math.max(1, Math.floor(image.width * def.w));
        const sh = Math.max(1, Math.floor(image.height * def.h));
        canvas.width = Math.floor(sw * scale);
        canvas.height = Math.floor(sh * scale);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        preprocessCanvas(ctx, canvas.width, canvas.height);

        const whitelist = def.type === 'digits'
            ? '0123456789'
            : def.type === 'date'
                ? '0123456789/'
                : 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÀÁÂÃÇÉÊÍÓÔÕÚàáâãçéêíóôõú ';

        const { data } = await window.Tesseract.recognize(canvas, 'por', {
            logger: () => {},
            tessedit_pageseg_mode: 7,
            preserve_interword_spaces: '1',
            tessedit_char_whitelist: whitelist
        });
        return (data?.text || '').trim();
    } catch (err) {
        return '';
    }
}

function cleanHeaderText(text) {
    return (text || '')
        .replace(/(?:professor|professora|estudante|aluno|turma|data|matr[íi]cula)/gi, ' ')
        .replace(/[|_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeNameCandidate(text) {
    return (text || '')
        .replace(/[|_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isLikelyPersonName(text) {
    const cleaned = normalizeNameCandidate(text);
    if (!cleaned) return false;
    if (/\d/.test(cleaned)) return false;

    const words = cleaned.split(' ').filter(Boolean);
    if (words.length < 2) {
        const letters = (cleaned.match(/[a-zà-ÿ]/gi) || []).length;
        return cleaned.length >= 5 && letters >= Math.max(4, Math.floor(cleaned.length * 0.7));
    }

    const meaningfulWords = words.filter(word => /[a-zà-ÿ]{2,}/i.test(word));
    if (meaningfulWords.length < 2) return false;

    const letters = (cleaned.match(/[a-zà-ÿ]/gi) || []).length;
    return letters >= Math.max(6, Math.floor(cleaned.length * 0.7));
}

function startsWithKnownFieldLabel(text) {
    const normalized = normalizeText(text);
    return /^(?:professor|profes+sor|profe+sor|profes0r|aluno|alun0|estudante|turma|data|matri|matricula|matr1)/i.test(normalized);
}

function extractValueAfterLabel(text, pattern) {
    const match = (text || '').match(pattern);
    if (!match) return '';
    return (match[1] || '').replace(/^[\s:;.,|_-]+/, '').trim();
}

function getOrderedOcrLines(data) {
    const lines = Array.isArray(data?.lines) ? [...data.lines] : [];
    if (lines.length > 0) {
        return lines
            .filter(line => (line?.text || '').trim())
            .sort((a, b) => {
                const ay = a?.bbox?.y0 ?? 0;
                const by = b?.bbox?.y0 ?? 0;
                if (ay !== by) return ay - by;
                const ax = a?.bbox?.x0 ?? 0;
                const bx = b?.bbox?.x0 ?? 0;
                return ax - bx;
            })
            .map(line => ({ text: line.text || '', bbox: line.bbox || null }));
    }

    return (data?.text || '')
        .split(/\r?\n/)
        .map(text => ({ text, bbox: null }))
        .filter(line => line.text.trim());
}

function getHeaderCandidateLines(lines, imageWidth, imageHeight) {
    if (!Array.isArray(lines) || lines.length === 0) return [];
    if (!imageWidth && !imageHeight) return lines;

    const maxY = imageHeight ? imageHeight * 0.45 : null;
    const maxX = imageWidth ? imageWidth * 0.85 : null;
    const filtered = lines.filter(line => {
        const bbox = line?.bbox;
        if (!bbox) return true;
        if (maxY !== null && bbox.y0 > maxY) return false;
        if (maxX !== null && bbox.x0 > maxX) return false;
        return true;
    });

    return filtered.length ? filtered : lines;
}

function extractFieldFromLines(lines, pattern, options = {}) {
    const { digitsOnly = false, normalizedPattern = null } = options;

    for (let index = 0; index < lines.length; index += 1) {
        const raw = (lines[index]?.text || '').trim();
        if (!raw) continue;
        const normalized = normalizeText(raw);

        const directValue = extractValueAfterLabel(raw, pattern);
        if (directValue) {
            return digitsOnly ? directValue.replace(/\D+/g, '').trim() : directValue;
        }

        const matchesLabel = normalizedPattern ? normalizedPattern.test(normalized) : pattern.test(raw);
        if (!matchesLabel) continue;

        for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
            const nextRaw = (lines[nextIndex]?.text || '').trim();
            if (!nextRaw) continue;
            if (startsWithKnownFieldLabel(nextRaw)) return '';
            return digitsOnly ? nextRaw.replace(/\D+/g, '').trim() : nextRaw;
        }
    }

    return '';
}

function extractDateFromText(text) {
    const raw = (text || '').trim();
    if (!raw) return '';
    const match = raw.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
    if (match) return match[0];
    const isoMatch = raw.match(/\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/);
    if (isoMatch) return isoMatch[0];
    return '';
}

function extractHeaderFieldsFromLines(lines) {
    const fields = { professor: '', estudante: '', turma: '', data: '', matricula: '' };
    const professorLabelPattern = /(?:professor|profes+sor|profe+sor|profes0r|profesor)/;
    const alunoLabelPattern = /(?:aluno|alun0|estudante|estudant[ea3]?)/;
    const matriculaLabelPattern = /(?:matricula|matricu1a|matricuia|matr1cula|matri?cula)/;
    const dataLabelPattern = /(?:data|dat[a4])/;

    fields.professor = extractFieldFromLines(lines, /prof(?:e|o|0)?s{1,2}or(?:\(a\))?\s*[:;\-_.|]*\s*(.*)$/i, {
        normalizedPattern: professorLabelPattern
    });
    fields.estudante = extractFieldFromLines(lines, /(?:estudante|aluno)\s*[:;\-_.|]*\s*(.*)$/i, {
        normalizedPattern: alunoLabelPattern
    });
    fields.turma = extractFieldFromLines(lines, /turma\s*[:;\-_.|]*\s*(.*)$/i);
    fields.data = extractFieldFromLines(lines, /data\s*[:;\-_.|]*\s*(.*)$/i, {
        normalizedPattern: dataLabelPattern
    });
    fields.matricula = extractFieldFromLines(lines, /matr(?:[íi]cula|icula|icu1a|icuia)\s*[:;\-_.|]*\s*(.*)$/i, {
        digitsOnly: true,
        normalizedPattern: matriculaLabelPattern
    });

    if (!fields.data) {
        for (const line of lines) {
            const dateValue = extractDateFromText(line?.text || '');
            if (dateValue) {
                fields.data = dateValue;
                break;
            }
        }
    }

    if (!fields.estudante || !fields.professor) {
        const candidates = [];
        for (const line of lines) {
            const raw = (line?.text || '').trim();
            if (!raw) continue;
            const normalized = normalizeText(raw);
            if (/^(?:aluno|estudante|professor|professora|turma|data|matricula)\b/.test(normalized)) continue;
            if (/encaminhamento|orientacao|coordenacao|unidade|profissionais|escola/.test(normalized)) continue;
            if (!isLikelyPersonName(raw)) continue;
            candidates.push(raw);
        }
        if (!fields.estudante && candidates[0]) fields.estudante = candidates[0];
        if (!fields.professor) {
            const next = candidates.find(name => normalizeText(name) !== normalizeText(fields.estudante || ''));
            if (next) fields.professor = next;
        }
    }

    return fields;
}

function extractHeaderFields(data, imageWidth, imageHeight) {
    const lines = getOrderedOcrLines(data);
    const headerLines = getHeaderCandidateLines(lines, imageWidth, imageHeight);
    const headerFields = extractHeaderFieldsFromLines(headerLines);
    const fallbackFields = extractHeaderFieldsFromLines(lines);
    const fields = {
        professor: headerFields.professor || fallbackFields.professor || '',
        estudante: headerFields.estudante || fallbackFields.estudante || '',
        turma: headerFields.turma || fallbackFields.turma || '',
        data: headerFields.data || fallbackFields.data || '',
        matricula: headerFields.matricula || fallbackFields.matricula || ''
    };

    if (!fields.matricula) {
        const match = (data.text || '').match(/matr[íi]cula[^\d]*([0-9]{4,})/i);
        if (match) fields.matricula = match[1];
    }
    if (!fields.data) {
        const dateMatch = (data.text || '').match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
        if (dateMatch) fields.data = dateMatch[0];
    }

    fields.professor = cleanName(fields.professor);
    fields.estudante = cleanName(fields.estudante);
    if (fields.matricula && fields.matricula.length < 4) {
        fields.matricula = '';
    }
    return fields;
}

function cleanName(value) {
    const text = normalizeNameCandidate(value);
    if (!text) return '';
    if (text.length < 3) return '';
    if (/^(?:aluno|estudante|professor(?:a)?|turma|data|matricula)$/i.test(normalizeText(text))) return '';
    if (/profissionais|unidade escolar|acima citado|direcionado/i.test(text)) return '';
    if (!isLikelyPersonName(text)) return '';
    return text;
}

const motivoDefs = [
    { label: 'Indisciplina / Xingamentos', tokens: ['indisciplina', 'indiscip', 'xing', 'xinga'], minHits: 1, section: 'motivo' },
    { label: 'Gazeando aula', tokens: ['gazeando', 'gazendo', 'gaz'], minHits: 1, section: 'motivo' },
    { label: 'Agressão / Bullying / Discriminação', tokens: ['agressao', 'bullying', 'discrimin'], minHits: 1, section: 'motivo' },
    { label: 'Uso de celular / fone de ouvido', tokens: ['celular', 'fone', 'ouvido', 'uso'], minHits: 1, section: 'motivo' },
    { label: 'Dificuldade de aprendizado', tokens: ['dificuldade', 'aprendizado', 'aprendiz'], minHits: 1, section: 'motivo' },
    { label: 'Desrespeito com professor / profissionais da unidade escolar', tokens: ['desrespeito', 'professor', 'profissionais', 'unidade'], minHits: 1, section: 'motivo' },
    { label: 'Não produz e não participa em sala', tokens: ['nao produz', 'nao participa', 'produz', 'participa'], minHits: 1, section: 'motivo' }
];

const acaoDefs = [
    { label: 'Diálogo com o estudante', tokens: ['dialogo', 'estudante'], minHits: 1, section: 'acao' },
    { label: 'Comunicado aos responsáveis', tokens: ['comunicado', 'responsaveis', 'responsavel'], minHits: 1, section: 'acao' },
    { label: 'Mensagem via WhatsApp', tokens: ['mensagem', 'whatsapp'], minHits: 1, section: 'acao' }
];

const providenciaDefs = [
    { label: 'Solicitar comparecimento do responsável na escola', tokens: ['comparecimento', 'responsavel'], minHits: 1, section: 'acao' },
    { label: 'Advertência', tokens: ['advertencia', 'advertencia', 'advert'], minHits: 1, section: 'acao' }
];

function extractCheckedLabels(data, ctx, defs, imageWidth) {
    const lines = data.lines || [];
    const bounds = getSectionBounds(lines, ctx?.canvas?.height || 0);
    const checked = [];
    defs.forEach(def => {
        const line = findBestLineForDef(lines, def, bounds);
        if (!line) return;
        if (!line.bbox) return;
        if (imageWidth && line.bbox.x0 > imageWidth * 0.65) return;
        const isChecked = detectMarkLeft(ctx, line.bbox);
        if (isChecked) checked.push(def.label);
    });
    return checked;
}

function findBestLineForDef(lines, def, bounds) {
    const minHits = def.minHits || 1;
    const section = def.section || '';
    let best = null;
    let bestScore = 0;
    for (const line of lines) {
        if (section && bounds && line?.bbox) {
            const range = bounds[section];
            if (range && (line.bbox.y0 < range.min || line.bbox.y0 > range.max)) {
                continue;
            }
        }
        const norm = normalizeText(line.text);
        if (!norm) continue;
        let score = 0;
        for (const token of def.tokens) {
            if (norm.includes(token)) score += 1;
        }
        if (score > bestScore) {
            bestScore = score;
            best = line;
        }
    }
    if (bestScore >= minHits) return best;
    return null;
}

function getSectionBounds(lines, imageHeight) {
    const bounds = {
        motivo: { min: 0, max: Infinity },
        acao: { min: 0, max: Infinity }
    };
    const normalizedLines = (lines || []).map(line => ({
        text: line?.text || '',
        norm: normalizeText(line?.text || ''),
        bbox: line?.bbox || null
    }));

    const motivoHeader = normalizedLines.find(line => line.norm.includes('educacional') && line.norm.includes('motivo'));
    const acaoHeader = normalizedLines.find(line => line.norm.includes('encaminhamentos') && line.norm.includes('orientacao'));

    if (motivoHeader?.bbox) {
        bounds.motivo.min = motivoHeader.bbox.y0;
    }
    if (acaoHeader?.bbox) {
        bounds.motivo.max = acaoHeader.bbox.y0;
        bounds.acao.min = acaoHeader.bbox.y0;
    }

    if (!motivoHeader && imageHeight) {
        bounds.motivo.min = imageHeight * 0.2;
        bounds.motivo.max = imageHeight * 0.6;
    }
    if (!acaoHeader && imageHeight) {
        bounds.acao.min = imageHeight * 0.6;
        bounds.acao.max = imageHeight * 0.95;
    }

    return bounds;
}

function detectMarkLeft(ctx, bbox) {
    const { x0, y0, x1, y1 } = bbox;
    const height = y1 - y0;
    const width = Math.max(20, height * 0.9);
    const y = Math.max(0, y0 - 3);
    const h = Math.max(10, height + 6);

    const x = Math.max(0, x0 - width - 14);
    const w = Math.max(10, width);
    if (isRegionCenterMarked(ctx, x, y, w, h, 0.12)) return true;
    if (isRegionCenterMarked(ctx, x, y, w, h, 0.2, 0.35)) return true;
    return isRegionInk(ctx, x, y, w, h, 0.03, 80);
}

function isRegionDark(ctx, x, y, w, h, threshold) {
    try {
        const safe = clampBox(ctx, x, y, w, h);
        const imageData = ctx.getImageData(safe.x, safe.y, safe.w, safe.h);
        const data = imageData.data;
        let dark = 0;
        const total = data.length / 4;
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const lum = (r + g + b) / 3;
            if (lum < 130) dark += 1;
        }
        const ratio = dark / total;
        return ratio > threshold;
    } catch (err) {
        return false;
    }
}

function isRegionCenterMarked(ctx, x, y, w, h, threshold, size = 0.5) {
    const box = Math.max(0.2, Math.min(0.6, size));
    const cx = x + Math.floor(w * (0.5 - box / 2));
    const cy = y + Math.floor(h * (0.5 - box / 2));
    const cw = Math.max(6, Math.floor(w * box));
    const ch = Math.max(6, Math.floor(h * box));
    return isRegionDark(ctx, cx, cy, cw, ch, threshold);
}

function isRegionInk(ctx, x, y, w, h, minRatio, minContrast) {
    try {
        const safe = clampBox(ctx, x, y, w, h);
        const imageData = ctx.getImageData(safe.x, safe.y, safe.w, safe.h);
        const data = imageData.data;
        let dark = 0;
        let min = 255;
        let max = 0;
        const total = data.length / 4;
        for (let i = 0; i < data.length; i += 4) {
            const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
            if (lum < 180) dark += 1;
            if (lum < min) min = lum;
            if (lum > max) max = lum;
        }
        const ratio = dark / total;
        const contrast = max - min;
        return ratio >= minRatio && contrast >= minContrast;
    } catch (err) {
        return false;
    }
}

function clampBox(ctx, x, y, w, h) {
    const maxW = ctx?.canvas?.width || 0;
    const maxH = ctx?.canvas?.height || 0;
    const safeX = Math.max(0, Math.min(x, maxW - 1));
    const safeY = Math.max(0, Math.min(y, maxH - 1));
    const safeW = Math.max(1, Math.min(w, maxW - safeX));
    const safeH = Math.max(1, Math.min(h, maxH - safeY));
    return { x: safeX, y: safeY, w: safeW, h: safeH };
}

function preprocessCanvas(ctx, width, height) {
    try {
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        const contrast = 1.3;
        const brightness = 8;
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const gray = (r * 0.299 + g * 0.587 + b * 0.114);
            const adj = Math.min(255, Math.max(0, (gray - 128) * contrast + 128 + brightness));
            data[i] = adj;
            data[i + 1] = adj;
            data[i + 2] = adj;
        }
        ctx.putImageData(imageData, 0, 0);
    } catch (err) {
        // ignore
    }
}

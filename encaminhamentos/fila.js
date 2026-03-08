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
        const allJobs = data || [];
        state.jobs = allJobs.filter(job => (job.status || 'novo') === 'novo');
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
    if (meaningfulWords.length < 2) {
        if (text.length < 5 || letters < Math.max(4, Math.floor(text.length * 0.7))) return '';
    }
    if (letters < Math.max(4, Math.floor(text.length * 0.7))) return '';
    return text;
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
        const rawText = job.ocr_json?.raw_text || '';
        const matriculaValue = job.aluno_matricula
            ? String(job.aluno_matricula)
            : (job.ocr_json?.fields?.matricula || extractMatricula(rawText) || '');
        const alunoNomeRaw = job.ocr_json?.fields?.estudante
            || extractLabelValue(rawText, /^(?:aluno|estudante)\b/, /^(?:aluno|estudante)\b/i);
        const profNomeRaw = job.ocr_json?.fields?.professor
            || extractLabelValue(rawText, /^(?:professor|professora)\b/, /^(?:professor|professora)\b/i);
        const alunoNome = sanitizeOcrName(alunoNomeRaw);
        const profNome = sanitizeOcrName(profNomeRaw);
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
                <div class="flex flex-col gap-2">
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
                    <button type="button" class="queue-ocr-btn w-full px-3 py-2 text-xs font-semibold rounded-md bg-slate-100 text-slate-700 hover:bg-slate-200"
                        data-id="${job.id}">
                        Reprocessar OCR
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

    document.querySelectorAll('.queue-ocr-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            if (!id) return;
            await reprocessOcr(id, btn);
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

async function reprocessOcr(jobId, button) {
    if (!window.Tesseract) {
        alert('OCR não disponível. Verifique a conexão e recarregue a página.');
        return;
    }
    const job = state.jobs.find(item => String(item.id) === String(jobId));
    if (!job) return;
    const previewUrl = state.signedUrls.get(job.id);
    if (!previewUrl) {
        alert('Prévia não disponível para reprocessar.');
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
        const updatePayload = { ocr_json: ocrJson };
        if (ocrJson.fields?.matricula) {
            updatePayload.aluno_matricula = ocrJson.fields.matricula;
        }
        await safeQuery(
            db.from('enc_scan_jobs')
                .update(updatePayload)
                .eq('id', jobId)
        );
        await loadQueue();
        alert('OCR reprocessado com sucesso.');
    } catch (err) {
        alert(err?.message || 'Falha ao reprocessar OCR.');
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

async function runOcrFromBlob(blob) {
    if (!window.Tesseract) return null;
    try {
        const image = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d');
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

        const motivos = extractCheckedLabels(data, ctx, motivoDefs, canvas.width);
        const acoes = extractCheckedLabels(data, ctx, acaoDefs, canvas.width);
        const providencias = extractCheckedLabels(data, ctx, providenciaDefs, canvas.width);

        return {
            fields,
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
        const hctx = headerCanvas.getContext('2d');
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
    const professorLabelPattern = /^(?:professor|profes+sor|profe+sor|profes0r|profesor)/;
    const alunoLabelPattern = /^(?:aluno|alun0|estudante|estudant[ea3]?)/;
    const matriculaLabelPattern = /^(?:matricula|matricu1a|matricuia|matr1cula|matri?cula)/;
    const dataLabelPattern = /^(?:data|dat[a4])/;

    fields.professor = extractFieldFromLines(lines, /^\s*prof(?:e|o|0)?s{1,2}or(?:\(a\))?\s*[:;\-_.|]*\s*(.*)$/i, {
        normalizedPattern: professorLabelPattern
    });
    fields.estudante = extractFieldFromLines(lines, /^\s*(?:estudante|aluno)\s*[:;\-_.|]*\s*(.*)$/i, {
        normalizedPattern: alunoLabelPattern
    });
    fields.turma = extractFieldFromLines(lines, /^\s*turma\s*[:;\-_.|]*\s*(.*)$/i);
    fields.data = extractFieldFromLines(lines, /^\s*data\s*[:;\-_.|]*\s*(.*)$/i, {
        normalizedPattern: dataLabelPattern
    });
    fields.matricula = extractFieldFromLines(lines, /^\s*matr(?:[íi]cula|icula|icu1a|icuia)\s*[:;\-_.|]*\s*(.*)$/i, {
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
        if (lineHasTextMark(line.text)) {
            checked.push(def.label);
            return;
        }
        if (!line.bbox) return;
        if (imageWidth && line.bbox.x0 > imageWidth * 0.75) return;
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

function lineHasTextMark(text) {
    const raw = (text || '').trim();
    if (!raw) return false;
    const compact = raw.replace(/\s+/g, '');
    if (/\([xXvV\/\\*\+\-✓]\)/.test(compact)) return true;
    if (/\[[xXvV\/\\*\+\-✓]\]/.test(compact)) return true;
    if (/^[xXvV✓]\b/.test(raw)) return true;
    return false;
}

function detectMarkLeft(ctx, bbox) {
    const { x0, y0, x1, y1 } = bbox;
    const height = y1 - y0;
    const width = Math.max(20, height * 0.9);
    const x = Math.max(0, x0 - width - 14);
    const y = Math.max(0, y0 - 3);
    const w = Math.max(10, width);
    const h = Math.max(10, height + 6);
    if (isRegionCenterMarked(ctx, x, y, w, h, 0.16)) return true;
    return isRegionDark(ctx, x, y, w, h, 0.1);
}

function isRegionDark(ctx, x, y, w, h, threshold) {
    try {
        const imageData = ctx.getImageData(x, y, w, h);
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

function isRegionCenterMarked(ctx, x, y, w, h, threshold) {
    const cx = x + Math.floor(w * 0.25);
    const cy = y + Math.floor(h * 0.25);
    const cw = Math.max(6, Math.floor(w * 0.5));
    const ch = Math.max(6, Math.floor(h * 0.5));
    return isRegionDark(ctx, cx, cy, cw, ch, threshold);
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

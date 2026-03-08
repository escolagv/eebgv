import { db, SUPABASE_URL, SUPABASE_ANON_KEY } from './js/core.js';

const params = new URLSearchParams(window.location.search);
const tokenFromQuery = params.get('token');
const tokenFromHref = (() => {
    const match = window.location.href.match(/token=([^&]+)/i);
    return match ? decodeURIComponent(match[1]) : '';
})();
const token = tokenFromQuery || tokenFromHref || '';

const tokenEl = document.getElementById('pwa-token');
const statusEl = document.getElementById('pwa-status');
const captureArea = document.getElementById('capture-area');
const openCameraBtn = document.getElementById('open-camera-btn');
const captureBtn = document.getElementById('capture-btn');
const retakeBtn = document.getElementById('retake-btn');
const uploadBtn = document.getElementById('upload-btn');
const uploadStatus = document.getElementById('upload-status');
const fileInput = document.getElementById('file-input');
const video = document.getElementById('camera-preview');
const canvas = document.getElementById('capture-canvas');

const deviceIdKey = 'enc_device_id';
let deviceId = localStorage.getItem(deviceIdKey);
if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(deviceIdKey, deviceId);
}

let cameraStream = null;
let capturedBlob = null;

if (tokenEl) {
    tokenEl.textContent = token ? `Token do dia: ${token}` : 'Token não informado.';
}

async function validateToken() {
    if (!token) {
        setStatus('Token não encontrado. Abra pelo QR.', true);
        return false;
    }
    setStatus('Validando QR...', false);
    try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/enc_qr_validate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify({ token, device_id: deviceId })
        });
        let payload = {};
        try {
            payload = await response.json();
        } catch (err) {
            payload = {};
        }
        if (!response.ok) {
            const msg = payload?.error || `Falha na validação (${response.status})`;
            throw new Error(msg);
        }
        const expiresAt = payload?.expires_at;
        if (expiresAt) {
            const time = new Date(expiresAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            setStatus(`Acesso liberado até ${time}.`, false);
        } else {
            setStatus('Acesso liberado.', false);
        }
        return true;
    } catch (err) {
        setStatus(err?.message || 'Falha na validação.', true);
        return false;
    }
}

function setStatus(message, isError) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.toggle('text-red-600', !!isError);
    statusEl.classList.toggle('text-gray-500', !isError);
}

function showCaptureArea(show) {
    if (!captureArea) return;
    captureArea.classList.toggle('hidden', !show);
}

async function openCamera() {
    if (!video) return;
    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        video.srcObject = cameraStream;
        video.classList.remove('hidden');
        captureBtn?.classList.remove('hidden');
        retakeBtn?.classList.add('hidden');
        canvas?.classList.add('hidden');
    } catch (err) {
        setStatus('Não foi possível abrir a câmera. Use o upload manual.', true);
    }
}

function stopCamera() {
    if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
        cameraStream = null;
    }
}

function capturePhoto() {
    if (!video || !canvas) return;
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, width, height);
    canvas.toBlob((blob) => {
        capturedBlob = blob;
        canvas.classList.remove('hidden');
        video.classList.add('hidden');
        captureBtn?.classList.add('hidden');
        retakeBtn?.classList.remove('hidden');
        uploadBtn?.classList.remove('hidden');
    }, 'image/jpeg', 0.92);
    stopCamera();
}

function resetCapture() {
    capturedBlob = null;
    uploadBtn?.classList.add('hidden');
    canvas?.classList.add('hidden');
    video?.classList.add('hidden');
    captureBtn?.classList.add('hidden');
    retakeBtn?.classList.add('hidden');
}

async function uploadBlob(blob, fileName) {
    if (!blob) return;
    uploadStatus.textContent = 'Lendo documento...';
    try {
        const ocrJson = await runOcr(blob);
        uploadStatus.textContent = 'Enviando...';
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const path = `enc_temp/${year}/${month}/${day}/${deviceId}/${Date.now()}_${fileName}`;

        const { error: uploadError } = await db.storage
            .from('enc_temp')
            .upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false });

        if (uploadError) throw uploadError;

        const { error: jobError } = await db
            .from('enc_scan_jobs')
            .insert({
                status: 'novo',
                storage_path: path,
                mime_type: blob.type || 'image/jpeg',
                device_id: deviceId,
                ocr_json: ocrJson || null
            });

        if (jobError) throw jobError;

        uploadStatus.textContent = 'Enviado para a fila com sucesso.';
        resetCapture();
        if (fileInput) fileInput.value = '';
    } catch (err) {
        uploadStatus.textContent = err?.message || 'Falha ao enviar.';
    }
}

async function runOcr(blob) {
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

function normalizeText(text) {
    return (text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/[^a-z0-9\s]/g, ' ')
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

function cleanName(value) {
    const text = normalizeNameCandidate(value);
    if (!text) return '';
    if (text.length < 3) return '';
    if (/^(?:aluno|estudante|professor(?:a)?|turma|data|matricula)$/i.test(normalizeText(text))) return '';
    if (/profissionais|unidade escolar|acima citado|direcionado/i.test(text)) return '';
    if (!isLikelyPersonName(text)) return '';
    return text;
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

openCameraBtn?.addEventListener('click', openCamera);
captureBtn?.addEventListener('click', capturePhoto);
retakeBtn?.addEventListener('click', () => {
    resetCapture();
    openCamera();
});

fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    capturedBlob = file;
    uploadBtn?.classList.remove('hidden');
    uploadStatus.textContent = '';
});

uploadBtn?.addEventListener('click', () => {
    if (!capturedBlob) return;
    uploadBlob(capturedBlob, capturedBlob.name || 'captura.jpg');
});

// Inicialização
(async () => {
    const ok = await validateToken();
    showCaptureArea(ok);
})();

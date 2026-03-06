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
            logger: () => {}
        });
        const data = result?.data;
        if (!data) return null;

        const fields = extractHeaderFields(data, canvas.width, canvas.height);
        const motivos = extractCheckedLabels(data, ctx, motivoDefs, canvas.width);
        const acoes = extractCheckedLabels(data, ctx, acaoDefs, canvas.width);
        const providencias = extractCheckedLabels(data, ctx, providenciaDefs, canvas.width);

        return {
            fields,
            motivos,
            acoes,
            providencias,
            raw_text: data.text || ''
        };
    } catch (err) {
        console.warn('OCR falhou:', err?.message || err);
        return null;
    }
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

function isLikelyPersonName(text) {
    const cleaned = (text || '').replace(/[|_]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) return false;
    if (/\d/.test(cleaned)) return false;

    const words = cleaned.split(' ').filter(Boolean);
    if (words.length < 2) return false;

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

    const maxY = imageHeight ? imageHeight * 0.35 : null;
    const maxX = imageWidth ? imageWidth * 0.6 : null;
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

function extractHeaderFields(data, imageWidth, imageHeight) {
    const fields = { professor: '', estudante: '', turma: '', data: '', matricula: '' };
    const lines = getOrderedOcrLines(data);
    const headerLines = getHeaderCandidateLines(lines, imageWidth, imageHeight);
    const professorLabelPattern = /^(?:professor|profes+sor|profe+sor|profes0r|profesor)/;
    const alunoLabelPattern = /^(?:aluno|alun0|estudante|estudant[ea3]?)/;
    const matriculaLabelPattern = /^(?:matricula|matricu1a|matricuia|matr1cula|matri?cula)/;

    fields.professor = extractFieldFromLines(headerLines, /^\s*prof(?:e|o|0)?s{1,2}or(?:\(a\))?[^\w]*(.*)$/i, {
        normalizedPattern: professorLabelPattern
    }) || extractFieldFromLines(lines, /^\s*prof(?:e|o|0)?s{1,2}or(?:\(a\))?[^\w]*(.*)$/i, {
        normalizedPattern: professorLabelPattern
    });
    fields.estudante = extractFieldFromLines(headerLines, /^\s*(?:estudante|aluno)[^\w]*(.*)$/i, {
        normalizedPattern: alunoLabelPattern
    }) || extractFieldFromLines(lines, /^\s*(?:estudante|aluno)[^\w]*(.*)$/i, {
        normalizedPattern: alunoLabelPattern
    });
    fields.turma = extractFieldFromLines(headerLines, /^\s*turma[^\w]*(.*)$/i) || extractFieldFromLines(lines, /^\s*turma[^\w]*(.*)$/i);
    fields.data = extractFieldFromLines(headerLines, /^\s*data[^\w]*(.*)$/i) || extractFieldFromLines(lines, /^\s*data[^\w]*(.*)$/i);
    fields.matricula = extractFieldFromLines(headerLines, /^\s*matr(?:[íi]cula|icula|icu1a|icuia)[^\d]*(.*)$/i, {
        digitsOnly: true,
        normalizedPattern: matriculaLabelPattern
    }) || extractFieldFromLines(lines, /^\s*matr(?:[íi]cula|icula|icu1a|icuia)[^\d]*(.*)$/i, {
        digitsOnly: true,
        normalizedPattern: matriculaLabelPattern
    });

    if (!fields.matricula) {
        const match = (data.text || '').match(/matr[íi]cula[^\d]*([0-9]{4,})/i);
        if (match) fields.matricula = match[1];
    }
    fields.professor = cleanName(fields.professor);
    fields.estudante = cleanName(fields.estudante);
    if (fields.matricula && fields.matricula.length < 4) {
        fields.matricula = '';
    }
    return fields;
}

const motivoDefs = [
    { label: 'Indisciplina / Xingamentos', tokens: ['indisciplina', 'xing'] },
    { label: 'Gazeando aula', tokens: ['gazeando'] },
    { label: 'Agressão / Bullying / Discriminação', tokens: ['agressao', 'bullying'] },
    { label: 'Uso de celular / fone de ouvido', tokens: ['uso', 'celular'] },
    { label: 'Dificuldade de aprendizado', tokens: ['dificuldade', 'aprendizado'] },
    { label: 'Desrespeito com professor / profissionais da unidade escolar', tokens: ['desrespeito', 'professor'] },
    { label: 'Não produz e não participa em sala', tokens: ['nao', 'produz'] }
];

const acaoDefs = [
    { label: 'Diálogo com o estudante', tokens: ['dialogo', 'estudante'] },
    { label: 'Comunicado aos responsáveis', tokens: ['comunicado', 'responsaveis'] },
    { label: 'Mensagem via WhatsApp', tokens: ['mensagem', 'whatsapp'] }
];

const providenciaDefs = [
    { label: 'Solicitar comparecimento do responsável na escola', tokens: ['comparecimento'] },
    { label: 'Advertência', tokens: ['advertencia'] }
];

function extractCheckedLabels(data, ctx, defs, imageWidth) {
    const lines = data.lines || [];
    const checked = [];
    defs.forEach(def => {
        const line = lines.find(l => {
            const norm = normalizeText(l.text);
            return def.tokens.every(token => norm.includes(token));
        });
        if (!line || !line.bbox) return;
        if (imageWidth && line.bbox.x0 > imageWidth * 0.4) return;
        const isChecked = detectMarkLeft(ctx, line.bbox);
        if (isChecked) checked.push(def.label);
    });
    return checked;
}

function detectMarkLeft(ctx, bbox) {
    const { x0, y0, x1, y1 } = bbox;
    const height = y1 - y0;
    const width = Math.max(16, height * 0.6);
    const x = Math.max(0, x0 - width - 12);
    const y = Math.max(0, y0 - 2);
    const w = Math.max(8, width);
    const h = Math.max(8, height + 4);
    return isRegionCenterMarked(ctx, x, y, w, h, 0.5);
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
    const text = (value || '').replace(/[|_]/g, ' ').replace(/\s+/g, ' ').trim();
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
        const contrast = 1.2;
        const brightness = 5;
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

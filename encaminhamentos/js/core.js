// ===============================================================
// CONFIGURACAO, CLIENTE E UTILITARIOS
// ===============================================================
const { createClient } = window.supabase;

export const SUPABASE_URL = 'https://agivmrhwytnfprsjsvpy.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFnaXZtcmh3eXRuZnByc2pzdnB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTYyNTQ3ODgsImV4cCI6MjA3MTgzMDc4OH0.1yL3PaS_anO76q3CUdLkdpNc72EDPYVG5F4cYy6ySS0';

export const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        storageKey: 'encaminhamentos_auth'
    }
});

export function getLocalDateString() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function getCurrentYear() {
    return new Date().getFullYear();
}

export function getYearFromDateString(value) {
    if (!value) return getCurrentYear();
    const match = String(value).match(/^(\d{4})-\d{2}-\d{2}$/);
    if (match) return Number(match[1]);
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.getFullYear();
    return getCurrentYear();
}

export function getEncaminhamentosTableName(year) {
    const safeYear = Number(year) || getCurrentYear();
    return `enc_encaminhamentos_${safeYear}`;
}

const ensuredYears = new Set();

export async function ensureEncaminhamentosYear(year) {
    const safeYear = Number(year);
    if (!safeYear || ensuredYears.has(safeYear)) return;
    try {
        await safeQuery(db.rpc('ensure_encaminhamentos_year', { p_year: safeYear }));
        ensuredYears.add(safeYear);
    } catch (err) {
        console.warn('Falha ao garantir tabela anual:', err?.message || err);
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isSchemaCacheError(err) {
    const status = err?.status;
    const text = [err?.message, err?.details, err?.hint].filter(Boolean).join(' ').toLowerCase();
    return status === 409 && (text.includes('schema') || text.includes('relation') || text.includes('cache'));
}

export async function ensureEncaminhamentosTableReady(year) {
    const safeYear = Number(year) || getCurrentYear();
    await ensureEncaminhamentosYear(safeYear);
    const tableName = getEncaminhamentosTableName(safeYear);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await safeQuery(db.from(tableName).select('id').limit(1));
            return;
        } catch (err) {
            if (isSchemaCacheError(err) && attempt === 0) {
                await delay(700);
                continue;
            }
            throw err;
        }
    }
}

export async function safeQuery(queryBuilder) {
    const { data, error, count } = await queryBuilder;
    if (error) {
        console.error('Supabase Error:', error);
        throw error;
    }
    return { data, error, count };
}

export function showView(showId, hideId) {
    const showEl = document.getElementById(showId);
    const hideEl = document.getElementById(hideId);
    if (hideEl) hideEl.classList.add('hidden');
    if (showEl) showEl.classList.remove('hidden');
}

export function formatDateTimeSP(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        dateStyle: 'short',
        timeStyle: 'short',
        hour12: false
    }).format(date);
}

let noticeEls = null;
let noticeTimer = null;

function ensureNoticeElements() {
    if (noticeEls) return noticeEls;
    const overlay = document.createElement('div');
    overlay.id = 'enc-notice-overlay';
    overlay.className = 'enc-notice-overlay hidden';
    overlay.innerHTML = `
        <div class="enc-notice" role="alertdialog" aria-live="polite" aria-modal="false">
            <div class="enc-notice-header">
                <strong id="enc-notice-title">Mensagem</strong>
            </div>
            <div id="enc-notice-text" class="enc-notice-text"></div>
            <div class="enc-notice-actions">
                <button id="enc-notice-close" type="button" class="enc-notice-btn">Fechar</button>
            </div>
            <div class="enc-notice-progress">
                <div id="enc-notice-progress-bar" class="enc-notice-progress-bar"></div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    noticeEls = {
        overlay,
        box: overlay.querySelector('.enc-notice'),
        title: overlay.querySelector('#enc-notice-title'),
        text: overlay.querySelector('#enc-notice-text'),
        closeBtn: overlay.querySelector('#enc-notice-close'),
        progress: overlay.querySelector('.enc-notice-progress'),
        progressBar: overlay.querySelector('#enc-notice-progress-bar')
    };
    noticeEls.closeBtn.addEventListener('click', () => {
        overlay.classList.add('hidden');
    });
    return noticeEls;
}

export function showAppMessage(message, options = {}) {
    if (typeof document === 'undefined') return;
    const type = options?.type === 'error' ? 'error' : 'success';
    const autoCloseMs = Number.isFinite(options?.autoCloseMs)
        ? Number(options.autoCloseMs)
        : (type === 'success' ? 3000 : 0);
    const titleText = String(options?.title || (type === 'success' ? 'Sucesso' : 'Atenção'));

    const els = ensureNoticeElements();
    if (noticeTimer) {
        clearTimeout(noticeTimer);
        noticeTimer = null;
    }

    els.title.textContent = titleText;
    els.text.textContent = String(message || '');
    els.box.classList.remove('is-success', 'is-error');
    els.box.classList.add(type === 'success' ? 'is-success' : 'is-error');
    els.overlay.classList.remove('hidden');

    if (type === 'success' && autoCloseMs > 0) {
        els.progress.style.display = 'block';
        els.progressBar.style.transition = 'none';
        els.progressBar.style.transform = 'scaleX(1)';
        // Force layout so the transition reliably starts.
        void els.progressBar.offsetWidth;
        els.progressBar.style.transition = `transform ${autoCloseMs}ms linear`;
        els.progressBar.style.transform = 'scaleX(0)';
        noticeTimer = setTimeout(() => {
            els.overlay.classList.add('hidden');
            noticeTimer = null;
        }, autoCloseMs);
    } else {
        els.progress.style.display = 'none';
    }
}

function enableUppercaseInputs() {
    document.addEventListener('input', (event) => {
        const el = event.target;
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
        if (el.dataset.keepCase === 'true') return;
        if (el.dataset.uppercase !== 'true') return;
        const type = (el.type || '').toLowerCase();
        if (['email', 'password', 'date', 'time', 'tel', 'number', 'search', 'url'].includes(type)) return;
        const start = el.selectionStart;
        const end = el.selectionEnd;
        const upper = el.value.toUpperCase();
        if (upper !== el.value) {
            el.value = upper;
            if (start !== null && end !== null) {
                el.setSelectionRange(start, end);
            }
        }
    });
}

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', enableUppercaseInputs);
}

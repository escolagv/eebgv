import { db, safeQuery, getYearFromDateString, getEncaminhamentosTableName, ensureEncaminhamentosTableReady, getCurrentYear } from './js/core.js';
import { requireAdminSession, signOut } from './js/auth.js';

// ===================================================================
// REFERÊNCIAS E VARIÁVEIS DE ESTADO
// ===================================================================
const resultsTable = document.getElementById("results-table");
const loadingMessage = document.getElementById("loading-message");
const simpleReportButton = document.getElementById("simple-report-button");
const completeReportButton = document.getElementById("complete-report-button");
const resultsSummary = document.getElementById("results-summary");
const paginationContainer = document.getElementById("pagination-container");
const reportLayoutModal = document.getElementById('report-layout-modal');
const reportLayoutCancel = document.getElementById('report-layout-cancel');
const searchButton = document.getElementById('search-button');
const searchAno = document.getElementById('search-ano');
const searchCodigo = document.getElementById('search-codigo');

let allResults = [];
let currentPage = 1;
const recordsPerPage = 30;
const scanStateByEncId = new Map();

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

async function removeFromEncTempWithFallback(path) {
    const candidates = buildStoragePathCandidates(path);
    if (!candidates.length) return;
    try {
        await db.storage.from('enc_temp').remove(candidates);
    } catch (err) {
        console.warn('Falha ao remover arquivo do enc_temp:', err?.message || err, candidates);
    }
}

// ===================================================================
// INICIALIZAÇÃO DA PÁGINA
// ===================================================================
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

    initSearchForm();
    initReportButtons();
    if (hasActiveFilters()) {
        await handleSearch();
    } else {
        showSearchPrompt();
    }

    if (reportLayoutCancel && reportLayoutModal) {
        reportLayoutCancel.addEventListener('click', () => reportLayoutModal.classList.add('hidden'));
    }
    if (reportLayoutModal) {
        reportLayoutModal.addEventListener('click', (event) => {
            if (event.target === reportLayoutModal) reportLayoutModal.classList.add('hidden');
        });
        reportLayoutModal.querySelectorAll('button[data-layout]').forEach(btn => {
            btn.addEventListener('click', () => {
                const layout = btn.dataset.layout || 'single';
                reportLayoutModal.classList.add('hidden');
                generateReport('complete', layout);
            });
        });
    }
});

// ===================================================================
// FUNÇÕES DE BUSCA E RENDERIZAÇÃO
// ===================================================================
function initReportButtons() {
    if (simpleReportButton) {
        simpleReportButton.addEventListener('click', () => generateReport('simple'));
    }
    if (completeReportButton) {
        completeReportButton.addEventListener('click', () => openLayoutModal());
    }
}

function initSearchForm() {
    if (!searchButton) return;
    if (searchAno) {
        const currentYear = new Date().getFullYear();
        searchAno.innerHTML = '';
        for (let i = 0; i < 5; i += 1) {
            const year = currentYear + i;
            const option = document.createElement('option');
            option.value = String(year);
            option.textContent = String(year);
            if (i === 0) option.selected = true;
            searchAno.appendChild(option);
        }
        setCodigoPrefix(searchAno.value);
        searchAno.addEventListener('change', () => {
            setCodigoPrefix(searchAno.value);
        });
    } else if (searchCodigo) {
        setCodigoPrefix(String(new Date().getFullYear()));
    }

    const dataStartEl = document.getElementById('search-data-start');
    if (dataStartEl && !dataStartEl.value) {
        const today = new Date().toISOString().slice(0, 10);
        dataStartEl.value = today;
    }

    searchButton.addEventListener('click', async () => {
        const params = buildSearchParams();
        applySearchParams(params);
        await handleSearch();
    });

    document.querySelectorAll('#search-estudante, #search-professor, #search-data-start, #search-data-end, #search-codigo, #search-registrado').forEach(input => {
        input.addEventListener('keydown', async (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                const params = buildSearchParams();
                applySearchParams(params);
                await handleSearch();
            }
        });
    });

    document.querySelectorAll('.date-clear-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.dataset.target;
            const target = targetId ? document.getElementById(targetId) : null;
            if (target) target.value = '';
        });
    });
}

function buildSearchParams() {
    const params = new URLSearchParams();
    const estudante = document.getElementById('search-estudante')?.value || '';
    const professor = document.getElementById('search-professor')?.value || '';
    const dataStart = document.getElementById('search-data-start')?.value || '';
    const dataEnd = document.getElementById('search-data-end')?.value || '';
    const registradoPor = document.getElementById('search-registrado')?.value || '';
    const ano = document.getElementById('search-ano')?.value || '';
    const codigo = document.getElementById('search-codigo')?.value || '';

    if (estudante) params.append('estudante', estudante);
    if (professor) params.append('professor', professor);
    if (dataStart) params.append('data_inicio', dataStart);
    if (dataEnd) params.append('data_fim', dataEnd);
    if (registradoPor) params.append('registradoPor', registradoPor);
    if (ano) params.append('ano', ano);
    if (codigo) params.append('codigo', codigo);
    return params;
}

function applySearchParams(params) {
    const query = params.toString();
    const next = `${window.location.pathname}${query ? `?${query}` : ''}`;
    window.history.replaceState({}, document.title, next);
}

function hasActiveFilters() {
    const params = new URLSearchParams(window.location.search);
    const dataInicioParam = params.get('data_inicio') || params.get('data') || '';
    const dataFimParam = params.get('data_fim') || '';
    const dataInicioEl = document.getElementById('search-data-start');
    const dataFimEl = document.getElementById('search-data-end');
    if (dataInicioEl && dataInicioParam) dataInicioEl.value = dataInicioParam;
    if (dataFimEl && dataFimParam) dataFimEl.value = dataFimParam;
    return ['estudante', 'professor', 'data', 'data_inicio', 'data_fim', 'registradoPor', 'ano', 'codigo'].some(key => {
        const value = params.get(key);
        return value && value.trim();
    });
}

async function handleSearch() {
    loadingMessage.style.display = 'block';
    resultsTable.innerHTML = '';
    paginationContainer.innerHTML = '';

    const params = new URLSearchParams(window.location.search);
    const filters = {
        estudante: (params.get('estudante') || '').toLowerCase(),
        professor: (params.get('professor') || '').toLowerCase(),
        dataInicio: params.get('data_inicio') || params.get('data') || '',
        dataFim: params.get('data_fim') || '',
        registradoPor: (params.get('registradoPor') || '').toLowerCase(),
        ano: params.get('ano') || '',
        codigo: (params.get('codigo') || '').toLowerCase()
    };

    try {
        const targetYear = filters.dataInicio
            ? getYearFromDateString(filters.dataInicio)
            : (Number(filters.ano) || getCurrentYear());
        await ensureEncaminhamentosTableReady(targetYear);
        const tableName = getEncaminhamentosTableName(targetYear);
        let query = db
            .from(tableName)
            .select('*')
            .order('data_encaminhamento', { ascending: false });

        if (filters.estudante) query = query.ilike('aluno_nome', `%${filters.estudante}%`);
        if (filters.professor) query = query.ilike('professor_nome', `%${filters.professor}%`);
        if (filters.dataInicio && filters.dataFim) {
            query = query.gte('data_encaminhamento', filters.dataInicio).lte('data_encaminhamento', filters.dataFim);
        } else if (filters.dataInicio) {
            query = query.eq('data_encaminhamento', filters.dataInicio);
        } else if (filters.dataFim) {
            query = query.lte('data_encaminhamento', filters.dataFim);
        }
        if (filters.registradoPor) query = query.ilike('registrado_por_nome', `%${filters.registradoPor}%`);
        if (filters.codigo) query = query.ilike('codigo', `%${filters.codigo}%`);

        const { data } = await safeQuery(query);
        allResults = data || [];
        await loadScanStates(allResults.map(item => item?.id).filter(Boolean));

        currentPage = 1;
        renderPage(currentPage);
        loadingMessage.style.display = 'none';
    } catch (err) {
        handleSupabaseError(err);
    }
}

function setCodigoPrefix(yearValue) {
    if (!searchCodigo) return;
    const year = String(yearValue || new Date().getFullYear());
    const prefix = `ENC-${year}-`;
    const current = (searchCodigo.value || '').trim();
    if (!current) {
        searchCodigo.value = prefix;
        return;
    }
    if (/^ENC-\d{4}-/i.test(current)) {
        const suffix = current.replace(/^ENC-\d{4}-/i, '');
        searchCodigo.value = prefix + suffix;
    }
}

function renderPage(page) {
    currentPage = page;
    const totalPages = Math.ceil(allResults.length / recordsPerPage);
    if (currentPage < 1) currentPage = 1;
    if (currentPage > totalPages && totalPages > 0) currentPage = totalPages;

    const start = (currentPage - 1) * recordsPerPage;
    const end = start + recordsPerPage;
    const paginatedItems = allResults.slice(start, end);

    displayResults(paginatedItems, start);
    renderPaginationControls(totalPages);
}

function displayResults(results, startIndex) {
    if (results.length === 0) {
        displayNoResults();
        return;
    }
    resultsSummary.textContent = `Mostrando registros ${startIndex + 1} a ${startIndex + results.length} de ${allResults.length} encontrado(s).`;
    let tableHTML = `<table><thead><tr><th>Código</th><th>Data</th><th>Estudante</th><th>Professor</th><th>Status</th><th>Ações</th></tr></thead><tbody>`;
    results.forEach(item => {
        const dataDisplay = formatDatePtBr(item.data_encaminhamento);
        const scanState = scanStateByEncId.get(String(item.id)) || null;
        const driveAction = renderDriveAction(item, scanState);
        tableHTML += `<tr>
                        <td>${item.codigo || ''}</td>
                        <td>${dataDisplay}</td>
                        <td>${item.aluno_nome || ''}</td>
                        <td>${item.professor_nome || ''}</td>
                        <td>${item.status || ''}</td>
                        <td class="enc-actions-cell">
                            <button class="pagination-btn" onclick="redirectToEdit('${item.id}', '${item.data_encaminhamento || ''}')">Ver/Editar</button>
                            ${driveAction}
                        </td>
                      </tr>`;
    });
    tableHTML += '</tbody></table>';
    resultsTable.innerHTML = tableHTML;
    bindRetryDriveActions();
}

function renderDriveAction(item, scanState) {
    if (!scanState) return '<span class="enc-drive-pill enc-drive-pill-muted">Sem scan</span>';
    if (scanState.drive_file_id || scanState.drive_url) {
        return '<span class="enc-drive-pill enc-drive-pill-ok">Drive OK</span>';
    }
    if (scanState.storage_path) {
        return `<button
                    class="pagination-btn retry-drive-btn"
                    data-enc-id="${String(item.id)}"
                    data-codigo="${String(item.codigo || '')}"
                    data-data="${String(item.data_encaminhamento || '')}"
                >Reenviar Drive</button>`;
    }
    return '<span class="enc-drive-pill enc-drive-pill-muted">Sem arquivo</span>';
}

function bindRetryDriveActions() {
    document.querySelectorAll('.retry-drive-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const encId = btn.dataset.encId || '';
            const codigo = btn.dataset.codigo || '';
            const data = btn.dataset.data || '';
            await retryDriveUploadByEncId(encId, codigo, data, btn);
        });
    });
}

async function loadScanStates(encIds) {
    scanStateByEncId.clear();
    if (!Array.isArray(encIds) || !encIds.length) return;
    const chunkSize = 100;
    for (let i = 0; i < encIds.length; i += chunkSize) {
        const chunk = encIds.slice(i, i + chunkSize).map(id => String(id));
        const { data } = await safeQuery(
            db.from('enc_scan_jobs')
                .select('id, encaminhamento_id, storage_path, mime_type, drive_url, drive_file_id, created_at')
                .in('encaminhamento_id', chunk)
                .order('created_at', { ascending: false })
        );
        (data || []).forEach(job => {
            const key = String(job?.encaminhamento_id || '');
            if (!key || scanStateByEncId.has(key)) return;
            scanStateByEncId.set(key, job);
        });
    }
}

async function retryDriveUploadByEncId(encaminhamentoId, codigo, dataEncaminhamento, buttonEl) {
    if (!encaminhamentoId || !codigo || !dataEncaminhamento) {
        alert('Dados insuficientes para reenviar ao Drive.');
        return;
    }

    const originalText = buttonEl?.textContent || 'Reenviar Drive';
    if (buttonEl) {
        buttonEl.disabled = true;
        buttonEl.textContent = 'Enviando...';
    }

    try {
        const { data: jobs } = await safeQuery(
            db.from('enc_scan_jobs')
                .select('id, storage_path, mime_type, drive_url, drive_file_id, created_at')
                .eq('encaminhamento_id', encaminhamentoId)
                .order('created_at', { ascending: false })
        );
        const pending = (jobs || []).find(job => job?.storage_path && !job?.drive_file_id && !job?.drive_url);
        if (!pending) {
            alert('Não há scan pendente para este encaminhamento.');
            return;
        }

        const payload = {
            storage_path: pending.storage_path,
            codigo,
            data_encaminhamento: dataEncaminhamento,
            mime_type: pending.mime_type || 'image/jpeg'
        };
        const { data, error } = await db.functions.invoke('enc_drive_upload', { body: payload });
        if (error) throw error;

        const driveUrl = data?.webViewLink || data?.drive_url || null;
        const driveFileId = data?.file_id || null;
        await safeQuery(
            db.from('enc_scan_jobs')
                .update({
                    drive_url: driveUrl,
                    drive_file_id: driveFileId,
                    status: 'vinculado',
                    storage_path: null
                })
                .eq('id', pending.id)
        );

        await removeFromEncTempWithFallback(pending.storage_path);

        if (data?.already_exists) {
            alert('Arquivo já existia no Drive com este código. Apenas vinculamos o registro local.');
        } else {
            alert('Imagem enviada para o Drive com sucesso.');
        }
        await handleSearch();
    } catch (err) {
        const details = await extractInvokeErrorMessage(err);
        alert(`Falha ao reenviar para o Drive: ${details}`);
    } finally {
        if (buttonEl) {
            buttonEl.disabled = false;
            buttonEl.textContent = originalText;
        }
    }
}

async function extractInvokeErrorMessage(err) {
    const fallback = err?.message || String(err) || 'Erro desconhecido';
    try {
        const ctx = err?.context;
        if (!ctx) return fallback;
        if (typeof Response !== 'undefined' && ctx instanceof Response) {
            try {
                const payload = await ctx.clone().json();
                if (payload?.error) {
                    const stage = payload?.stage ? ` [${payload.stage}]` : '';
                    return `${payload.error}${stage}`;
                }
            } catch (_jsonErr) {
                const text = await ctx.clone().text();
                if (text) return text;
            }
            return fallback;
        }
        if (typeof ctx === 'string') {
            const parsed = JSON.parse(ctx);
            if (parsed?.error) {
                const stage = parsed?.stage ? ` [${parsed.stage}]` : '';
                return `${parsed.error}${stage}`;
            }
            return parsed?.message || fallback;
        }
        if (typeof ctx === 'object') {
            if (ctx?.error) {
                const stage = ctx?.stage ? ` [${ctx.stage}]` : '';
                return `${ctx.error}${stage}`;
            }
            return ctx?.message || fallback;
        }
        return fallback;
    } catch (_e) {
        return fallback;
    }
}

function formatDatePtBr(value) {
    if (!value) return '';
    if (typeof value === 'string') {
        const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (match) return `${match[3]}/${match[2]}/${match[1]}`;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(date);
}

function renderPaginationControls(totalPages) {
    paginationContainer.innerHTML = '';
    if (totalPages <= 1) return;
    paginationContainer.innerHTML += `<button class="pagination-btn" onclick="renderPage(1)" ${currentPage === 1 ? 'disabled' : ''}>Primeiro</button>`;
    paginationContainer.innerHTML += `<button class="pagination-btn" onclick="renderPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>&laquo; Anterior</button>`;
    const pagesToShow = [];
    if (totalPages <= 5) { for (let i = 1; i <= totalPages; i++) pagesToShow.push(i); }
    else {
        pagesToShow.push(1);
        if (currentPage > 3) pagesToShow.push('...');
        for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) { pagesToShow.push(i); }
        if (currentPage < totalPages - 2) pagesToShow.push('...');
        pagesToShow.push(totalPages);
    }
    [...new Set(pagesToShow)].forEach(page => {
        if (page === '...') {
            paginationContainer.innerHTML += `<span class="pagination-btn ellipsis">...</span>`;
        } else {
            paginationContainer.innerHTML += `<button class="pagination-btn ${page === currentPage ? 'active' : ''}" onclick="renderPage(${page})">${page}</button>`;
        }
    });
    paginationContainer.innerHTML += `<button class="pagination-btn" onclick="renderPage(${currentPage + 1})" ${currentPage === totalPages ? 'disabled' : ''}>Próximo &raquo;</button>`;
    paginationContainer.innerHTML += `<button class="pagination-btn" onclick="renderPage(${totalPages})" ${currentPage === totalPages ? 'disabled' : ''}>Último</button>`;
}

function openLayoutModal() {
    if (reportLayoutModal) {
        reportLayoutModal.classList.remove('hidden');
    } else {
        generateReport('complete', 'single');
    }
}

function generateReport(reportType, layout = 'single') {
    if (allResults.length === 0) { alert("Não há resultados para gerar um relatório."); return; }
    try {
        localStorage.setItem('searchResults', JSON.stringify(allResults));
        localStorage.setItem('searchSummary', resultsSummary.textContent || '');
        localStorage.setItem('reportType', reportType);
        localStorage.setItem('reportLayout', layout);
        const reportWindow = window.open('report.html', '_blank');
        if (!reportWindow) { alert('Seu navegador bloqueou a abertura da nova janela. Por favor, desative o bloqueador de pop-ups para este site.'); }
    } catch (e) { alert("Ocorreu um erro: " + e.message); }
}

window.redirectToEdit = function redirectToEdit(recordId, dataEncaminhamento) {
    const year = getYearFromDateString(dataEncaminhamento);
    window.location.href = `encaminhamento.html?editId=${recordId}&year=${year}`;
};
window.renderPage = renderPage;

function displayNoResults() {
    loadingMessage.style.display = 'none';
    resultsTable.innerHTML = "<p>Nenhum registro encontrado com estes critérios.</p>";
    resultsSummary.textContent = "Nenhum resultado para a busca atual.";
}

function showSearchPrompt() {
    if (loadingMessage) loadingMessage.style.display = 'none';
    if (resultsTable) resultsTable.innerHTML = "<p class=\"text-sm text-gray-500\">Use os filtros e clique em Buscar para ver os encaminhamentos.</p>";
    if (resultsSummary) resultsSummary.textContent = "Aguardando busca.";
    if (paginationContainer) paginationContainer.innerHTML = '';
}

function handleSupabaseError(error) {
    loadingMessage.style.display = 'none';
    resultsTable.innerHTML = `<p style="color: red; font-weight: bold;">ERRO AO ACESSAR O BANCO DE DADOS:<br>${error.message || error}</p>`;
}

import { db, safeQuery } from './js/core.js';
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

let allResults = [];
let currentPage = 1;
const recordsPerPage = 30;

// ===================================================================
// INICIALIZAÇÃO DA PÁGINA
// ===================================================================
document.addEventListener('DOMContentLoaded', async () => {
    const { session, profile } = await requireAdminSession();
    if (!session || !profile) {
        window.location.href = 'index.html';
        return;
    }
    document.getElementById('user-name').textContent = profile.nome || session.user.email || '-';
    document.getElementById('logout-btn').addEventListener('click', async () => {
        await signOut();
        window.location.href = 'index.html';
    });

    await handleSearch();
    simpleReportButton.addEventListener('click', () => generateReport('simple'));
    completeReportButton.addEventListener('click', () => generateReport('complete'));
});

// ===================================================================
// FUNÇÕES DE BUSCA E RENDERIZAÇÃO
// ===================================================================
async function handleSearch() {
    loadingMessage.style.display = 'block';
    resultsTable.innerHTML = '';
    paginationContainer.innerHTML = '';

    const params = new URLSearchParams(window.location.search);
    const filters = {
        estudante: (params.get('estudante') || '').toLowerCase(),
        professor: (params.get('professor') || '').toLowerCase(),
        data: params.get('data') || '',
        registradoPor: (params.get('registradoPor') || '').toLowerCase()
    };

    try {
        let query = db
            .from('enc_encaminhamentos')
            .select('*')
            .order('data_encaminhamento', { ascending: false });

        if (filters.estudante) query = query.ilike('aluno_nome', `%${filters.estudante}%`);
        if (filters.professor) query = query.ilike('professor_nome', `%${filters.professor}%`);
        if (filters.data) query = query.eq('data_encaminhamento', filters.data);
        if (filters.registradoPor) query = query.ilike('registrado_por_nome', `%${filters.registradoPor}%`);

        const { data } = await safeQuery(query);
        allResults = data || [];

        currentPage = 1;
        renderPage(currentPage);
        loadingMessage.style.display = 'none';
    } catch (err) {
        handleSupabaseError(err);
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
    let tableHTML = `<table><thead><tr><th>Data</th><th>Estudante</th><th>Professor</th><th>Status</th><th>Ações</th></tr></thead><tbody>`;
    results.forEach(item => {
        tableHTML += `<tr>
                        <td>${item.data_encaminhamento || ''}</td>
                        <td>${item.aluno_nome || ''}</td>
                        <td>${item.professor_nome || ''}</td>
                        <td>${item.status || ''}</td>
                        <td><button class="pagination-btn" onclick="redirectToEdit('${item.id}')">Ver/Editar</button></td>
                      </tr>`;
    });
    tableHTML += '</tbody></table>';
    resultsTable.innerHTML = tableHTML;
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

function generateReport(reportType) {
    if (allResults.length === 0) { alert("Não há resultados para gerar um relatório."); return; }
    try {
        localStorage.setItem('searchResults', JSON.stringify(allResults));
        localStorage.setItem('searchSummary', resultsSummary.textContent || '');
        localStorage.setItem('reportType', reportType);
        const reportWindow = window.open('report.html', '_blank');
        if (!reportWindow) { alert('Seu navegador bloqueou a abertura da nova janela. Por favor, desative o bloqueador de pop-ups para este site.'); }
    } catch (e) { alert("Ocorreu um erro: " + e.message); }
}

window.redirectToEdit = function redirectToEdit(recordId) {
    window.location.href = `index.html?editId=${recordId}`;
};
window.renderPage = renderPage;

function displayNoResults() {
    loadingMessage.style.display = 'none';
    resultsTable.innerHTML = "<p>Nenhum registro encontrado com estes critérios.</p>";
    resultsSummary.textContent = "Nenhum resultado para a busca atual.";
}

function handleSupabaseError(error) {
    loadingMessage.style.display = 'none';
    resultsTable.innerHTML = `<p style="color: red; font-weight: bold;">ERRO AO ACESSAR O BANCO DE DADOS:<br>${error.message || error}</p>`;
}

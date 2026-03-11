import { db, safeQuery } from './js/core.js';
import { requireAdminSession, signOut } from './js/auth.js';

const state = {
    alunos: [],
    professores: [],
    turmas: [],
    anoLetivoAtual: null,
    lastSyncAt: null
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

    bindTabs();
    bindModals();
    await loadData();
});

function bindTabs() {
    const tabAlunos = document.getElementById('tab-alunos');
    const tabProfessores = document.getElementById('tab-professores');
    const alunosPanel = document.getElementById('alunos-panel');
    const profPanel = document.getElementById('professores-panel');
    const addAlunoBtn = document.getElementById('add-aluno-btn');
    const addProfBtn = document.getElementById('add-professor-btn');

    tabAlunos.addEventListener('click', () => {
        tabAlunos.classList.add('bg-slate-800', 'text-white');
        tabAlunos.classList.remove('bg-gray-200', 'text-gray-700');
        tabProfessores.classList.add('bg-gray-200', 'text-gray-700');
        tabProfessores.classList.remove('bg-slate-800', 'text-white');
        alunosPanel.classList.remove('hidden');
        profPanel.classList.add('hidden');
        addAlunoBtn.classList.remove('hidden');
        addProfBtn.classList.add('hidden');
    });

    tabProfessores.addEventListener('click', () => {
        tabProfessores.classList.add('bg-slate-800', 'text-white');
        tabProfessores.classList.remove('bg-gray-200', 'text-gray-700');
        tabAlunos.classList.add('bg-gray-200', 'text-gray-700');
        tabAlunos.classList.remove('bg-slate-800', 'text-white');
        profPanel.classList.remove('hidden');
        alunosPanel.classList.add('hidden');
        addProfBtn.classList.remove('hidden');
        addAlunoBtn.classList.add('hidden');
    });
}

function bindModals() {
    document.getElementById('add-aluno-btn').addEventListener('click', () => openAlunoModal());
    document.getElementById('add-professor-btn').addEventListener('click', () => openProfessorModal());

    document.getElementById('aluno-cancel').addEventListener('click', () => closeModal('aluno-modal'));
    document.getElementById('professor-cancel').addEventListener('click', () => closeModal('professor-modal'));

    document.getElementById('aluno-save').addEventListener('click', saveAluno);
    document.getElementById('professor-save').addEventListener('click', saveProfessor);

    document.getElementById('aluno-search').addEventListener('input', renderAlunos);
    document.getElementById('professor-search').addEventListener('input', renderProfessores);
    ['aluno-filtro-turma', 'aluno-filtro-status', 'aluno-filtro-origem', 'aluno-ordenacao']
        .forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', renderAlunos);
        });
    ['professor-filtro-status', 'professor-filtro-origem', 'professor-filtro-vinculo', 'professor-ordenacao']
        .forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', renderProfessores);
        });

    const syncBtn = document.getElementById('sync-status-btn');
    const syncClose = document.getElementById('sync-close-btn');
    const syncRefresh = document.getElementById('sync-refresh-btn');
    const syncNow = document.getElementById('sync-now-cadastros');
    if (syncBtn) {
        syncBtn.addEventListener('click', async () => {
            openModal('sync-modal');
            await loadSyncStatus();
        });
    }
    if (syncClose) {
        syncClose.addEventListener('click', () => closeModal('sync-modal'));
    }
    if (syncRefresh) {
        syncRefresh.addEventListener('click', async () => {
            await loadSyncStatus();
        });
    }
    if (syncNow) {
        syncNow.addEventListener('click', async () => {
            await runSyncNow();
        });
    }

    const consistenciaBtn = document.getElementById('consistencia-btn');
    const consistenciaClose = document.getElementById('consistencia-close-btn');
    const consistenciaRefresh = document.getElementById('consistencia-refresh-btn');
    if (consistenciaBtn) {
        consistenciaBtn.addEventListener('click', async () => {
            openModal('consistencia-modal');
            await loadConsistencia();
        });
    }
    if (consistenciaClose) {
        consistenciaClose.addEventListener('click', () => closeModal('consistencia-modal'));
    }
    if (consistenciaRefresh) {
        consistenciaRefresh.addEventListener('click', async () => {
            await loadConsistencia();
        });
    }
}

async function loadData() {
    try {
        const [alunosRes, professoresRes, turmasRes] = await Promise.all([
            safeQuery(db.from('enc_alunos').select('*').order('nome_completo')),
            safeQuery(db.from('enc_professores').select('*').order('nome')),
            safeQuery(db.from('turmas').select('id, nome_turma, ano_letivo'))
        ]);
        state.alunos = alunosRes.data || [];
        state.professores = professoresRes.data || [];
        state.turmas = turmasRes.data || [];
        state.anoLetivoAtual = getAnoLetivoAtual(state.turmas);
        populateTurmas();
        populateFilters();
        renderAlunos();
        renderProfessores();
    } catch (err) {
        showMessage('Erro ao carregar dados: ' + (err?.message || err), true);
    }
}

function formatSyncDate(value) {
    if (!value) return '-';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        dateStyle: 'short',
        timeStyle: 'short',
        hour12: false
    }).format(date);
}

function formatCreatedDate(value) {
    if (!value) return '-';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        dateStyle: 'short',
        timeStyle: 'short',
        hour12: false
    }).format(date);
}

async function loadSyncStatus() {
    const lastEl = document.getElementById('sync-last');
    const alunosEl = document.getElementById('sync-alunos-total');
    const alunosSemTurmaEl = document.getElementById('sync-alunos-sem-turma');
    const professoresEl = document.getElementById('sync-professores-total');
    try {
        const [{ count: alunosTotal }, { count: alunosSemTurma }, { count: professoresTotal }] = await Promise.all([
            safeQuery(db.from('enc_alunos').select('*', { count: 'exact', head: true })),
            safeQuery(db.from('enc_alunos').select('*', { count: 'exact', head: true }).is('turma_id', null)),
            safeQuery(db.from('enc_professores').select('*', { count: 'exact', head: true }))
        ]);

        if (alunosEl) alunosEl.textContent = String(alunosTotal ?? 0);
        if (alunosSemTurmaEl) alunosSemTurmaEl.textContent = String(alunosSemTurma ?? 0);
        if (professoresEl) professoresEl.textContent = String(professoresTotal ?? 0);
        if (lastEl) lastEl.textContent = formatSyncDate(state.lastSyncAt);
    } catch (err) {
        showMessage('Erro ao carregar status do sync: ' + (err?.message || err), true);
    }
}

async function runSyncNow() {
    const button = document.getElementById('sync-now-cadastros');
    if (button) {
        button.disabled = true;
        button.textContent = 'Sincronizando...';
    }
    try {
        await safeQuery(db.rpc('sync_enc_cache'));
        state.lastSyncAt = new Date();
        await loadData();
        await loadSyncStatus();
        showMessage('Sincronização concluída.');
    } catch (err) {
        showMessage('Erro ao sincronizar: ' + (err?.message || err), true);
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = 'Sincronizar agora';
        }
    }
}

async function loadConsistencia() {
    const alunosSemTurmaCountEl = document.getElementById('consistencia-alunos-sem-turma-count');
    const turmasDuplicadasCountEl = document.getElementById('consistencia-turmas-duplicadas-count');
    const alunosSemTurmaTable = document.getElementById('consistencia-alunos-sem-turma-table');
    const turmasDuplicadasTable = document.getElementById('consistencia-turmas-duplicadas-table');

    const setLoading = () => {
        if (alunosSemTurmaCountEl) alunosSemTurmaCountEl.textContent = '...';
        if (turmasDuplicadasCountEl) turmasDuplicadasCountEl.textContent = '...';
        if (alunosSemTurmaTable) alunosSemTurmaTable.innerHTML = '<tr><td colspan="2" class="p-4 text-center">Carregando...</td></tr>';
        if (turmasDuplicadasTable) turmasDuplicadasTable.innerHTML = '<tr><td colspan="3" class="p-4 text-center">Carregando...</td></tr>';
    };

    setLoading();

    try {
        const [alunosSemTurmaRes, alunosSemTurmaListRes, turmasRes] = await Promise.all([
            safeQuery(db.from('enc_alunos').select('*', { count: 'exact', head: true }).eq('status', 'ativo').is('turma_id', null)),
            safeQuery(db.from('enc_alunos').select('id, nome_completo, matricula').eq('status', 'ativo').is('turma_id', null).order('nome_completo').limit(50)),
            safeQuery(db.from('turmas').select('id, nome_turma, ano_letivo'))
        ]);

        const alunosSemTurmaCount = alunosSemTurmaRes.count || 0;
        if (alunosSemTurmaCountEl) alunosSemTurmaCountEl.textContent = alunosSemTurmaCount;
        const alunosSemTurma = alunosSemTurmaListRes.data || [];
        if (alunosSemTurmaTable) {
            alunosSemTurmaTable.innerHTML = alunosSemTurma.length
                ? alunosSemTurma.map(a => `
                    <tr>
                        <td class="p-3">${a.nome_completo || '-'}</td>
                        <td class="p-3">${a.matricula || '-'}</td>
                    </tr>
                `).join('')
                : '<tr><td colspan="2" class="p-4 text-center">Nenhum encontrado.</td></tr>';
        }

        const turmas = turmasRes.data || [];
        const dupMap = new Map();
        turmas.forEach(t => {
            const key = `${t.nome_turma}__${t.ano_letivo}`;
            const current = dupMap.get(key) || { nome_turma: t.nome_turma, ano_letivo: t.ano_letivo, count: 0 };
            current.count += 1;
            dupMap.set(key, current);
        });
        const duplicadas = Array.from(dupMap.values()).filter(d => d.count > 1).sort((a, b) => b.count - a.count);
        if (turmasDuplicadasCountEl) turmasDuplicadasCountEl.textContent = duplicadas.length;
        if (turmasDuplicadasTable) {
            turmasDuplicadasTable.innerHTML = duplicadas.length
                ? duplicadas.slice(0, 50).map(d => `
                    <tr>
                        <td class="p-3">${d.nome_turma}</td>
                        <td class="p-3">${d.ano_letivo}</td>
                        <td class="p-3">${d.count}</td>
                    </tr>
                `).join('')
                : '<tr><td colspan="3" class="p-4 text-center">Nenhuma duplicidade encontrada.</td></tr>';
        }

    } catch (err) {
        console.error('Erro ao carregar consistencia:', err);
        if (alunosSemTurmaCountEl) alunosSemTurmaCountEl.textContent = 'Erro';
        if (turmasDuplicadasCountEl) turmasDuplicadasCountEl.textContent = 'Erro';
        if (alunosSemTurmaTable) alunosSemTurmaTable.innerHTML = '<tr><td colspan="2" class="p-4 text-center text-red-500">Erro ao carregar.</td></tr>';
        if (turmasDuplicadasTable) turmasDuplicadasTable.innerHTML = '<tr><td colspan="3" class="p-4 text-center text-red-500">Erro ao carregar.</td></tr>';
    }
}

function getAnoLetivoAtual(turmas) {
    const anos = (turmas || [])
        .map(t => parseInt(t.ano_letivo, 10))
        .filter(Number.isFinite);
    if (anos.length === 0) return null;
    return Math.max(...anos);
}

function populateTurmas() {
    const select = document.getElementById('aluno-turma');
    if (!select) return;
    select.innerHTML = '<option value="">Selecione...</option>';
    const turmasFiltradas = state.turmas.filter(t => !state.anoLetivoAtual || String(t.ano_letivo) === String(state.anoLetivoAtual));
    turmasFiltradas.forEach(t => {
        const option = document.createElement('option');
        option.value = t.id;
        option.textContent = t.nome_turma;
        select.appendChild(option);
    });
}

function populateFilters() {
    const turmaFilter = document.getElementById('aluno-filtro-turma');
    if (turmaFilter) {
        turmaFilter.innerHTML = '<option value="">Todas as turmas</option>';
        const turmasFiltradas = state.turmas
            .filter(t => !state.anoLetivoAtual || String(t.ano_letivo) === String(state.anoLetivoAtual))
            .sort((a, b) => (a.nome_turma || '').localeCompare(b.nome_turma || '', undefined, { numeric: true }));
        turmasFiltradas.forEach(t => {
            const option = document.createElement('option');
            option.value = String(t.id);
            option.textContent = t.nome_turma;
            turmaFilter.appendChild(option);
        });
    }
}

function renderAlunos() {
    const tbody = document.getElementById('alunos-table-body');
    const filtro = (document.getElementById('aluno-search')?.value || '').toLowerCase();
    const filtroTurma = document.getElementById('aluno-filtro-turma')?.value || '';
    const filtroStatus = document.getElementById('aluno-filtro-status')?.value || '';
    const filtroOrigem = document.getElementById('aluno-filtro-origem')?.value || '';
    const ordenacao = document.getElementById('aluno-ordenacao')?.value || 'turma';
    const turmasById = new Map(state.turmas.map(t => [Number(t.id), t.nome_turma]));
    const filtered = state.alunos.filter(a => {
        if (!filtro) return true;
        return (a.nome_completo || '').toLowerCase().includes(filtro) ||
            (a.matricula || '').toLowerCase().includes(filtro);
    }).filter(a => {
        if (filtroTurma && String(a.turma_id || '') !== String(filtroTurma)) return false;
        if (filtroStatus && String(a.status || '') !== String(filtroStatus)) return false;
        if (filtroOrigem && String(a.origem || '') !== String(filtroOrigem)) return false;
        return true;
    });

    filtered.sort((a, b) => {
        if (ordenacao === 'nome') {
            return (a.nome_completo || '').localeCompare(b.nome_completo || '', undefined, { sensitivity: 'base' });
        }
        const turmaA = turmasById.get(Number(a.turma_id)) || '';
        const turmaB = turmasById.get(Number(b.turma_id)) || '';
        const turmaCompare = turmaA.localeCompare(turmaB, undefined, { numeric: true, sensitivity: 'base' });
        if (turmaCompare !== 0) return turmaCompare;
        return (a.nome_completo || '').localeCompare(b.nome_completo || '', undefined, { sensitivity: 'base' });
    });
    tbody.innerHTML = filtered.map(a => `
        <tr class="border-b">
            <td class="py-2">${a.nome_completo || '-'}</td>
            <td class="py-2">${a.matricula || '-'}</td>
            <td class="py-2">${turmasById.get(Number(a.turma_id)) || '-'}</td>
            <td class="py-2">${a.status || '-'}</td>
            <td class="py-2">${a.origem || '-'}</td>
            <td class="py-2">
                <button class="text-blue-600 hover:underline mr-2" data-id="${a.id}" data-action="edit-aluno">Editar</button>
                <button class="text-amber-600 hover:underline mr-2" data-id="${a.id}" data-action="inativar-aluno">Inativar</button>
                <button class="text-red-600 hover:underline" data-id="${a.id}" data-action="delete-aluno">Excluir</button>
            </td>
        </tr>
    `).join('');

    tbody.querySelectorAll('button[data-action="edit-aluno"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = Number(btn.dataset.id);
            const aluno = state.alunos.find(a => Number(a.id) === id);
            openAlunoModal(aluno);
        });
    });
    tbody.querySelectorAll('button[data-action="inativar-aluno"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = Number(btn.dataset.id);
            await toggleAlunoStatus(id, 'inativo');
        });
    });
    tbody.querySelectorAll('button[data-action="delete-aluno"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = Number(btn.dataset.id);
            await deleteAluno(id);
        });
    });
}

function renderProfessores() {
    const tbody = document.getElementById('professores-table-body');
    const filtro = (document.getElementById('professor-search')?.value || '').toLowerCase();
    const filtroStatus = document.getElementById('professor-filtro-status')?.value || '';
    const filtroOrigem = document.getElementById('professor-filtro-origem')?.value || '';
    const filtroVinculo = document.getElementById('professor-filtro-vinculo')?.value || '';
    const ordenacao = document.getElementById('professor-ordenacao')?.value || 'nome';
    const filtered = state.professores.filter(p => {
        if (!filtro) return true;
        return (p.nome || '').toLowerCase().includes(filtro) ||
            (p.email || '').toLowerCase().includes(filtro);
    }).filter(p => {
        if (filtroStatus && String(p.status || '') !== String(filtroStatus)) return false;
        if (filtroOrigem && String(p.origem || '') !== String(filtroOrigem)) return false;
        if (filtroVinculo && String(p.vinculo || '') !== String(filtroVinculo)) return false;
        return true;
    });

    filtered.sort((a, b) => {
        if (ordenacao === 'vinculo') {
            const vinculoCompare = (a.vinculo || '').localeCompare(b.vinculo || '', undefined, { sensitivity: 'base' });
            if (vinculoCompare !== 0) return vinculoCompare;
        }
        return (a.nome || '').localeCompare(b.nome || '', undefined, { sensitivity: 'base' });
    });
    tbody.innerHTML = filtered.map(p => `
        <tr class="border-b">
            <td class="py-2">${p.nome || '-'}</td>
            <td class="py-2">${p.email || '-'}</td>
            <td class="py-2">${p.vinculo || '-'}</td>
            <td class="py-2">${p.status || '-'}</td>
            <td class="py-2">${p.origem || '-'}</td>
            <td class="py-2">
                <button class="text-blue-600 hover:underline mr-2" data-id="${p.user_uid}" data-action="edit-prof">Editar</button>
                <button class="text-red-600 hover:underline" data-id="${p.user_uid}" data-action="inativar-prof">Inativar</button>
            </td>
        </tr>
    `).join('');

    tbody.querySelectorAll('button[data-action="edit-prof"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.id;
            const prof = state.professores.find(p => p.user_uid === id);
            openProfessorModal(prof);
        });
    });
    tbody.querySelectorAll('button[data-action="inativar-prof"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            await toggleProfessorStatus(id, 'inativo');
        });
    });
}

function openAlunoModal(aluno = null) {
    document.getElementById('aluno-modal-title').textContent = aluno ? 'Editar Aluno' : 'Novo Aluno';
    document.getElementById('aluno-id').value = aluno?.id || '';
    document.getElementById('aluno-nome').value = aluno?.nome_completo || '';
    document.getElementById('aluno-matricula').value = aluno?.matricula || '';
    document.getElementById('aluno-turma').value = aluno?.turma_id || '';
    document.getElementById('aluno-responsavel').value = aluno?.nome_responsavel || '';
    document.getElementById('aluno-telefone').value = aluno?.telefone || '';
    document.getElementById('aluno-status').value = aluno?.status || 'ativo';
    const alunoCriadoEm = aluno?.created_at || aluno?.copied_at || null;
    document.getElementById('aluno-criado-em').value = formatCreatedDate(alunoCriadoEm);
    openModal('aluno-modal');
}

function openProfessorModal(professor = null) {
    document.getElementById('professor-modal-title').textContent = professor ? 'Editar Professor' : 'Novo Professor';
    document.getElementById('professor-id').value = professor?.user_uid || '';
    document.getElementById('professor-nome').value = professor?.nome || '';
    document.getElementById('professor-email').value = professor?.email || '';
    document.getElementById('professor-telefone').value = professor?.telefone || '';
    document.getElementById('professor-vinculo').value = professor?.vinculo || 'efetivo';
    document.getElementById('professor-status').value = professor?.status || 'ativo';
    const profCriadoEm = professor?.created_at || professor?.copied_at || null;
    document.getElementById('professor-criado-em').value = formatCreatedDate(profCriadoEm);
    openModal('professor-modal');
}

async function saveAluno() {
    const id = document.getElementById('aluno-id').value;
    const payload = {
        nome_completo: document.getElementById('aluno-nome').value.trim(),
        matricula: document.getElementById('aluno-matricula').value.trim(),
        turma_id: document.getElementById('aluno-turma').value || null,
        nome_responsavel: document.getElementById('aluno-responsavel').value.trim(),
        telefone: document.getElementById('aluno-telefone').value.trim(),
        status: document.getElementById('aluno-status').value || 'ativo'
    };
    try {
        if (id) {
            await safeQuery(db.from('enc_alunos').update(payload).eq('id', id));
        } else {
            await safeQuery(db.from('enc_alunos').insert({ ...payload, origem: 'manual' }));
        }
        closeModal('aluno-modal');
        await loadData();
        showMessage('Aluno salvo com sucesso.');
    } catch (err) {
        showMessage('Erro ao salvar aluno: ' + (err?.message || err), true);
    }
}

async function saveProfessor() {
    const id = document.getElementById('professor-id').value;
    const payload = {
        nome: document.getElementById('professor-nome').value.trim(),
        email: document.getElementById('professor-email').value.trim(),
        telefone: document.getElementById('professor-telefone').value.trim(),
        vinculo: document.getElementById('professor-vinculo').value || 'efetivo',
        status: document.getElementById('professor-status').value || 'ativo'
    };
    try {
        if (id) {
            await safeQuery(db.from('enc_professores').update(payload).eq('user_uid', id));
        } else {
            await safeQuery(db.from('enc_professores').insert({ ...payload, origem: 'manual' }));
        }
        closeModal('professor-modal');
        await loadData();
        showMessage('Professor salvo com sucesso.');
    } catch (err) {
        showMessage('Erro ao salvar professor: ' + (err?.message || err), true);
    }
}

async function toggleAlunoStatus(id, status) {
    try {
        await safeQuery(db.from('enc_alunos').update({ status }).eq('id', id));
        await loadData();
        showMessage('Aluno inativado.');
    } catch (err) {
        showMessage('Erro ao inativar aluno: ' + (err?.message || err), true);
    }
}

async function deleteAluno(id) {
    const aluno = state.alunos.find(a => Number(a.id) === Number(id));
    if (!aluno) return;
    const warning = aluno.origem === 'apoia'
        ? 'Este aluno veio da Chamada. Se excluir, ele pode voltar na próxima sincronização.'
        : 'Esta ação é permanente e não pode ser desfeita.';
    const confirmDelete = window.confirm(`Deseja excluir o aluno "${aluno.nome_completo || ''}"?\n\n${warning}`);
    if (!confirmDelete) return;
    try {
        await safeQuery(db.from('enc_alunos').delete().eq('id', id));
        await loadData();
        showMessage('Aluno excluído.');
    } catch (err) {
        showMessage('Não foi possível excluir. Existem encaminhamentos vinculados. Use Inativar.', true);
    }
}

async function toggleProfessorStatus(id, status) {
    try {
        await safeQuery(db.from('enc_professores').update({ status }).eq('user_uid', id));
        await loadData();
        showMessage('Professor inativado.');
    } catch (err) {
        showMessage('Erro ao inativar professor: ' + (err?.message || err), true);
    }
}

function showMessage(message, isError = false) {
    const el = document.getElementById('cadastros-message');
    if (!el) return;
    el.textContent = message;
    el.className = `mb-4 text-sm ${isError ? 'text-red-600' : 'text-green-600'}`;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 4000);
}

function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
}

function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
}

import { db, state, getLocalDateString, safeQuery, showToast, closeModal, closeAllModals, logAudit } from './core.js';

const APOIA_ITEMS_PER_PAGE = 10;
let apoiaCurrentPage = 1;
let notificationsChannel = null;
let notificationsPollingId = null;
let notificationsReloadTimer = null;
let notificationsRealtimeStopping = false;
let notificationsChannelToken = 0;

// ===============================================================
// NOTIFICACOES
// ===============================================================

export async function loadNotifications() {
    const notificationBell = document.getElementById('notification-bell');
    const notificationList = document.getElementById('notification-list');
    if (!notificationBell || !notificationList) return;
    const { data, error, count } = await safeQuery(
        db.from('alertas')
            .select('*', { count: 'exact' })
            .eq('lido', false)
            .order('created_at', { ascending: false })
    );
    if (error) {
        console.error('Erro ao buscar notificacoes:', error);
        return;
    }
    const clearBtn = document.getElementById('clear-notifications-btn');
    if (clearBtn) clearBtn.classList.toggle('hidden', count === 0);
    if (count > 0) {
        notificationBell.classList.add('notification-badge');
        notificationBell.setAttribute('data-count', count);
    } else {
        notificationBell.classList.remove('notification-badge');
        notificationBell.setAttribute('data-count', 0);
    }
    if (!data || data.length === 0) {
        notificationList.innerHTML = '<p class="text-sm text-gray-500 p-4 text-center">Nenhuma nova notificacao.</p>';
    } else {
        notificationList.innerHTML = data
            .map(alert => `<div class="p-2 border-b hover:bg-gray-100 cursor-pointer text-sm text-gray-700 notification-item" data-id="${alert.id}">${alert.mensagem}</div>`)
            .join('');
    }
}

function scheduleNotificationsReload() {
    if (notificationsReloadTimer) clearTimeout(notificationsReloadTimer);
    notificationsReloadTimer = setTimeout(() => {
        loadNotifications();
    }, 150);
}

export function startNotificationsRealtime() {
    stopNotificationsRealtime();
    // Fallback imediato: polling garante atualização mesmo se o realtime falhar
    startNotificationsPolling();
    const protocol = window.location.protocol;
    const canUseRealtime = protocol === 'https:' || protocol === 'http:';
    if (!canUseRealtime) return;
    const token = ++notificationsChannelToken;
    notificationsChannel = db
        .channel('alertas-realtime')
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'alertas' },
            () => scheduleNotificationsReload()
        )
        .subscribe((status) => {
            if (token !== notificationsChannelToken) return;
            if (status === 'SUBSCRIBED') {
                stopNotificationsPolling();
                loadNotifications();
                return;
            }
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                if (!notificationsRealtimeStopping) stopNotificationsRealtime();
                startNotificationsPolling();
            }
        });
}

export function stopNotificationsRealtime() {
    if (notificationsRealtimeStopping) return;
    notificationsRealtimeStopping = true;
    notificationsChannelToken += 1;
    if (notificationsChannel) {
        try {
            db.removeChannel(notificationsChannel);
        } finally {
            notificationsChannel = null;
        }
    }
    if (notificationsReloadTimer) {
        clearTimeout(notificationsReloadTimer);
        notificationsReloadTimer = null;
    }
    notificationsRealtimeStopping = false;
}

export function startNotificationsPolling(intervalMs = 30000) {
    stopNotificationsPolling();
    notificationsPollingId = setInterval(() => {
        loadNotifications();
    }, intervalMs);
}

export function stopNotificationsPolling() {
    if (notificationsPollingId) {
        clearInterval(notificationsPollingId);
        notificationsPollingId = null;
    }
}

export async function markNotificationAsRead(alertId) {
    const { error } = await safeQuery(db.from('alertas').update({ lido: true }).eq('id', alertId));
    if (error) showToast('Erro ao marcar notificacao como lida.', true);
    else await loadNotifications();
}

export async function markAllNotificationsAsRead() {
    const { error } = await safeQuery(db.from('alertas').update({ lido: true }).eq('lido', false));
    if (error) showToast('Erro ao limpar notificacoes.', true);
    else await loadNotifications();
}

// ===============================================================
// ADMIN - DADOS E DASHBOARD
// ===============================================================

export async function loadAdminData() {
    const { data: turmas } = await safeQuery(db.from('turmas').select('id, nome_turma, ano_letivo'));
    state.turmasCache = (turmas || []).sort((a, b) => a.nome_turma.localeCompare(b.nome_turma, undefined, { numeric: true }));
    const { data: users } = await safeQuery(
        db.from('usuarios')
            .select('id, user_uid, nome, papel, email_confirmado, status, vinculo')
            .in('papel', ['professor', 'admin'])
    );
    state.usuariosCache = (users || []).sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
    const { data: allAlunos } = await safeQuery(db.from('alunos').select('id, nome_completo, turma_id').eq('status', 'ativo'));
    state.alunosCache = (allAlunos || []).sort((a, b) => a.nome_completo.localeCompare(b.nome_completo));
    let anos = [];
    try {
        const { data: anosRpc } = await safeQuery(db.rpc('get_distinct_ano_letivo'));
        anos = anosRpc || [];
    } catch (err) {
        const anosFallback = new Set((turmas || []).map(t => t.ano_letivo).filter(Boolean));
        anos = Array.from(anosFallback);
    }
    state.anosLetivosCache = anos ? anos.sort((a, b) => b - a) : [];
}

export async function renderDashboardPanel() {
    await loadDailySummary(state.dashboardSelectedDate);
    await renderDashboardCalendar();
    const { count } = await safeQuery(
        db.from('apoia_encaminhamentos').select('*', { count: 'exact', head: true }).eq('status', 'Em andamento')
    );
    document.getElementById('dashboard-acompanhamento').textContent = count ?? 0;
}

export async function loadDailySummary(selectedDate) {
    const ausentesListEl = document.getElementById('dashboard-ausentes-list');
    ausentesListEl.innerHTML = '<li>Carregando...</li>';

    const { data } = await safeQuery(
        db.from('presencas')
            .select('justificativa, alunos ( id, nome_completo ), turmas ( nome_turma )')
            .eq('data', selectedDate)
            .eq('status', 'falta')
    );
    const { count: totalPresencas } = await safeQuery(
        db.from('presencas').select('*', { count: 'exact', head: true }).eq('data', selectedDate).eq('status', 'presente')
    );
    const { count: totalFaltas } = await safeQuery(
        db.from('presencas').select('*', { count: 'exact', head: true }).eq('data', selectedDate).eq('status', 'falta')
    );
    document.getElementById('dashboard-presencas').textContent = totalPresencas ?? 0;
    document.getElementById('dashboard-faltas').textContent = totalFaltas ?? 0;

    if (!data) {
        ausentesListEl.innerHTML = '<li>Erro ao carregar dados.</li>';
        return;
    }
    if (data.length === 0) {
        ausentesListEl.innerHTML = '<li>Nenhum aluno ausente.</li>';
        return;
    }
    ausentesListEl.innerHTML = data.map(a => {
        const motivo = a.justificativa || 'Sem justificativa';
        return `<li><a href="#" class="dashboard-aluno-link text-blue-600 hover:underline" data-aluno-id="${a.alunos.id}">${a.alunos.nome_completo}</a> - ${a.turmas.nome_turma} <span class="text-xs text-gray-500">(${motivo})</span></li>`;
    }).join('');
}

export async function renderDashboardCalendar() {
    const calendarGrid = document.getElementById('calendar-grid');
    const monthYearEl = document.getElementById('calendar-month-year');
    const monthNames = ['Janeiro', 'Fevereiro', 'Marco', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    const escapeAttr = (value) => String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/'/g, '&#39;');

    const { month, year } = state.dashboardCalendar;
    monthYearEl.textContent = `${monthNames[month]} ${year}`;
    calendarGrid.innerHTML = '';

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const monthStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const monthEnd = `${year}-${String(month + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

    const { data: eventos } = await safeQuery(
        db.from('eventos')
            .select('*')
            .or(`data.gte.${monthStart},data_fim.gte.${monthStart}`)
            .or(`data.lte.${monthEnd},data_fim.lte.${monthEnd}`)
    );

    const eventosSet = new Set();
    const eventosByDate = new Map();
    (eventos || []).forEach(ev => {
        const inicio = new Date(ev.data + 'T00:00:00');
        const fim = new Date((ev.data_fim || ev.data) + 'T00:00:00');
        const labelParts = [ev.descricao || 'Evento'];
        if (ev.abrangencia && ev.abrangencia !== 'global') {
            labelParts.push('Turmas específicas');
        }
        const label = labelParts.join(' - ');
        for (let d = new Date(inicio); d <= fim; d.setDate(d.getDate() + 1)) {
            const key = d.toISOString().split('T')[0];
            eventosSet.add(key);
            const current = eventosByDate.get(key) || [];
            if (!current.includes(label)) current.push(label);
            eventosByDate.set(key, current);
        }
    });

    let html = '';
    for (let i = 0; i < firstDay; i++) {
        html += '<div></div>';
    }
    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const isSelected = dateStr === state.dashboardSelectedDate;
        const isWeekend = [0, 6].includes(new Date(dateStr + 'T00:00:00').getDay());
        const hasEvent = eventosSet.has(dateStr);
        const eventLabels = eventosByDate.get(dateStr);
        const eventTitle = eventLabels ? escapeAttr(eventLabels.join(' | ')) : '';
        html += `
            <div class="calendar-day-container ${isSelected ? 'calendar-day-selected' : ''}" data-date="${dateStr}">
                <div class="calendar-day-content ${hasEvent ? 'calendar-day-event' : ''} ${isWeekend ? 'calendar-day-weekend' : ''}" ${eventTitle ? `title="${eventTitle}"` : ''}>
                    ${day}
                </div>
            </div>
        `;
    }
    calendarGrid.innerHTML = html;
}

// ===============================================================
// ADMIN - ALUNOS
// ===============================================================

export async function renderAlunosPanel(options = {}) {
    const { defaultToLatestYear, resetTurmaFilter } = options;
    const alunoAnoLetivoFilter = document.getElementById('aluno-ano-letivo-filter');
    const alunoTurmaFilter = document.getElementById('aluno-turma-filter');
    const alunosTableBody = document.getElementById('alunos-table-body');
    const searchInput = document.getElementById('aluno-search-input');
    const defaultAno = state.anosLetivosCache.length > 0 ? String(state.anosLetivosCache[0]) : '';
    const previousSelection = alunoAnoLetivoFilter?.value || '';
    const previousTurmaSelection = alunoTurmaFilter?.value || '';
    const userTouched = alunoAnoLetivoFilter?.dataset.userTouched === 'true';
    let nextSelection = previousSelection;
    if (defaultToLatestYear && defaultAno) {
        nextSelection = defaultAno;
    } else if (!nextSelection && !userTouched && defaultAno) {
        nextSelection = defaultAno;
    }

    alunoAnoLetivoFilter.innerHTML = '<option value="">Todos os Anos</option>';
    state.anosLetivosCache.forEach(ano => alunoAnoLetivoFilter.innerHTML += `<option value="${ano}">${ano}</option>`);
    const optionValues = Array.from(alunoAnoLetivoFilter.options).map(opt => opt.value);
    if (nextSelection && optionValues.includes(String(nextSelection))) {
        alunoAnoLetivoFilter.value = String(nextSelection);
    } else if (!userTouched && defaultAno && optionValues.includes(defaultAno)) {
        alunoAnoLetivoFilter.value = defaultAno;
    } else {
        alunoAnoLetivoFilter.value = '';
    }
    const currentAnoVal = alunoAnoLetivoFilter?.value;

    alunoTurmaFilter.innerHTML = '<option value="">Todas as Turmas</option>';
    state.turmasCache
        .filter(t => !currentAnoVal || String(t.ano_letivo) === String(currentAnoVal))
        .forEach(t => alunoTurmaFilter.innerHTML += `<option value="${t.id}">${t.nome_turma}</option>`);
    if (resetTurmaFilter) {
        alunoTurmaFilter.value = '';
    } else if (previousTurmaSelection && Array.from(alunoTurmaFilter.options).some(opt => opt.value === String(previousTurmaSelection))) {
        alunoTurmaFilter.value = String(previousTurmaSelection);
    }

    alunosTableBody.innerHTML = '<tr><td colspan="7" class="p-4 text-center">Carregando...</td></tr>';
    try {
        let data = [];
        if (currentAnoVal) {
            const turmaFilterId = alunoTurmaFilter.value;
            if (turmaFilterId) {
                const { data: alunosTurma } = await safeQuery(
                    db.from('alunos')
                        .select(`*, turmas ( nome_turma, ano_letivo )`)
                        .eq('turma_id', turmaFilterId)
                );
                data = alunosTurma || [];
            } else {
                const [semTurma, comTurma] = await Promise.all([
                    safeQuery(db.from('alunos').select(`*, turmas ( nome_turma, ano_letivo )`).is('turma_id', null)),
                    safeQuery(db.from('alunos').select(`*, turmas!inner ( nome_turma, ano_letivo )`).eq('turmas.ano_letivo', currentAnoVal))
                ]);
                data = [...(semTurma.data || []), ...(comTurma.data || [])];
            }
        } else {
            const { data: all } = await safeQuery(db.from('alunos').select(`*, turmas ( nome_turma, ano_letivo )`));
            data = all || [];
        }

        const query = (searchInput?.value || '').trim().toLowerCase();
        if (query) {
            data = data.filter(a =>
                a.nome_completo.toLowerCase().includes(query) ||
                (a.matricula || '').toLowerCase().includes(query)
            );
        }

        if (data.length === 0) {
            alunosTableBody.innerHTML = '<tr><td colspan="7" class="p-4 text-center">Nenhum aluno encontrado.</td></tr>';
            return;
        }
        const uniqueStudents = [];
        const seen = new Set();
        data.forEach(aluno => {
            if (!seen.has(aluno.id)) {
                seen.add(aluno.id);
                uniqueStudents.push(aluno);
            }
        });

        const sortedStudents = [...uniqueStudents].sort((a, b) => {
            const turmaA = a.turmas?.nome_turma || '';
            const turmaB = b.turmas?.nome_turma || '';
            const missingA = turmaA ? 0 : 1;
            const missingB = turmaB ? 0 : 1;
            if (missingA !== missingB) return missingA - missingB;
            if (turmaA !== turmaB) {
                return turmaA.localeCompare(turmaB, undefined, { numeric: true, sensitivity: 'base' });
            }
            return (a.nome_completo || '').localeCompare(b.nome_completo || '', undefined, { sensitivity: 'base' });
        });

        alunosTableBody.innerHTML = sortedStudents.map(aluno => {
            const turmaNome = aluno.turmas?.nome_turma || 'Sem turma';
            return `
                <tr>
                    <td class="p-3">${aluno.nome_completo}</td>
                    <td class="p-3">${aluno.matricula || '-'}</td>
                    <td class="p-3">${turmaNome}</td>
                    <td class="p-3">${aluno.nome_responsavel || '-'}</td>
                    <td class="p-3">${aluno.telefone || '-'}</td>
                    <td class="p-3">${aluno.status}</td>
                    <td class="p-3 space-x-2">
                        <button class="text-blue-600 hover:underline edit-aluno-btn" data-id="${aluno.id}">Editar</button>
                        <button class="text-green-600 hover:underline historico-aluno-btn" data-id="${aluno.id}">Historico</button>
                        <button class="text-red-600 hover:underline delete-btn" data-type="aluno" data-id="${aluno.id}">Excluir</button>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        alunosTableBody.innerHTML = '<tr><td colspan="7" class="p-4 text-center text-red-500">Erro ao carregar.</td></tr>';
        console.error(err);
    }
}

export async function openAlunoModal(editId = null) {
    const modal = document.getElementById('aluno-modal');
    const form = document.getElementById('aluno-form');
    form.reset();
    document.getElementById('aluno-id').value = '';
    document.getElementById('aluno-modal-title').textContent = editId ? 'Editar Aluno' : 'Adicionar Aluno';
    document.getElementById('aluno-delete-container').classList.toggle('hidden', !editId);
    const alunoTurmaSelect = document.getElementById('aluno-turma');
    alunoTurmaSelect.innerHTML = '<option value="">Selecione...</option>';
    state.turmasCache.forEach(t => alunoTurmaSelect.innerHTML += `<option value="${t.id}">${t.nome_turma}</option>`);

    if (editId) {
        const { data } = await safeQuery(db.from('alunos').select('*').eq('id', editId).single());
        if (data) {
            document.getElementById('aluno-id').value = data.id;
            document.getElementById('aluno-nome').value = data.nome_completo;
            document.getElementById('aluno-matricula').value = data.matricula || '';
            document.getElementById('aluno-turma').value = data.turma_id || '';
            document.getElementById('aluno-responsavel').value = data.nome_responsavel || '';
            document.getElementById('aluno-telefone').value = data.telefone || '';
            document.getElementById('aluno-status').value = data.status || 'ativo';
        }
    }
    modal.classList.remove('hidden');
}

export async function handleAlunoFormSubmit(e) {
    const id = document.getElementById('aluno-id').value;
    const alunoData = {
        nome_completo: document.getElementById('aluno-nome').value,
        matricula: document.getElementById('aluno-matricula').value,
        turma_id: document.getElementById('aluno-turma').value || null,
        nome_responsavel: document.getElementById('aluno-responsavel').value,
        telefone: document.getElementById('aluno-telefone').value,
        status: document.getElementById('aluno-status').value || 'ativo'
    };
    if (id) {
        const { error } = await safeQuery(db.from('alunos').update(alunoData).eq('id', id));
        if (error) showToast('Erro ao salvar aluno: ' + error.message, true);
        else {
            await logAudit('update', 'aluno', id, { alunoData });
            showToast('Aluno salvo com sucesso!');
            closeAllModals();
            await renderAlunosPanel();
        }
    } else {
        const { data, error } = await safeQuery(db.from('alunos').insert(alunoData).select().single());
        if (error) showToast('Erro ao salvar aluno: ' + error.message, true);
        else {
            await logAudit('create', 'aluno', data?.id || null, { alunoData });
            showToast('Aluno salvo com sucesso!');
            closeAllModals();
            await renderAlunosPanel();
        }
    }
}

// ===============================================================
// ADMIN - APOIA (ACOMPANHAMENTO)
// ===============================================================

export async function renderApoiaPanel(page = 1) {
    apoiaCurrentPage = page;
    const apoiaTableBody = document.getElementById('apoia-table-body');
    apoiaTableBody.innerHTML = '<tr><td colspan="5" class="p-4 text-center">Carregando...</td></tr>';

    const { count } = await safeQuery(db.from('apoia_encaminhamentos').select('*', { count: 'exact', head: true }));
    const totalPages = Math.ceil((count || 0) / APOIA_ITEMS_PER_PAGE);

    const from = (page - 1) * APOIA_ITEMS_PER_PAGE;
    const to = from + APOIA_ITEMS_PER_PAGE - 1;
    const { data, error } = await safeQuery(
        db.from('apoia_encaminhamentos')
            .select(`*, alunos(nome_completo)`)
            .order('status', { ascending: true })
            .order('data_encaminhamento', { ascending: false })
            .range(from, to)
    );
    if (error) {
        apoiaTableBody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-red-500">Erro ao carregar.</td></tr>';
        return;
    }
    if (!data || data.length === 0) {
        apoiaTableBody.innerHTML = '<tr><td colspan="5" class="p-4 text-center">Nenhum aluno em acompanhamento.</td></tr>';
        document.getElementById('apoia-pagination').innerHTML = '';
        return;
    }

    apoiaTableBody.innerHTML = data.map(item => `
        <tr>
            <td class="p-3">${item.alunos?.nome_completo || ''}</td>
            <td class="p-3">${item.data_encaminhamento}</td>
            <td class="p-3">${item.motivo}</td>
            <td class="p-3">${item.status}</td>
            <td class="p-3">
                <button class="text-blue-600 hover:underline edit-acompanhamento-btn" data-id="${item.id}">Editar</button>
                <button class="text-red-600 hover:underline delete-btn" data-type="acompanhamento" data-id="${item.id}">Excluir</button>
            </td>
        </tr>
    `).join('');

    renderApoiaPagination(totalPages, page);
}

export function renderApoiaPagination(totalPages, currentPage) {
    const paginationContainer = document.getElementById('apoia-pagination');
    paginationContainer.innerHTML = '';
    if (totalPages <= 1) return;

    for (let i = 1; i <= totalPages; i++) {
        const button = document.createElement('button');
        button.textContent = i;
        button.className = `px-3 py-1 rounded-md ${i === currentPage ? 'bg-blue-600 text-white' : 'bg-gray-200'}`;
        button.addEventListener('click', () => renderApoiaPanel(i));
        paginationContainer.appendChild(button);
    }
}

export async function openAcompanhamentoModal(editId = null) {
    const modal = document.getElementById('acompanhamento-modal');
    const form = document.getElementById('acompanhamento-form');
    form.reset();
    document.getElementById('acompanhamento-id').value = '';
    document.getElementById('acompanhamento-modal-title').textContent = editId ? 'Editar Acompanhamento' : 'Adicionar Acompanhamento';
    document.getElementById('acompanhamento-delete-container').classList.toggle('hidden', !editId);
    const alunoSelect = document.getElementById('acompanhamento-aluno-select');
    alunoSelect.innerHTML = '<option value="">Selecione um aluno...</option>';

    if (editId) {
        const { data } = await safeQuery(db.from('apoia_encaminhamentos').select('*, alunos(nome_completo)').eq('id', editId).single());
        if (data) {
            document.getElementById('acompanhamento-id').value = data.id;
            alunoSelect.innerHTML = `<option value="${data.aluno_id}">${data.alunos.nome_completo}</option>`;
            document.getElementById('acompanhamento-motivo').value = data.motivo || '';
            document.getElementById('acompanhamento-status').value = data.status || 'Em andamento';
            document.getElementById('acompanhamento-observacoes').value = data.observacoes || '';
        }
    } else {
        alunoSelect.innerHTML = '<option value="">Selecione um aluno...</option>';
        state.alunosCache.forEach(a => alunoSelect.innerHTML += `<option value="${a.id}">${a.nome_completo}</option>`);
    }
    modal.classList.remove('hidden');
}

export async function handleAcompanhamentoFormSubmit(e) {
    const id = document.getElementById('acompanhamento-id').value;
    const acompanhamentoData = {
        aluno_id: document.getElementById('acompanhamento-aluno-select').value,
        motivo: document.getElementById('acompanhamento-motivo').value,
        status: document.getElementById('acompanhamento-status').value,
        observacoes: document.getElementById('acompanhamento-observacoes').value,
        data_encaminhamento: getLocalDateString()
    };
    const queryBuilder = id
        ? db.from('apoia_encaminhamentos').update(acompanhamentoData).eq('id', id)
        : db.from('apoia_encaminhamentos').insert(acompanhamentoData);
    const { error } = await safeQuery(queryBuilder);
    if (error) showToast('Erro ao salvar acompanhamento: ' + error.message, true);
    else {
        await logAudit(id ? 'update' : 'create', 'apoia_encaminhamento', id || null, { acompanhamentoData });
        showToast('Acompanhamento salvo com sucesso!');
        closeAllModals();
        await renderApoiaPanel(apoiaCurrentPage);
    }
}

export async function handleGerarApoiaRelatorio() {
    const dataInicio = document.getElementById('apoia-relatorio-data-inicio')?.value;
    const dataFim = document.getElementById('apoia-relatorio-data-fim')?.value;
    const status = document.getElementById('apoia-relatorio-status')?.value;
    let queryBuilder = db.from('apoia_encaminhamentos').select(`*, alunos(nome_completo)`).order('data_encaminhamento');
    if (dataInicio) queryBuilder = queryBuilder.gte('data_encaminhamento', dataInicio);
    if (dataFim) queryBuilder = queryBuilder.lte('data_encaminhamento', dataFim);
    if (status) queryBuilder = queryBuilder.eq('status', status);
    const { data, error } = await safeQuery(queryBuilder);
    const tableBody = document.getElementById('apoia-relatorio-table-body');
    const printBtn = document.getElementById('imprimir-apoia-relatorio-btn');
    const periodoEl = document.getElementById('apoia-relatorio-periodo-impressao');
    if (periodoEl) {
        periodoEl.textContent = dataInicio || dataFim
            ? `Período: ${dataInicio || '...'} até ${dataFim || '...'}`
            : 'Período: Todos os registros';
    }
    if (error) {
        tableBody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-red-500">Erro ao gerar relatorio.</td></tr>';
        if (printBtn) printBtn.classList.add('hidden');
        return;
    }
    if (!data || data.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="5" class="p-4 text-center">Nenhum registro encontrado.</td></tr>';
        if (printBtn) printBtn.classList.add('hidden');
        return;
    }
    tableBody.innerHTML = data.map(item => `
        <tr>
            <td class="p-3">${item.alunos?.nome_completo || ''}</td>
            <td class="p-3">${item.data_encaminhamento}</td>
            <td class="p-3">${item.motivo}</td>
            <td class="p-3">${item.status}</td>
            <td class="p-3">${item.observacoes || '-'}</td>
        </tr>
    `).join('');
    if (printBtn) printBtn.classList.remove('hidden');
}

// ===============================================================
// ADMIN - PROFESSORES
// ===============================================================

export async function renderProfessoresPanel() {
    const professoresTableBody = document.getElementById('professores-table-body');
    const searchInput = document.getElementById('professor-search-input');
    professoresTableBody.innerHTML = '<tr><td colspan="7" class="p-4 text-center">Carregando...</td></tr>';
    const { data, error } = await safeQuery(
        db.from('usuarios')
            .select('id, user_uid, nome, email, status, email_confirmado, vinculo')
            .eq('papel', 'professor')
    );
    if (error) {
        professoresTableBody.innerHTML = '<tr><td colspan="7" class="p-4 text-center text-red-500">Erro ao carregar.</td></tr>';
        return;
    }
    let filtered = data || [];
    const query = (searchInput?.value || '').trim().toLowerCase();
    if (query) {
        filtered = filtered.filter(p =>
            (p.nome || '').toLowerCase().includes(query) ||
            (p.email || '').toLowerCase().includes(query)
        );
    }
    if (!filtered || filtered.length === 0) {
        const emptyMessage = query ? 'Nenhum professor encontrado.' : 'Nenhum professor cadastrado.';
        professoresTableBody.innerHTML = `<tr><td colspan="7" class="p-4 text-center">${emptyMessage}</td></tr>`;
        return;
    }
    const orderMap = { efetivo: 0, act: 1 };
    const sorted = [...filtered].sort((a, b) => {
        const orderA = orderMap[a.vinculo] ?? 2;
        const orderB = orderMap[b.vinculo] ?? 2;
        if (orderA !== orderB) return orderA - orderB;
        return (a.nome || '').localeCompare(b.nome || '', undefined, { sensitivity: 'base' });
    });
    professoresTableBody.innerHTML = sorted.map(p => {
        const statusClass = p.status === 'ativo'
            ? 'bg-green-100 text-green-700'
            : 'bg-red-100 text-red-700';
        const confirmDot = p.email_confirmado ? 'bg-green-500' : 'bg-red-500';
        const vinculoLabel = p.vinculo === 'act' ? 'ACT' : 'Efetivo';
        const vinculoClass = p.vinculo === 'act'
            ? 'bg-amber-100 text-amber-700'
            : 'bg-blue-100 text-blue-700';
        return `
        <tr>
            <td class="p-3">
                <span class="inline-flex items-center px-2 py-0.5 mr-2 text-xs font-semibold rounded-full ${vinculoClass}">${vinculoLabel}</span>
                ${p.nome}
            </td>
            <td class="p-3">${p.email}</td>
            <td class="p-3"><span class="px-2 py-1 text-xs font-semibold rounded-full ${statusClass}">${p.status}</span></td>
            <td class="p-3 text-center"><span class="inline-block w-3 h-3 rounded-full ${confirmDot}"></span></td>
            <td class="p-3 space-x-4">
                <button class="text-blue-600 hover:underline edit-professor-btn" data-id="${p.id}">Editar</button>
                <button class="text-orange-600 hover:underline reset-password-btn" data-email="${p.email}">Resetar Senha</button>
            </td>
        </tr>
    `;
    }).join('');
}

export async function openProfessorModal(editId = null) {
    const modal = document.getElementById('professor-modal');
    const form = document.getElementById('professor-form');
    const statusContainer = document.getElementById('status-field-container');
    const passwordContainer = document.getElementById('password-field-container');
    const vinculoSelect = document.getElementById('professor-vinculo');
    form.reset();
    document.getElementById('professor-id').value = '';
    document.getElementById('professor-modal-title').textContent = editId ? 'Editar Professor' : 'Adicionar Professor';
    document.getElementById('professor-delete-container').classList.toggle('hidden', !editId);
    if (statusContainer) statusContainer.classList.toggle('hidden', !editId);
    if (passwordContainer) passwordContainer.classList.toggle('hidden', !!editId);
    if (vinculoSelect) vinculoSelect.value = 'efetivo';
    if (editId) {
        const { data } = await safeQuery(db.from('usuarios').select('*').eq('id', editId).single());
        if (data) {
            document.getElementById('professor-id').value = data.id;
            document.getElementById('professor-nome').value = data.nome;
            document.getElementById('professor-email').value = data.email;
            document.getElementById('professor-status').value = data.status || 'ativo';
            if (vinculoSelect) vinculoSelect.value = data.vinculo || 'efetivo';
        }
    }
    modal.classList.remove('hidden');
}

export async function handleProfessorFormSubmit(e) {
    const id = document.getElementById('professor-id').value;
    const nome = document.getElementById('professor-nome').value;
    const email = document.getElementById('professor-email').value;
    const status = document.getElementById('professor-status').value || 'ativo';
    const vinculo = document.getElementById('professor-vinculo')?.value || 'efetivo';
    if (id) {
        const { error } = await safeQuery(db.from('usuarios').update({ nome, email, status, vinculo }).eq('id', id));
        if (error) showToast('Erro ao salvar professor: ' + error.message, true);
        else {
            await logAudit('update', 'professor', id, { nome, email, status, vinculo });
            showToast('Professor salvo com sucesso!');
            closeAllModals();
            await renderProfessoresPanel();
        }
    } else {
        const randomPassword = Math.random().toString(36).slice(-8);
        const { data: authData, error: authError } = await db.auth.signUp({ email, password: randomPassword });
        if (authError) {
            showToast('Erro ao criar usuário: ' + authError.message, true);
            return;
        }
        const { data: profileData, error: profileError } = await safeQuery(
            db.from('usuarios').insert({ user_uid: authData.user.id, nome: nome, email: email, papel: 'professor', status: 'ativo', vinculo }).select().single()
        );
        if (profileError) showToast('Erro ao salvar professor: ' + profileError.message, true);
        else {
            await logAudit('create', 'professor', profileData?.id || authData.user.id, { nome, email, status: 'ativo', vinculo });
            showToast('Professor criado com sucesso! Envie um email de boas-vindas com a senha gerada.');
            closeAllModals();
            await renderProfessoresPanel();
        }
    }
}

export async function handleResetPassword(email) {
    const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: window.location.href.split('#')[0] });
    if (error) showToast('Erro ao enviar email de recuperação: ' + error.message, true);
    else showToast('Email de redefinicao enviado!');
}

// ===============================================================
// ADMIN - TURMAS
// ===============================================================

export async function renderTurmasPanel(options = {}) {
    const { defaultToLatestYear } = options;
    const anoLetivoFilter = document.getElementById('turma-ano-letivo-filter');
    const turmasTableBody = document.getElementById('turmas-table-body');
    const previousSelection = anoLetivoFilter.value;
    const defaultAno = state.anosLetivosCache.length > 0 ? String(state.anosLetivosCache[0]) : '';
    const userTouched = anoLetivoFilter.dataset.userTouched === 'true';
    let nextSelection = previousSelection;
    if (defaultToLatestYear && defaultAno) {
        nextSelection = defaultAno;
    } else if (!nextSelection && !userTouched && defaultAno) {
        nextSelection = defaultAno;
    }
    anoLetivoFilter.innerHTML = '<option value="">Todos os Anos</option>';
    state.anosLetivosCache.forEach(ano => anoLetivoFilter.innerHTML += `<option value="${ano}">${ano}</option>`);
    const optionValues = Array.from(anoLetivoFilter.options).map(opt => opt.value);
    const hasNext = nextSelection && optionValues.includes(String(nextSelection));
    if (hasNext) {
        anoLetivoFilter.value = String(nextSelection);
    } else if (!userTouched && defaultAno && optionValues.includes(defaultAno)) {
        anoLetivoFilter.value = defaultAno;
    } else {
        anoLetivoFilter.value = '';
    }
    const anoSelecionado = anoLetivoFilter.value || '';

    turmasTableBody.innerHTML = '<tr><td colspan="3" class="p-4 text-center">Carregando...</td></tr>';
    let queryBuilder = db.from('turmas').select(`id, nome_turma, ano_letivo, professores_turmas(usuarios(nome))`);
    if (anoSelecionado) queryBuilder = queryBuilder.eq('ano_letivo', anoSelecionado);
    const { data, error } = await safeQuery(queryBuilder);
    if (error) {
        turmasTableBody.innerHTML = '<tr><td colspan="3" class="p-4 text-center text-red-500">Erro ao carregar.</td></tr>';
        return;
    }
    if (!data || data.length === 0) {
        turmasTableBody.innerHTML = '<tr><td colspan="3" class="p-4 text-center">Nenhuma turma encontrada.</td></tr>';
        return;
    }
    const sortedTurmas = [...data].sort((a, b) => {
        if (anoSelecionado) {
            return (a.nome_turma || '').localeCompare(b.nome_turma || '', undefined, { numeric: true });
        }
        const anoCompare = (a.ano_letivo || 0) - (b.ano_letivo || 0);
        if (anoCompare !== 0) return anoCompare;
        return (a.nome_turma || '').localeCompare(b.nome_turma || '', undefined, { numeric: true });
    });
    turmasTableBody.innerHTML = sortedTurmas.map(t => {
        const profs = (t.professores_turmas || []).map(p => p.usuarios?.nome).filter(Boolean).join(', ') || '-';
        return `
            <tr>
                <td class="p-3">${t.nome_turma}</td>
                <td class="p-3">${profs}</td>
                <td class="p-3">
                    <button class="text-blue-600 hover:underline edit-turma-btn" data-id="${t.id}">Editar</button>
                    <button class="text-red-600 hover:underline delete-turma-btn" data-id="${t.id}">Excluir</button>
                </td>
            </tr>
        `;
    }).join('');
}

export async function openTurmaModal(editId = null) {
    const modal = document.getElementById('turma-modal');
    const form = document.getElementById('turma-form');
    form.reset();
    document.getElementById('turma-id').value = '';
    document.getElementById('turma-modal-title').textContent = editId ? 'Editar Turma' : 'Adicionar Turma';
    document.getElementById('turma-delete-container').classList.toggle('hidden', !editId);

    const turmaProfessoresList = document.getElementById('turma-professores-list');
    turmaProfessoresList.innerHTML = '';
    state.usuariosCache
        .filter(u => u.papel === 'professor')
        .forEach(p => turmaProfessoresList.innerHTML += `
            <label class="flex items-center space-x-2">
                <input type="checkbox" class="form-checkbox turma-professor-checkbox" value="${p.user_uid}">
                <span>${p.nome}</span>
            </label>
        `);

    if (editId) {
        const { data } = await safeQuery(db.from('turmas').select('*').eq('id', editId).single());
        if (data) {
            document.getElementById('turma-id').value = data.id;
            document.getElementById('turma-nome').value = data.nome_turma;
            document.getElementById('turma-ano-letivo').value = data.ano_letivo;
        }
        const { data: profsAtuais } = await safeQuery(db.from('professores_turmas').select('professor_id').eq('turma_id', editId));
        const ids = (profsAtuais || []).map(p => p.professor_id);
        turmaProfessoresList.querySelectorAll('input').forEach(cb => {
            if (ids.includes(cb.value)) cb.checked = true;
        });
    }
    modal.classList.remove('hidden');
}

export async function handleTurmaFormSubmit(e) {
    const id = document.getElementById('turma-id').value;
    const nome = document.getElementById('turma-nome').value;
    const ano_letivo = document.getElementById('turma-ano-letivo').value;
    const professoresSelecionados = Array.from(document.querySelectorAll('.turma-professor-checkbox:checked')).map(cb => cb.value);
    const rels = professoresSelecionados.map(profId => ({ turma_id: id ? parseInt(id) : null, professor_id: profId }));

    if (id) {
        const { error } = await safeQuery(db.from('turmas').update({ nome_turma: nome, ano_letivo: ano_letivo }).eq('id', id));
        if (error) {
            showToast('Erro ao salvar turma: ' + error.message, true);
            return;
        }
        await safeQuery(db.from('professores_turmas').delete().eq('turma_id', id));
        if (rels.length > 0) await safeQuery(db.from('professores_turmas').insert(rels.map(r => ({ ...r, turma_id: parseInt(id) }))));
        await logAudit('update', 'turma', id, { nome, ano_letivo, professoresSelecionados });
        showToast('Turma atualizada com sucesso!');
    } else {
        const { data, error: insertError } = await safeQuery(
            db.from('turmas').insert({ nome_turma: nome, ano_letivo: ano_letivo }).select().single()
        );
        if (insertError) {
            showToast('Erro ao salvar turma: ' + insertError.message, true);
            return;
        }
        if (rels.length > 0) await safeQuery(db.from('professores_turmas').insert(rels.map(r => ({ ...r, turma_id: data.id }))));
        await logAudit('create', 'turma', data?.id || null, { nome, ano_letivo, professoresSelecionados });
        showToast('Turma criada com sucesso!');
    }
    closeAllModals();
    await renderTurmasPanel();
}

// ===============================================================
// ADMIN - RELATORIOS
// ===============================================================

export async function renderRelatoriosPanel() {
    const turmaFilter = document.getElementById('relatorio-turma-select');
    const alunoFilter = document.getElementById('relatorio-aluno-select');
    const profFilter = document.getElementById('relatorio-professor-select');
    turmaFilter.innerHTML = '<option value="">Todas</option>';
    alunoFilter.innerHTML = '<option value="">Todos</option>';
    profFilter.innerHTML = '<option value="">Todos</option>';
    state.turmasCache.forEach(t => turmaFilter.innerHTML += `<option value="${t.id}">${t.nome_turma}</option>`);
    state.alunosCache.forEach(a => alunoFilter.innerHTML += `<option value="${a.id}">${a.nome_completo}</option>`);
    state.usuariosCache.filter(u => u.papel === 'professor').forEach(p => profFilter.innerHTML += `<option value="${p.user_uid}">${p.nome}</option>`);
}

export async function handleGerarRelatorio() {
    const dataInicio = document.getElementById('relatorio-data-inicio').value;
    const dataFim = document.getElementById('relatorio-data-fim').value;
    const turmaId = document.getElementById('relatorio-turma-select').value;
    const alunoId = document.getElementById('relatorio-aluno-select').value;
    const professorId = document.getElementById('relatorio-professor-select').value;
    const status = document.getElementById('relatorio-status-select').value;
    const relatorioTableBody = document.getElementById('relatorio-table-body');
    const printBtn = document.getElementById('imprimir-relatorio-btn');
    relatorioTableBody.innerHTML = '<tr><td colspan="7" class="p-4 text-center">Gerando relatorio...</td></tr>';

    let queryBuilder = db.from('presencas')
        .select(`data, registrado_em, status, justificativa, alunos ( nome_completo ), turmas ( nome_turma ), usuarios ( nome )`)
        .order('data', { ascending: false });
    if (dataInicio) queryBuilder = queryBuilder.gte('data', dataInicio);
    if (dataFim) queryBuilder = queryBuilder.lte('data', dataFim);
    if (turmaId) queryBuilder = queryBuilder.eq('turma_id', turmaId);
    if (alunoId) queryBuilder = queryBuilder.eq('aluno_id', alunoId);
    if (professorId) queryBuilder = queryBuilder.eq('registrado_por_uid', professorId);
    if (status) queryBuilder = queryBuilder.eq('status', status);

    const { data, error } = await safeQuery(queryBuilder);
    if (error) {
        relatorioTableBody.innerHTML = '<tr><td colspan="7" class="p-4 text-center text-red-500">Erro ao gerar relatorio.</td></tr>';
        if (printBtn) printBtn.classList.add('hidden');
        return;
    }
    if (!data || data.length === 0) {
        relatorioTableBody.innerHTML = '<tr><td colspan="7" class="p-4 text-center">Nenhum registro encontrado.</td></tr>';
        if (printBtn) printBtn.classList.add('hidden');
        return;
    }
    const formatHora = (value) => value ? new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '-';
    relatorioTableBody.innerHTML = data.map(r => `
        <tr>
            <td class="p-3">${r.data}</td>
            <td class="p-3">${formatHora(r.registrado_em)}</td>
            <td class="p-3">${r.alunos?.nome_completo || ''}</td>
            <td class="p-3">${r.turmas?.nome_turma || ''}</td>
            <td class="p-3">${r.status}</td>
            <td class="p-3">${r.justificativa || '-'}</td>
            <td class="p-3">${r.usuarios?.nome || ''}</td>
        </tr>
    `).join('');
    if (printBtn) printBtn.classList.remove('hidden');
}

export function handleLimparRelatorio() {
    const idsToClear = [
        'relatorio-data-inicio',
        'relatorio-data-fim',
        'relatorio-turma-select',
        'relatorio-aluno-select',
        'relatorio-professor-select',
        'relatorio-status-select'
    ];
    idsToClear.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const tableBody = document.getElementById('relatorio-table-body');
    if (tableBody) {
        tableBody.innerHTML = '<tr><td colspan="7" class="p-4 text-center">Nenhuma consulta realizada.</td></tr>';
    }
    const periodoEl = document.getElementById('relatorio-periodo-impressao');
    if (periodoEl) periodoEl.textContent = '';
    const printBtn = document.getElementById('imprimir-relatorio-btn');
    if (printBtn) printBtn.classList.add('hidden');
}

// ===============================================================
// ADMIN - CONFIGURACOES
// ===============================================================

export async function renderConfigPanel() {
    const { data, error } = await safeQuery(db.from('configuracoes').select('*').limit(1).single());
    if (error || !data) return;
    const faltasConsecutivas = data.faltas_consecutivas ?? data.faltas_consecutivas_limite ?? '';
    const faltasIntercaladas = data.faltas_intercaladas ?? data.faltas_intercaladas_limite ?? '';
    const faltasDias = data.faltas_dias ?? data.faltas_intercaladas_dias ?? '';
    const alertaChamada = data.alerta_chamada_ativo ?? data.alerta_chamada_nao_feita_ativo ?? false;
    document.getElementById('config-faltas-consecutivas').value = faltasConsecutivas;
    document.getElementById('config-faltas-intercaladas').value = faltasIntercaladas;
    document.getElementById('config-faltas-dias').value = faltasDias;
    document.getElementById('config-alerta-horario').value = data.alerta_horario || '';
    document.getElementById('config-alerta-faltas-ativo').checked = !!data.alerta_faltas_ativo;
    document.getElementById('config-alerta-chamada-ativo').checked = !!alertaChamada;
}

export async function handleConfigFormSubmit(e) {
    const parseNumberOrNull = (value) => {
        if (value === '' || value === null || value === undefined) return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    };
    const faltasConsecutivas = parseNumberOrNull(document.getElementById('config-faltas-consecutivas').value);
    const faltasIntercaladas = parseNumberOrNull(document.getElementById('config-faltas-intercaladas').value);
    const faltasDias = parseNumberOrNull(document.getElementById('config-faltas-dias').value);
    const alertaChamada = document.getElementById('config-alerta-chamada-ativo').checked;
    const configData = {
        faltas_consecutivas: faltasConsecutivas,
        faltas_consecutivas_limite: faltasConsecutivas,
        faltas_intercaladas: faltasIntercaladas,
        faltas_intercaladas_limite: faltasIntercaladas,
        faltas_dias: faltasDias,
        faltas_intercaladas_dias: faltasDias,
        alerta_horario: document.getElementById('config-alerta-horario').value || null,
        alerta_faltas_ativo: document.getElementById('config-alerta-faltas-ativo').checked,
        alerta_chamada_ativo: alertaChamada,
        alerta_chamada_nao_feita_ativo: alertaChamada
    };

    const { data: existing } = await safeQuery(
        db.from('configuracoes').select('id').limit(1).maybeSingle()
    );

    let error;
    if (existing?.id) {
        ({ error } = await safeQuery(db.from('configuracoes').update(configData).eq('id', existing.id)));
    } else {
        ({ error } = await safeQuery(db.from('configuracoes').insert(configData)));
    }
    if (error) showToast('Erro ao salvar configurações: ' + error.message, true);
    else {
        await logAudit('update', 'configuracoes', null, { configData });
        showToast('Configurações salvas com sucesso!');
    }
}

// ===============================================================
// ADMIN - CONSISTENCIA
// ===============================================================

export async function renderConsistenciaPanel() {
    const alunosSemTurmaCountEl = document.getElementById('consistencia-alunos-sem-turma-count');
    const profSemTurmaCountEl = document.getElementById('consistencia-prof-sem-turma-count');
    const turmasDuplicadasCountEl = document.getElementById('consistencia-turmas-duplicadas-count');
    const alunosOrfaosCountEl = document.getElementById('consistencia-alunos-orfaos-count');

    const alunosSemTurmaTable = document.getElementById('consistencia-alunos-sem-turma-table');
    const profSemTurmaTable = document.getElementById('consistencia-prof-sem-turma-table');
    const turmasDuplicadasTable = document.getElementById('consistencia-turmas-duplicadas-table');
    const alunosOrfaosTable = document.getElementById('consistencia-alunos-orfaos-table');

    const setLoading = () => {
        alunosSemTurmaCountEl.textContent = '...';
        profSemTurmaCountEl.textContent = '...';
        turmasDuplicadasCountEl.textContent = '...';
        alunosOrfaosCountEl.textContent = '...';
        alunosSemTurmaTable.innerHTML = '<tr><td colspan="2" class="p-4 text-center">Carregando...</td></tr>';
        profSemTurmaTable.innerHTML = '<tr><td colspan="2" class="p-4 text-center">Carregando...</td></tr>';
        turmasDuplicadasTable.innerHTML = '<tr><td colspan="3" class="p-4 text-center">Carregando...</td></tr>';
        alunosOrfaosTable.innerHTML = '<tr><td colspan="3" class="p-4 text-center">Carregando...</td></tr>';
    };

    setLoading();

    try {
        const [
            alunosSemTurmaCountRes,
            alunosSemTurmaListRes,
            profsRes,
            profsTurmasRes,
            turmasRes,
            totalComTurmaRes,
            totalComJoinRes,
            alunosComTurmaListRes
        ] = await Promise.all([
            safeQuery(db.from('alunos').select('*', { count: 'exact', head: true }).eq('status', 'ativo').is('turma_id', null)),
            safeQuery(db.from('alunos').select('id, nome_completo, matricula').eq('status', 'ativo').is('turma_id', null).order('nome_completo').limit(50)),
            safeQuery(db.from('usuarios').select('id, user_uid, nome, email').eq('papel', 'professor').order('nome')),
            safeQuery(db.from('professores_turmas').select('professor_id')),
            safeQuery(db.from('turmas').select('id, nome_turma, ano_letivo')),
            safeQuery(db.from('alunos').select('*', { count: 'exact', head: true }).not('turma_id', 'is', null)),
            safeQuery(db.from('alunos').select('id, turmas!inner(id)', { count: 'exact', head: true }).not('turma_id', 'is', null)),
            safeQuery(db.from('alunos').select('id, nome_completo, matricula, turma_id, turmas ( id )').not('turma_id', 'is', null).limit(200))
        ]);

        // Alunos ativos sem turma
        const alunosSemTurmaCount = alunosSemTurmaCountRes.count || 0;
        alunosSemTurmaCountEl.textContent = alunosSemTurmaCount;
        const alunosSemTurma = alunosSemTurmaListRes.data || [];
        alunosSemTurmaTable.innerHTML = alunosSemTurma.length
            ? alunosSemTurma.map(a => `
                <tr>
                    <td class="p-3">${a.nome_completo}</td>
                    <td class="p-3">${a.matricula || '-'}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="2" class="p-4 text-center">Nenhum encontrado.</td></tr>';

        // Professores sem turma
        const profs = profsRes.data || [];
        const profsTurmas = profsTurmasRes.data || [];
        const profsComTurma = new Set(profsTurmas.map(p => p.professor_id));
        const profsSemTurma = profs.filter(p => !profsComTurma.has(p.user_uid));
        profSemTurmaCountEl.textContent = profsSemTurma.length;
        profSemTurmaTable.innerHTML = profsSemTurma.length
            ? profsSemTurma.slice(0, 50).map(p => `
                <tr>
                    <td class="p-3">${p.nome}</td>
                    <td class="p-3">${p.email}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="2" class="p-4 text-center">Nenhum encontrado.</td></tr>';

        // Turmas duplicadas no mesmo ano
        const turmas = turmasRes.data || [];
        const dupMap = new Map();
        turmas.forEach(t => {
            const key = `${t.nome_turma}__${t.ano_letivo}`;
            const current = dupMap.get(key) || { nome_turma: t.nome_turma, ano_letivo: t.ano_letivo, count: 0 };
            current.count += 1;
            dupMap.set(key, current);
        });
        const duplicadas = Array.from(dupMap.values()).filter(d => d.count > 1).sort((a, b) => b.count - a.count);
        turmasDuplicadasCountEl.textContent = duplicadas.length;
        turmasDuplicadasTable.innerHTML = duplicadas.length
            ? duplicadas.slice(0, 50).map(d => `
                <tr>
                    <td class="p-3">${d.nome_turma}</td>
                    <td class="p-3">${d.ano_letivo}</td>
                    <td class="p-3">${d.count}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="3" class="p-4 text-center">Nenhuma duplicidade encontrada.</td></tr>';

        // Alunos com turma inexistente (orfaos)
        const totalComTurma = totalComTurmaRes.count || 0;
        const totalComJoin = totalComJoinRes.count || 0;
        const orfaosCount = Math.max(0, totalComTurma - totalComJoin);
        alunosOrfaosCountEl.textContent = orfaosCount;
        const alunosComTurma = alunosComTurmaListRes.data || [];
        const orfaos = alunosComTurma.filter(a => !a.turmas);
        alunosOrfaosTable.innerHTML = orfaos.length
            ? orfaos.slice(0, 50).map(a => `
                <tr>
                    <td class="p-3">${a.nome_completo}</td>
                    <td class="p-3">${a.matricula || '-'}</td>
                    <td class="p-3">${a.turma_id}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="3" class="p-4 text-center">Nenhum encontrado.</td></tr>';
    } catch (err) {
        console.error('Erro ao carregar consistencia:', err);
        alunosSemTurmaCountEl.textContent = 'Erro';
        profSemTurmaCountEl.textContent = 'Erro';
        turmasDuplicadasCountEl.textContent = 'Erro';
        alunosOrfaosCountEl.textContent = 'Erro';
        alunosSemTurmaTable.innerHTML = '<tr><td colspan="2" class="p-4 text-center text-red-500">Erro ao carregar.</td></tr>';
        profSemTurmaTable.innerHTML = '<tr><td colspan="2" class="p-4 text-center text-red-500">Erro ao carregar.</td></tr>';
        turmasDuplicadasTable.innerHTML = '<tr><td colspan="3" class="p-4 text-center text-red-500">Erro ao carregar.</td></tr>';
        alunosOrfaosTable.innerHTML = '<tr><td colspan="3" class="p-4 text-center text-red-500">Erro ao carregar.</td></tr>';
    }
}

// ===============================================================
// ADMIN - CALENDARIO
// ===============================================================

function normalizeTurmasIds(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value.map(v => parseInt(v, 10)).filter(Number.isFinite);
    }
    if (typeof value === 'string') {
        const cleaned = value.replace(/[{}]/g, '');
        if (!cleaned) return [];
        return cleaned
            .split(',')
            .map(v => parseInt(v.trim(), 10))
            .filter(Number.isFinite);
    }
    return [];
}

function resolveTurmasNomes(ids) {
    if (!ids || ids.length === 0) return '';
    const nomes = ids.map(id => {
        const turma = state.turmasCache.find(t => t.id === id);
        return turma ? turma.nome_turma : `ID ${id}`;
    });
    return nomes.join(', ');
}

function applyEventoAbrangenciaUI(value) {
    const turmasContainer = document.getElementById('evento-turmas-container');
    if (!turmasContainer) return;
    turmasContainer.classList.toggle('hidden', value !== 'turmas');
}

export async function renderCalendarioPanel() {
    const eventosTableBody = document.getElementById('eventos-table-body');
    const dataInicioFilter = document.getElementById('evento-data-inicio-filter')?.value;
    const dataFimFilter = document.getElementById('evento-data-fim-filter')?.value;
    eventosTableBody.innerHTML = '<tr><td colspan="3" class="p-4 text-center">Carregando...</td></tr>';
    let queryBuilder = db.from('eventos').select('*').order('data', { ascending: false });
    if (dataInicioFilter && !dataFimFilter) {
        queryBuilder = queryBuilder.gte('data', dataInicioFilter).lte('data', dataInicioFilter);
    } else {
        if (dataInicioFilter) queryBuilder = queryBuilder.gte('data', dataInicioFilter);
        if (dataFimFilter) queryBuilder = queryBuilder.lte('data', dataFimFilter);
    }
    const { data, error } = await safeQuery(queryBuilder);
    if (error) {
        eventosTableBody.innerHTML = '<tr><td colspan="3" class="p-4 text-center text-red-500">Erro ao carregar.</td></tr>';
        return;
    }
    if (!data || data.length === 0) {
        eventosTableBody.innerHTML = '<tr><td colspan="3" class="p-4 text-center">Nenhum evento encontrado.</td></tr>';
        return;
    }
    eventosTableBody.innerHTML = data.map(evento => {
        const dataInicio = new Date(evento.data + 'T00:00:00').toLocaleDateString();
        const dataFim = evento.data_fim ? new Date(evento.data_fim + 'T00:00:00').toLocaleDateString() : dataInicio;
        const periodo = dataInicio === dataFim ? dataInicio : `${dataInicio} - ${dataFim}`;
        const turmasIds = normalizeTurmasIds(evento.turmas_ids);
        const turmasNomes = resolveTurmasNomes(turmasIds);
        const turmaInfo = turmasNomes ? `<div class="text-xs text-gray-500 mt-1">Turmas: ${turmasNomes}</div>` : '';
        return `
        <tr class="border-b">
            <td class="p-3">${periodo}</td>
            <td class="p-3">${evento.descricao}${turmaInfo}</td>
            <td class="p-3"><button class="text-blue-600 hover:underline edit-evento-btn" data-id="${evento.id}">Editar</button></td>
        </tr>
        `;
    }).join('');
}

export async function openEventoModal(editId = null) {
    const eventoForm = document.getElementById('evento-form');
    const eventoModal = document.getElementById('evento-modal');
    const turmasSelect = document.getElementById('evento-turmas-ids');
    const abrangenciaContainer = document.getElementById('evento-abrangencia-container');
    const abrangenciaRadios = document.querySelectorAll('input[name="evento-abrangencia"]');
    eventoForm.reset();
    document.getElementById('evento-delete-container').classList.add('hidden');
    if (turmasSelect) {
        turmasSelect.innerHTML = '';
        state.turmasCache.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.nome_turma;
            turmasSelect.appendChild(opt);
        });
    }
    if (abrangenciaContainer && !abrangenciaContainer.dataset.bound) {
        abrangenciaRadios.forEach(radio => {
            radio.addEventListener('change', (e) => {
                applyEventoAbrangenciaUI(e.target.value);
            });
        });
        abrangenciaContainer.dataset.bound = 'true';
    }
    if (editId) {
        const { data } = await safeQuery(db.from('eventos').select('*').eq('id', editId).single());
        if (!data) { showToast('Evento não encontrado.', true); return; }
        document.getElementById('evento-modal-title').textContent = 'Editar Evento';
        document.getElementById('evento-id').value = data.id;
        document.getElementById('evento-descricao').value = data.descricao;
        document.getElementById('evento-data-inicio').value = data.data;
        document.getElementById('evento-data-fim').value = data.data_fim;
        const turmasIds = normalizeTurmasIds(data.turmas_ids);
        const abrangencia = turmasIds.length > 0 || data.abrangencia === 'turmas' ? 'turmas' : 'global';
        abrangenciaRadios.forEach(radio => {
            radio.checked = radio.value === abrangencia;
        });
        if (turmasSelect && turmasIds.length > 0) {
            Array.from(turmasSelect.options).forEach(opt => {
                opt.selected = turmasIds.includes(parseInt(opt.value, 10));
            });
        }
        applyEventoAbrangenciaUI(abrangencia);
        document.getElementById('evento-delete-container').classList.remove('hidden');
    } else {
        document.getElementById('evento-modal-title').textContent = 'Adicionar Evento';
        document.getElementById('evento-id').value = '';
        abrangenciaRadios.forEach(radio => {
            radio.checked = radio.value === 'global';
        });
        if (turmasSelect) {
            Array.from(turmasSelect.options).forEach(opt => { opt.selected = false; });
        }
        applyEventoAbrangenciaUI('global');
    }
    eventoModal.classList.remove('hidden');
}

export async function handleEventoFormSubmit(e) {
    const id = document.getElementById('evento-id').value;
    const abrangencia = document.querySelector('input[name="evento-abrangencia"]:checked')?.value || 'global';
    const turmasSelect = document.getElementById('evento-turmas-ids');
    const turmasIds = turmasSelect
        ? Array.from(turmasSelect.selectedOptions).map(opt => parseInt(opt.value, 10)).filter(Number.isFinite)
        : [];
    if (abrangencia === 'turmas' && turmasIds.length === 0) {
        showToast('Selecione ao menos uma turma para a exceção.', true);
        return;
    }
    const eventoData = {
        descricao: document.getElementById('evento-descricao').value,
        data: document.getElementById('evento-data-inicio').value,
        data_fim: document.getElementById('evento-data-fim').value || null,
        abrangencia: abrangencia,
        turmas_ids: abrangencia === 'turmas' ? turmasIds : null
    };
    const queryBuilder = id
        ? db.from('eventos').update(eventoData).eq('id', id)
        : db.from('eventos').insert(eventoData).select().single();
    const { data, error } = await safeQuery(queryBuilder);
    if (error) {
        showToast('Erro ao salvar evento: ' + error.message, true);
    } else {
        await logAudit(id ? 'update' : 'create', 'evento', id || data?.id || null, { eventoData });
        showToast('Evento salvo com sucesso!');
        closeAllModals();
        await renderCalendarioPanel();
        await renderDashboardCalendar();
    }
}

// ===============================================================
// ADMIN - ANO LETIVO / PROMOCAO
// ===============================================================

export function renderAnoLetivoPanel() {
    const listEl = document.getElementById('ano-letivo-list');
    listEl.innerHTML = '';
    state.anosLetivosCache.forEach(ano => listEl.innerHTML += `<li class="p-2 border rounded-md">${ano}</li>`);
}

export async function openPromoverTurmasModal() {
    const promoverTurmasModal = document.getElementById('promover-turmas-modal');
    const anoOrigemSel = document.getElementById('promover-turmas-ano-origem');
    const listaContainer = document.getElementById('promover-turmas-lista-container');
    const listaEl = document.getElementById('promover-turmas-lista');
    const promoverEfetivosCheckbox = document.getElementById('promover-professores-efetivos-checkbox');

    listaContainer.classList.add('hidden');
    listaEl.innerHTML = '';
    document.getElementById('promover-turmas-btn').disabled = true;
    if (promoverEfetivosCheckbox) promoverEfetivosCheckbox.checked = false;

    anoOrigemSel.innerHTML = '<option value="">Selecione...</option>';
    state.anosLetivosCache.forEach(ano => {
        anoOrigemSel.innerHTML += `<option value="${ano}">${ano}</option>`;
    });

    if (state.anosLetivosCache.length > 0) {
        const ultimoAno = state.anosLetivosCache[0];
        anoOrigemSel.value = ultimoAno;
        anoOrigemSel.dispatchEvent(new Event('change', { bubbles: true }));
    }

    promoverTurmasModal.classList.remove('hidden');
}

export async function renderPromocaoTurmasLista() {
    const anoOrigem = document.getElementById('promover-turmas-ano-origem').value;
    const anoDestinoEl = document.getElementById('promover-turmas-ano-destino');
    const container = document.getElementById('promover-turmas-lista-container');
    const listEl = document.getElementById('promover-turmas-lista');
    const promoverBtn = document.getElementById('promover-turmas-btn');

    listEl.innerHTML = '';
    promoverBtn.disabled = true;

    if (!anoOrigem) {
        container.classList.add('hidden');
        anoDestinoEl.value = '';
        return;
    }

    anoDestinoEl.value = parseInt(anoOrigem) + 1;
    listEl.innerHTML = '<div class="loader mx-auto my-4"></div>';
    container.classList.remove('hidden');

    const { data: turmas } = await safeQuery(
        db.from('turmas').select('id, nome_turma').eq('ano_letivo', anoOrigem)
    );

    if (!turmas || turmas.length === 0) {
        listEl.innerHTML = `<p class="p-4 text-center text-gray-600">Nenhuma turma encontrada para o ano de origem.</p>`;
        return;
    }

    listEl.innerHTML = turmas
        .sort((a, b) => a.nome_turma.localeCompare(b.nome_turma, undefined, { numeric: true }))
        .map(turma => `
        <label class="flex items-center p-2 bg-white rounded-md border hover:bg-gray-50">
            <input type="checkbox" class="form-checkbox h-5 w-5 promocao-turma-checkbox" value="${turma.id}" checked>
            <span class="ml-3 text-sm">${turma.nome_turma}</span>
        </label>
    `).join('');

    promoverBtn.disabled = false;
}

export async function handlePromoverTurmas() {
    const turmasSelecionadasIds = Array.from(document.querySelectorAll('#promover-turmas-lista input:checked')).map(cb => cb.value);
    const promoverTurmasConfirmModal = document.getElementById('promover-turmas-confirm-modal');
    if (turmasSelecionadasIds.length === 0) {
        showToast('Nenhuma turma foi selecionada para a promoção.', true);
        return;
    }

    document.getElementById('promover-turmas-confirm-message').textContent =
        `Voce esta prestes a promover todos os alunos de ${turmasSelecionadasIds.length} turma(s).`;
    document.getElementById('confirm-promocao-turmas-btn').dataset.turmas = JSON.stringify(turmasSelecionadasIds);
    document.getElementById('promover-turmas-confirm-checkbox').checked = false;
    document.getElementById('confirm-promocao-turmas-btn').disabled = true;
    promoverTurmasConfirmModal.classList.remove('hidden');
}

export async function handleConfirmPromocaoTurmas() {
    const btn = document.getElementById('confirm-promocao-turmas-btn');
    const turmaIds = JSON.parse(btn.dataset.turmas);
    const anoDestino = document.getElementById('promover-turmas-ano-destino').value;
    const promoverEfetivos = document.getElementById('promover-professores-efetivos-checkbox')?.checked;

    btn.innerHTML = '<div class="loader mx-auto"></div>';
    btn.disabled = true;

    const rpcParams = {
        origem_turma_ids: turmaIds,
        ano_destino: parseInt(anoDestino)
    };
    if (promoverEfetivos) rpcParams.promover_professores_efetivos = true;

    const { error } = await db.rpc('promover_turmas_em_massa', rpcParams);

    if (error) {
        const extra = promoverEfetivos ? ' Verifique se o script de atualização do banco foi aplicado.' : '';
        showToast('Erro ao executar a promoção em massa: ' + error.message + extra, true);
        console.error(error);
    } else {
        const { error: actError } = await safeQuery(
            db.from('usuarios')
                .update({ status: 'inativo' })
                .eq('papel', 'professor')
                .eq('vinculo', 'act')
                .eq('status', 'ativo')
        );
        if (actError) {
            showToast('Turmas promovidas, mas houve erro ao inativar professores ACT: ' + actError.message, true);
        }
        await logAudit('promote', 'turmas', null, {
            turmaIds,
            ano_destino: parseInt(anoDestino),
            promover_professores_efetivos: !!promoverEfetivos,
            act_inativados: !actError
        });
        showToast('Turmas promovidas com sucesso!');
        closeAllModals();
        await loadAdminData();
        await renderAlunosPanel({ defaultToLatestYear: true });
    }
    btn.innerHTML = 'Executar Promoção';
}

// ===============================================================
// ADMIN - EXCLUSAO / CONFIRMACAO
// ===============================================================

export function openDeleteConfirmModal(type, id) {
    const modal = document.getElementById('delete-confirm-modal');
    const msg = document.getElementById('delete-confirm-message');
    const checkbox = document.getElementById('delete-confirm-checkbox');
    const confirmBtn = document.getElementById('confirm-delete-btn');
    msg.textContent = `Tem certeza que deseja excluir este ${type}?`;
    checkbox.checked = false;
    confirmBtn.disabled = true;
    confirmBtn.dataset.type = type;
    confirmBtn.dataset.id = id;
    modal.classList.remove('hidden');
}

export async function handleConfirmDelete() {
    const confirmBtn = document.getElementById('confirm-delete-btn');
    const type = confirmBtn.dataset.type;
    const id = confirmBtn.dataset.id;

    if (!type || !id) return;

    try {
        if (type === 'aluno') {
            const { error: delError } = await db.from('alunos').delete().eq('id', id);
            if (delError) await db.from('alunos').update({ status: 'inativo' }).eq('id', id);
        } else if (type === 'turma') {
            await safeQuery(db.from('professores_turmas').delete().eq('turma_id', id));
            await db.from('alunos').update({ turma_id: null }).eq('turma_id', id);
            await safeQuery(db.from('turmas').delete().eq('id', id));
        } else if (type === 'professor') {
            const { data: prof } = await db.from('usuarios').select('user_uid').eq('id', id).single();
            if (prof) await safeQuery(db.from('professores_turmas').delete().eq('professor_id', prof.user_uid));
            await safeQuery(db.from('usuarios').delete().eq('id', id));
        } else if (type === 'evento') {
            await safeQuery(db.from('eventos').delete().eq('id', id));
        } else if (type === 'acompanhamento') {
            await safeQuery(db.from('apoia_encaminhamentos').delete().eq('id', id));
        }
        await logAudit('delete', type, id, null);
        closeAllModals();
        if (type === 'aluno') await renderAlunosPanel();
        if (type === 'professor') await renderProfessoresPanel();
        if (type === 'turma') await renderTurmasPanel();
        if (type === 'evento') { await renderCalendarioPanel(); await renderDashboardCalendar(); }
        if (type === 'acompanhamento') await renderApoiaPanel(apoiaCurrentPage);
    } catch (err) {
        showToast('Erro ao excluir: ' + err.message, true);
    }
}

// ===============================================================
// IMPRESSAO / HISTORICO
// ===============================================================

async function getSchoolInfo() {
    try {
        const { data } = await safeQuery(db.from('configuracoes').select('*').limit(1).maybeSingle());
        return data || {};
    } catch (err) {
        console.warn('Falha ao carregar dados da escola para impressao:', err?.message || err);
        return {};
    }
}

function buildSchoolInfoLine(info) {
    const nome = info.nome_escola || info.escola_nome || info.nome || 'EEB Getulio Vargas';
    const endereco = info.endereco_escola || info.endereco || '';
    const telefone = info.telefone_escola || info.telefone || '';
    const email = info.email_escola || info.email || '';
    const parts = [endereco, telefone, email].filter(Boolean);
    return parts.length > 0 ? `${nome} • ${parts.join(' • ')}` : nome;
}

function injectSchoolInfoIntoPrintHeader(targetWindow, infoLine) {
    if (!targetWindow || targetWindow.closed || !infoLine) return;
    const headerInfo = targetWindow.document.querySelector('.print-header-info');
    if (headerInfo) {
        const infoEl = targetWindow.document.createElement('p');
        infoEl.className = 'print-school-line text-xs text-gray-500 mt-1';
        infoEl.textContent = infoLine;
        headerInfo.insertBefore(infoEl, headerInfo.firstChild);
        return;
    }
    const fallback = targetWindow.document.createElement('div');
    fallback.className = 'mb-4 text-xs text-gray-500';
    fallback.textContent = infoLine;
    targetWindow.document.body.insertBefore(fallback, targetWindow.document.body.firstChild);
}

export async function handleImprimirRelatorio(reportType) {
    const reportSelectors = {
        faltas: '#relatorio-resultados .printable-area',
        apoia: '#apoia-relatorio-resultados .printable-area',
        historico: '#aluno-historico-modal .printable-area'
    };
    const reportContent = document.querySelector(reportSelectors[reportType])?.innerHTML;
    if (!reportContent) return;
    const schoolInfo = await getSchoolInfo();
    const schoolInfoLine = buildSchoolInfoLine(schoolInfo);
    const baseHref = window.location.href.split('#')[0];
    const html = `
        <html>
        <head>
            <title>Relatorio</title>
            <base href="${baseHref}">
            <script src="https://cdn.tailwindcss.com"><\/script>
            <link rel="stylesheet" href="style.css">
            <style>body { font-family: 'Inter', sans-serif; }</style>
        </head>
        <body class="bg-gray-100 p-8">
            <div class="printable-area">${reportContent}</div>
        </body>
        </html>
    `;
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    const newWindow = window.open(dataUrl, '_blank');
    if (!newWindow) return;
    newWindow.focus();
    setTimeout(() => {
        injectSchoolInfoIntoPrintHeader(newWindow, schoolInfoLine);
        newWindow.print();
    }, 400);
}

export async function openAlunoHistoricoModal(alunoId) {
    const modal = document.getElementById('aluno-historico-modal');
    const { data: aluno } = await safeQuery(db.from('alunos').select('nome_completo').eq('id', alunoId).single());
    const { data: presencas } = await safeQuery(
        db.from('presencas').select('data, registrado_em, status, justificativa').eq('aluno_id', alunoId).order('data', { ascending: false })
    );

    document.getElementById('historico-aluno-nome-impressao').textContent = aluno?.nome_completo || '';
    const tableBody = document.getElementById('aluno-historico-table-body');
    tableBody.innerHTML = '<tr><td colspan="4" class="p-4 text-center">Carregando historico...</td></tr>';

    if (!presencas || presencas.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="4" class="p-4 text-center">Nenhum registro de frequencia encontrado.</td></tr>';
        return;
    }

    let totalPresencas = 0;
    let totalFaltas = 0;

    const formatHora = (value) => value ? new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '-';
    tableBody.innerHTML = presencas.map(p => {
        if (p.status === 'presente') totalPresencas++;
        if (p.status === 'falta') totalFaltas++;
        return `
            <tr>
                <td class="p-2">${p.data}</td>
                <td class="p-2">${formatHora(p.registrado_em)}</td>
                <td class="p-2">${p.status}</td>
                <td class="p-2">${p.justificativa || '-'}</td>
            </tr>
        `;
    }).join('');

    document.getElementById('historico-presencas').textContent = totalPresencas;
    document.getElementById('historico-faltas').textContent = totalFaltas;
    const assiduidade = totalPresencas + totalFaltas > 0 ? Math.round((totalPresencas / (totalPresencas + totalFaltas)) * 100) : 0;
    document.getElementById('historico-assiduidade').textContent = assiduidade + '%';

    modal.classList.remove('hidden');
}

// ===============================================================
// ASSIDUIDADE
// ===============================================================

export function openAssiduidadeModal() {
    const assiduidadeModal = document.getElementById('assiduidade-modal');
    const anoSelAluno = document.getElementById('assiduidade-aluno-ano');
    const anoSelTurma = document.getElementById('assiduidade-turma-ano');
    const anoSelProf = document.getElementById('assiduidade-prof-ano');
    const defaultAno = state.anosLetivosCache.length > 0 ? String(state.anosLetivosCache[0]) : '';

    if (anoSelAluno) {
        anoSelAluno.innerHTML = '<option value="">Todos os Anos</option>';
        state.anosLetivosCache.forEach(ano => anoSelAluno.innerHTML += `<option value="${ano}">${ano}</option>`);
    }
    if (anoSelTurma) {
        anoSelTurma.innerHTML = '<option value="">Todos os Anos</option>';
        state.anosLetivosCache.forEach(ano => anoSelTurma.innerHTML += `<option value="${ano}">${ano}</option>`);
    }
    if (anoSelProf) {
        anoSelProf.innerHTML = '<option value="">Todos os Anos</option>';
        state.anosLetivosCache.forEach(ano => anoSelProf.innerHTML += `<option value="${ano}">${ano}</option>`);
    }
    if (defaultAno) {
        if (anoSelAluno) {
            anoSelAluno.value = defaultAno;
            anoSelAluno.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (anoSelTurma) {
            anoSelTurma.value = defaultAno;
            anoSelTurma.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (anoSelProf) {
            anoSelProf.value = defaultAno;
            anoSelProf.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    assiduidadeModal.classList.remove('hidden');
}

export async function generateAssiduidadeReport() {
    const baseHref = window.location.href.split('#')[0];
    const newWindow = window.open(baseHref, '_blank');
    newWindow.document.write(`<html><head><title>Relatorio de Assiduidade</title><script src="https://cdn.tailwindcss.com"><\/script><script src="https://cdn.jsdelivr.net/npm/chart.js"><\/script><style>body { font-family: 'Inter', sans-serif; } .print-header { display: none; } @media print { .no-print { display: none !important; } .printable-area { position: absolute; left: 0; top: 0; width: 100%; } body * { visibility: hidden; } .printable-area, .printable-area * { visibility: visible; } .print-header { display: flex !important; justify-content: flex-start; gap: 16px; align-items: center; padding-bottom: 1rem; margin-bottom: 1.5rem; border-bottom: 2px solid #e5e7eb; } .print-header img { max-height: 60px; width: auto; } .print-header-info { text-align: left; } .print-header-info h2 { font-size: 1.25rem; font-weight: bold; margin: 0; } .print-header-info p { font-size: 0.875rem; margin: 0; } .print-header-info .print-school-line { font-size: 0.75rem; color: #6b7280; margin-bottom: 0.25rem; } body[data-print-mode="simple"] .print-full-only { display: none !important; } body[data-print-mode="full"] .print-simple-only { display: none !important; } } body[data-print-preview="true"] .print-only { display: block; }</style></head><body class="bg-gray-100 p-8" data-print-mode="full"><div class="printable-area"><div id="report-content"><div class="text-center"><div class="loader" style="width: 48px; height: 48px; margin: auto;"></div><p class="mt-4 text-gray-600">Gerando relatorio, por favor aguarde...</p></div></div></div></body></html>`);

    try {
        const formatDateBr = (value) => {
            if (!value) return '...';
            const [year, month, day] = value.split('-');
            if (!year || !month || !day) return value;
            return `${day}/${month}/${year}`;
        };
        const buildPeriodoTexto = (inicio, fim, fallback) => {
            if (inicio || fim) return `Periodo: ${formatDateBr(inicio)} ate ${formatDateBr(fim)}`;
            return fallback;
        };
        const today = getLocalDateString();
        const schoolInfo = await getSchoolInfo();
        const schoolInfoLine = buildSchoolInfoLine(schoolInfo);
        const activeTab = document.querySelector('#assiduidade-tabs a[aria-current="page"]').dataset.target;
        const renderReport = (reportHTML, chartScriptContent = '') => {
            if (!newWindow || newWindow.closed) return;
            newWindow.document.getElementById('report-content').innerHTML = reportHTML;
            const scriptEl = newWindow.document.createElement('script');
            scriptEl.textContent = `
                window.setPrintMode = (mode) => { document.body.dataset.printMode = mode; };
                window.preparePrint = (mode) => {
                    document.body.dataset.printMode = mode || 'full';
                    document.body.dataset.printPreview = 'true';
                    setTimeout(() => {
                        if (window.renderPrintCharts) window.renderPrintCharts();
                        setTimeout(() => { window.print(); }, 300);
                    }, 50);
                };
                window.addEventListener('afterprint', () => {
                    document.body.removeAttribute('data-print-preview');
                });
                if (!document.body.dataset.printMode) { document.body.dataset.printMode = 'full'; }
                ${chartScriptContent || ''}
            `;
            newWindow.document.body.appendChild(scriptEl);
            injectSchoolInfoIntoPrintHeader(newWindow, schoolInfoLine);
        };

        if (activeTab === 'assiduidade-alunos') {
            const dataInicio = document.getElementById('assiduidade-aluno-data-inicio').value;
            const dataFim = document.getElementById('assiduidade-aluno-data-fim').value;
            const ano = document.getElementById('assiduidade-aluno-ano').value;
            const alunoId = document.getElementById('assiduidade-aluno-aluno').value;
            const periodoTexto = buildPeriodoTexto(dataInicio, dataFim, 'Periodo: Todos os registros');

            let query = db.from('presencas').select('status, justificativa, alunos!inner(nome_completo), turmas!inner(nome_turma, ano_letivo)');
            if (dataInicio) query = query.gte('data', dataInicio);
            if (dataFim) query = query.lte('data', dataFim);
            if (ano) query = query.eq('turmas.ano_letivo', ano);
            if (alunoId) query = query.eq('aluno_id', alunoId);
            const { data, error } = await safeQuery(query);
            if (error) throw error;

            const agrupado = {};
            (data || []).forEach(item => {
                const key = `${item.alunos.nome_completo}__${item.turmas.nome_turma}`;
                if (!agrupado[key]) {
                    agrupado[key] = { aluno: item.alunos.nome_completo, turma: item.turmas.nome_turma, presencas: 0, faltasJ: 0, faltasI: 0 };
                }
                if (item.status === 'presente') agrupado[key].presencas++;
                if (item.status === 'falta' && item.justificativa === 'Falta justificada') agrupado[key].faltasJ++;
                if (item.status === 'falta' && item.justificativa !== 'Falta justificada') agrupado[key].faltasI++;
            });

            const rows = Object.values(agrupado);
            const totalPresencas = rows.reduce((s, r) => s + r.presencas, 0);
            const totalFaltasJ = rows.reduce((s, r) => s + r.faltasJ, 0);
            const totalFaltasI = rows.reduce((s, r) => s + r.faltasI, 0);

            const tableRows = rows.map(r => {
                const total = r.presencas + r.faltasJ + r.faltasI;
                const assiduidade = total ? Math.round((r.presencas / total) * 100) : 0;
                return `
                    <tr>
                        <td class="p-3">${r.aluno}</td>
                        <td class="p-3">${r.turma}</td>
                        <td class="p-3 text-center">${r.presencas}</td>
                        <td class="p-3 text-center">${r.faltasJ}</td>
                        <td class="p-3 text-center">${r.faltasI}</td>
                        <td class="p-3 text-center">${assiduidade}%</td>
                    </tr>
                `;
            }).join('');

            const reportHTML = `<div class="print-header"><img src="./logo.png"><div class="print-header-info"><h2>Relatorio de Assiduidade de Alunos</h2><p>${periodoTexto}</p></div></div><div class="flex justify-between items-center mb-6 no-print"><h1 class="text-2xl font-bold">Relatorio de Assiduidade de Alunos</h1><p class="text-sm text-gray-600">${periodoTexto}</p><div class="flex gap-2"><button onclick="preparePrint('simple')" class="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700">Imprimir simples</button><button onclick="preparePrint('full')" class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">Imprimir completa</button></div></div><div class="grid grid-cols-1 lg:grid-cols-3 gap-6"><div class="lg:col-span-1 bg-white p-4 rounded-lg shadow-md print-full-only"><div style="height: 320px; position: relative;"><canvas id="assiduidadeChart"></canvas></div></div><div class="lg:col-span-2 bg-white p-6 rounded-lg shadow-md"><h3 class="font-bold mb-4">Detalhes da Frequencia</h3><div class="max-h-96 overflow-y-auto"><table class="w-full text-sm"><thead class="bg-gray-50 sticky top-0"><tr><th class="p-3 text-left">Aluno</th><th class="p-3 text-left">Turma</th><th class="p-3 text-center">Presencas</th><th class="p-3 text-center">Faltas Just.</th><th class="p-3 text-center">Faltas Injust.</th><th class="p-3 text-center">Assiduidade</th></tr></thead><tbody>${tableRows}</tbody></table></div></div></div>`;
            const chartScriptContent = `setTimeout(() => { const ctx = document.getElementById('assiduidadeChart'); if (ctx) { new Chart(ctx, { type: 'pie', data: { labels: ['Presencas', 'Faltas Justificadas', 'Faltas Injustificadas'], datasets: [{ data: [${totalPresencas}, ${totalFaltasJ}, ${totalFaltasI}], backgroundColor: ['#10B981', '#F59E0B', '#EF4444'] }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top' }, title: { display: true, text: 'Visao Geral da Frequencia' } } } }); } }, 100);`;
            renderReport(reportHTML, chartScriptContent);
        } else if (activeTab === 'assiduidade-turmas') {
            const dataInicio = document.getElementById('assiduidade-turma-data-inicio').value;
            const dataFim = document.getElementById('assiduidade-turma-data-fim').value;
            const ano = document.getElementById('assiduidade-turma-ano').value;
            const turmaId = document.getElementById('assiduidade-turma-turma').value;
            const periodoTexto = buildPeriodoTexto(dataInicio, dataFim, 'Periodo: Todos os registros');

            let query = db.from('presencas').select('status, justificativa, turmas!inner(id, nome_turma, ano_letivo)');
            if (dataInicio) query = query.gte('data', dataInicio);
            if (dataFim) query = query.lte('data', dataFim);
            if (ano) query = query.eq('turmas.ano_letivo', ano);
            if (turmaId) query = query.eq('turma_id', turmaId);
            const { data, error } = await safeQuery(query);
            if (error) throw error;

            const agrupado = {};
            (data || []).forEach(item => {
                const key = `${item.turmas.nome_turma}`;
                if (!agrupado[key]) {
                    agrupado[key] = { turma: item.turmas.nome_turma, presencas: 0, faltas: 0 };
                }
                if (item.status === 'presente') agrupado[key].presencas++;
                if (item.status === 'falta') agrupado[key].faltas++;
            });

            const rows = Object.values(agrupado);
            const totalPresencas = rows.reduce((s, r) => s + r.presencas, 0);
            const totalFaltas = rows.reduce((s, r) => s + r.faltas, 0);

            const tableRows = rows.map(r => {
                const total = r.presencas + r.faltas;
                const assiduidade = total ? Math.round((r.presencas / total) * 100) : 0;
                return `
                    <tr>
                        <td class="p-3">${r.turma}</td>
                        <td class="p-3 text-center">${r.presencas}</td>
                        <td class="p-3 text-center">${r.faltas}</td>
                        <td class="p-3 text-center">${assiduidade}%</td>
                    </tr>
                `;
            }).join('');

            const reportHTML = `<div class="print-header"><img src="./logo.png"><div class="print-header-info"><h2>Relatorio de Assiduidade por Turma</h2><p>${periodoTexto}</p></div></div><div class="flex justify-between items-center mb-6 no-print"><h1 class="text-2xl font-bold">Relatorio de Assiduidade por Turma</h1><p class="text-sm text-gray-600">${periodoTexto}</p><div class="flex gap-2"><button onclick="preparePrint('simple')" class="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700">Imprimir simples</button><button onclick="preparePrint('full')" class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">Imprimir completa</button></div></div><div class="grid grid-cols-1 lg:grid-cols-3 gap-6"><div class="lg:col-span-1 bg-white p-4 rounded-lg shadow-md print-full-only"><div style="height: 320px; position: relative;"><canvas id="assiduidadeTurmaChart"></canvas></div></div><div class="lg:col-span-2 bg-white p-6 rounded-lg shadow-md"><h3 class="font-bold mb-4">Dados Consolidados</h3><div class="max-h-96 overflow-y-auto"><table class="w-full text-sm"><thead class="bg-gray-50 sticky top-0"><tr><th class="p-3 text-left">Turma</th><th class="p-3 text-center">Presencas</th><th class="p-3 text-center">Faltas</th><th class="p-3 text-center">Assiduidade</th></tr></thead><tbody>${tableRows}</tbody></table></div></div></div>`;
            const chartScriptContent = `setTimeout(() => { const ctx = document.getElementById('assiduidadeTurmaChart'); if(ctx) { new Chart(ctx, { type: 'pie', data: { labels: ['Total de Presencas', 'Total de Faltas'], datasets: [{ label: 'Frequencia Geral', data: [${totalPresencas}, ${totalFaltas}], backgroundColor: ['#10B981', '#EF4444'] }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top' }, title: { display: true, text: 'Frequencia Geral das Turmas' } } } }); } }, 100);`;
            renderReport(reportHTML, chartScriptContent);
        } else if (activeTab === 'assiduidade-professores') {
            const dataInicio = document.getElementById('assiduidade-prof-data-inicio').value;
            const dataFim = document.getElementById('assiduidade-prof-data-fim').value;
            const ano = document.getElementById('assiduidade-prof-ano').value;
            const professorId = document.getElementById('assiduidade-prof-professor').value;
            const baseYear = ano || today.split('-')[0];
            let rangeStart = dataInicio || `${baseYear}-01-01`;
            let rangeEnd = dataFim || `${baseYear}-12-31`;
            if (rangeEnd > today) rangeEnd = today;
            if (rangeStart > rangeEnd) rangeStart = rangeEnd;
            const periodoTexto = `Periodo: ${formatDateBr(rangeStart)} ate ${formatDateBr(rangeEnd)}`;

            const normalizeTurmasIds = (value) => {
                if (!value) return [];
                if (Array.isArray(value)) {
                    return value.map(v => parseInt(v, 10)).filter(Number.isFinite);
                }
                if (typeof value === 'string') {
                    const cleaned = value.replace(/[{}]/g, '');
                    if (!cleaned) return [];
                    return cleaned
                        .split(',')
                        .map(v => parseInt(v.trim(), 10))
                        .filter(Number.isFinite);
                }
                return [];
            };
            const eventAppliesToTurma = (evento, turmaId) => {
                const ids = normalizeTurmasIds(evento.turmas_ids);
                const isSpecific = (evento.abrangencia && evento.abrangencia !== 'global') || ids.length > 0;
                if (!isSpecific) return true;
                if (!turmaId) return false;
                return ids.includes(parseInt(turmaId, 10));
            };
            const isDateBlocked = (dateStr, turmaId, eventosList) => {
                return (eventosList || []).some(e => {
                    const inicio = e.data;
                    const fim = e.data_fim || e.data;
                    return dateStr >= inicio && dateStr <= fim && eventAppliesToTurma(e, turmaId);
                });
            };

            let profQuery = db.from('usuarios').select('user_uid, nome').eq('papel', 'professor').eq('status', 'ativo');
            if (professorId) profQuery = profQuery.eq('user_uid', professorId);
            const { data: profs, error: profError } = await safeQuery(profQuery);
            if (profError) throw profError;

            const profIds = (profs || []).map(p => p.user_uid);
            const { data: rels, error: relError } = await safeQuery(
                db.from('professores_turmas').select('professor_id, turma_id').in('professor_id', profIds)
            );
            if (relError) throw relError;

            const turmaIds = Array.from(new Set((rels || []).map(r => r.turma_id)));
            let turmaMap = new Map();
            if (turmaIds.length > 0) {
                const { data: turmasData, error: turmasError } = await safeQuery(
                    db.from('turmas').select('id, nome_turma').in('id', turmaIds)
                );
                if (turmasError) throw turmasError;
                turmaMap = new Map((turmasData || []).map(t => [t.id, t.nome_turma || String(t.id)]));
            }
            const { data: eventos, error: eventosError } = await safeQuery(
                db.from('eventos')
                    .select('data, data_fim, abrangencia, turmas_ids')
                    .or(`data.gte.${rangeStart},data_fim.gte.${rangeStart}`)
                    .or(`data.lte.${rangeEnd},data_fim.lte.${rangeEnd}`)
            );
            if (eventosError) throw eventosError;

            let presencasQuery = db.from('presencas')
                .select('data, turma_id, registrado_por_uid')
                .gte('data', rangeStart)
                .lte('data', rangeEnd);
            if (profIds.length > 0) presencasQuery = presencasQuery.in('registrado_por_uid', profIds);
            if (turmaIds.length > 0) presencasQuery = presencasQuery.in('turma_id', turmaIds);
            const { data: presencas, error: presencasError } = await safeQuery(presencasQuery);
            if (presencasError) throw presencasError;

            const presencaKeys = new Set((presencas || []).map(p => `${p.registrado_por_uid}|${p.turma_id}|${p.data}`));
            const relsByProfessor = new Map();
            (rels || []).forEach(r => {
                if (!relsByProfessor.has(r.professor_id)) relsByProfessor.set(r.professor_id, []);
                relsByProfessor.get(r.professor_id).push(r.turma_id);
            });

            const dates = [];
            for (let d = new Date(rangeStart + 'T00:00:00'); d <= new Date(rangeEnd + 'T00:00:00'); d.setDate(d.getDate() + 1)) {
                const day = d.getDay();
                if (day === 0 || day === 6) continue;
                dates.push(d.toISOString().split('T')[0]);
            }

            const rows = (profs || []).map(p => {
                const turmas = relsByProfessor.get(p.user_uid) || [];
                let lancadas = 0;
                let naoLancadas = 0;
                const detalhes = [];
                turmas.forEach(turmaId => {
                    dates.forEach(dateStr => {
                        if (isDateBlocked(dateStr, turmaId, eventos || [])) return;
                        const key = `${p.user_uid}|${turmaId}|${dateStr}`;
                        const done = presencaKeys.has(key);
                        if (done) lancadas++;
                        else naoLancadas++;
                        detalhes.push({
                            turmaId,
                            dateStr,
                            done
                        });
                    });
                });
                const total = lancadas + naoLancadas;
                const assiduidade = total ? Math.round((lancadas / total) * 100) : 0;
                const baseName = p.nome || 'Professor';
                const professorLabel = turmas.length === 0 ? `${baseName} - não vinculado` : baseName;
                return { professor: professorLabel, lancadas, naoLancadas, assiduidade, detalhes };
            });

            const totalLancadas = rows.reduce((s, r) => s + r.lancadas, 0);
            const totalNaoLancadas = rows.reduce((s, r) => s + r.naoLancadas, 0);

            const formatShortDate = (value) => {
                if (!value) return '';
                const [year, month, day] = value.split('-');
                if (!year || !month || !day) return value;
                return `${day}/${month}`;
            };
            const renderDetailRectList = (details, done) => {
                if (!details || details.length === 0) return '';
                const borderClass = done ? 'border-green-300' : 'border-red-300';
                const bgClass = done ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800';
                const items = details.map(d => {
                    const turmaNome = turmaMap.get(d.turmaId) || String(d.turmaId);
                    return `${turmaNome} ${formatShortDate(d.dateStr)}`;
                }).join(' / ');
                const title = details.map(d => {
                    const turmaNome = turmaMap.get(d.turmaId) || String(d.turmaId);
                    return `${turmaNome} - ${formatDateBr(d.dateStr)}`;
                }).join(' | ');
                return `
                    <div class="inline-flex items-center border ${borderClass} rounded px-2 py-1 text-[9px] leading-tight ${bgClass}" title="${title}">
                        ${items}
                    </div>
                `;
            };
            const tableRows = rows.map(r => {
                const detailLancadas = renderDetailRectList(r.detalhes.filter(d => d.done), true);
                const detailNaoLancadas = renderDetailRectList(r.detalhes.filter(d => !d.done), false);
                return `
                <tr>
                    <td class="p-3">${r.professor}</td>
                    <td class="p-3 text-center">
                        <div class="font-semibold">${r.lancadas}</div>
                        <div class="mt-2">${detailLancadas || ''}</div>
                    </td>
                    <td class="p-3 text-center">
                        <div class="font-semibold">${r.naoLancadas}</div>
                        <div class="mt-2">${detailNaoLancadas || ''}</div>
                    </td>
                    <td class="p-3 text-center">${r.assiduidade}%</td>
                </tr>
                `;
            }).join('');
            const simpleTableRows = rows.map(r => `
                <tr>
                    <td class="p-3">${r.professor}</td>
                    <td class="p-3 text-center">${r.lancadas}</td>
                    <td class="p-3 text-center">${r.naoLancadas}</td>
                    <td class="p-3 text-center">${r.assiduidade}%</td>
                </tr>
            `).join('');

            const showPageBreak = !professorId;
            const printCards = rows.map((r, idx) => {
                const detailLancadas = renderDetailRectList(r.detalhes.filter(d => d.done), true);
                const detailNaoLancadas = renderDetailRectList(r.detalhes.filter(d => !d.done), false);
                const pageBreakClass = showPageBreak && idx < rows.length - 1 ? 'print-page-break' : '';
                return `
                    <div class="professor-card ${pageBreakClass}">
                        <div class="flex items-center justify-between mb-2">
                            <div class="text-lg font-semibold">${r.professor}</div>
                            <div class="text-sm text-gray-600">Assiduidade: ${r.assiduidade}%</div>
                        </div>
                        <div class="grid grid-cols-3 gap-4 text-sm mb-3">
                            <div>
                                <div><span class="font-semibold">${r.lancadas}</span> lançadas</div>
                                <div class="mt-2">${detailLancadas || ''}</div>
                            </div>
                            <div>
                                <div><span class="font-semibold">${r.naoLancadas}</span> não lançadas</div>
                                <div class="mt-2">${detailNaoLancadas || ''}</div>
                            </div>
                            <div><span class="font-semibold">${r.lancadas + r.naoLancadas}</span> total</div>
                        </div>
                    </div>
                `;
            }).join('');

            const printSummary = `
                <div class="print-only print-full-only print-summary print-page-break">
                    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        <div class="lg:col-span-1 bg-white p-4 rounded-lg shadow-md">
                            <div style="height: 320px; position: relative;"><canvas id="lancamentoChartPrint"></canvas></div>
                        </div>
                        <div class="lg:col-span-2 bg-white p-6 rounded-lg shadow-md">
                            <h3 class="font-bold mb-4">Resumo do Período</h3>
                            <div class="grid grid-cols-2 gap-4 text-sm">
                                <div class="p-4 rounded border bg-gray-50 text-center">
                                    <div class="text-xs text-gray-500">Chamadas lançadas</div>
                                    <div class="text-xl font-bold text-green-700">${totalLancadas}</div>
                                </div>
                                <div class="p-4 rounded border bg-gray-50 text-center">
                                    <div class="text-xs text-gray-500">Chamadas não lançadas</div>
                                    <div class="text-xl font-bold text-red-700">${totalNaoLancadas}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            const printSimpleTable = `
                <div class="print-only print-simple-only bg-white p-6 rounded-lg shadow-md">
                    <h3 class="font-bold mb-4">Dados Consolidados</h3>
                    <div class="overflow-x-auto">
                        <table class="w-full text-sm">
                            <thead class="bg-gray-50">
                                <tr>
                                    <th class="p-3 text-left">Professor</th>
                                    <th class="p-3 text-center">Chamadas lancadas</th>
                                    <th class="p-3 text-center">Chamadas nao lancadas</th>
                                    <th class="p-3 text-center">Assiduidade</th>
                                </tr>
                            </thead>
                            <tbody>${simpleTableRows}</tbody>
                        </table>
                    </div>
                </div>
            `;
            const reportHTML = `
                <style>
                    .print-only { display: none; }
                    .professor-card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; background: #fff; }
                    .print-summary { margin-bottom: 16px; }
                    @media print {
                        .print-only { display: block; }
                        .no-print { display: none !important; }
                        .print-page-break { page-break-after: always; break-after: page; }
                    }
                </style>
                <div class="print-header"><img src="./logo.png"><div class="print-header-info"><h2>Relatorio de Assiduidade por Professor</h2><p>${periodoTexto}</p></div></div>
                <div class="no-print">
                    <div class="flex justify-between items-center mb-6">
                        <h1 class="text-2xl font-bold">Relatorio de Assiduidade por Professor</h1>
                        <p class="text-sm text-gray-600">${periodoTexto}</p>
                        <div class="flex gap-2">
                            <button onclick="preparePrint('simple')" class="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700">Imprimir simples</button>
                            <button onclick="preparePrint('full')" class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">Imprimir completa</button>
                        </div>
                    </div>
                    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        <div class="lg:col-span-1 bg-white p-4 rounded-lg shadow-md">
                            <div style="height: 320px; position: relative;"><canvas id="lancamentoChart"></canvas></div>
                        </div>
                        <div class="lg:col-span-2 bg-white p-6 rounded-lg shadow-md">
                            <h3 class="font-bold mb-4">Dados Consolidados</h3>
                            <div class="max-h-96 overflow-y-auto">
                                <table class="w-full text-sm">
                                    <thead class="bg-gray-50 sticky top-0">
                                        <tr>
                                            <th class="p-3 text-left">Professor</th>
                                            <th class="p-3 text-center">Chamadas lancadas</th>
                                            <th class="p-3 text-center">Chamadas nao lancadas</th>
                                            <th class="p-3 text-center">Assiduidade</th>
                                        </tr>
                                    </thead>
                                    <tbody>${tableRows}</tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
                ${printSimpleTable}
                ${printSummary}
                <div class="print-only print-full-only">${printCards || '<p class="text-sm text-gray-600">Nenhum registro.</p>'}</div>
            `;
            const chartScriptContent = `
                const ensureChart = (fn, tries = 0) => {
                    if (window.Chart) return fn();
                    if (tries > 20) return;
                    setTimeout(() => ensureChart(fn, tries + 1), 100);
                };
                const buildChart = (ctx) => {
                    if (!ctx) return;
                    new Chart(ctx, {
                        type: 'pie',
                        data: {
                            labels: ['Chamadas Lançadas', 'Chamadas Não Lançadas'],
                            datasets: [{ data: [${totalLancadas}, ${totalNaoLancadas}], backgroundColor: ['#10B981', '#EF4444'] }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            plugins: { legend: { position: 'top' }, title: { display: true, text: 'Visão Geral de Lançamentos' } }
                        }
                    });
                };
                window.renderPrintCharts = () => ensureChart(() => buildChart(document.getElementById('lancamentoChartPrint')));
                ensureChart(() => buildChart(document.getElementById('lancamentoChart')));
            `;
            renderReport(reportHTML, chartScriptContent);
        }
    } catch (e) {
        console.error('Erro ao gerar relatorio:', e);
        newWindow.document.getElementById('report-content').innerHTML = `<div class="bg-white p-6 rounded-lg shadow-md text-center"><h2 class="font-bold text-red-600">Falha na Geracao do Relatorio</h2></div>`;
    }
}

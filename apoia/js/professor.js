import { db, state, getLocalDateString, safeQuery, showToast, logAudit } from './core.js';

// ===============================================================
// FUNCOES DO PROFESSOR
// ===============================================================

export async function loadProfessorData(professorUid) {
    const turmaSelect = document.getElementById('professor-turma-select');
    const { data: rels } = await safeQuery(db.from('professores_turmas').select('turma_id').eq('professor_id', professorUid));
    if (!rels || rels.length === 0) return;
    const turmaIds = rels.map(r => r.turma_id);
    const { data } = await safeQuery(db.from('turmas').select('id, nome_turma').in('id', turmaIds));
    if (!data) return;
    turmaSelect.innerHTML = '<option value="">Selecione uma turma</option>';
    data.sort((a, b) => a.nome_turma.localeCompare(b.nome_turma, undefined, { numeric: true }))
        .forEach(t => turmaSelect.innerHTML += `<option value="${t.id}">${t.nome_turma}</option>`);
}

let currentChamadaPresencas = [];
let currentChamadaLocked = false;

function formatDateBr(dateStr) {
    const [year, month, day] = dateStr.split('-');
    return `${day}/${month}/${year}`;
}

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

function eventAppliesToTurma(evento, turmaId) {
    const ids = normalizeTurmasIds(evento.turmas_ids);
    const isSpecific = (evento.abrangencia && evento.abrangencia !== 'global') || ids.length > 0;
    if (!isSpecific) return true;
    if (!turmaId) return false;
    return ids.includes(parseInt(turmaId, 10));
}

async function getCalendarEventForDate(dateStr, turmaId) {
    const { data: eventosConflito } = await safeQuery(
        db.from('eventos').select('data, data_fim, descricao, abrangencia, turmas_ids')
    );
    return (eventosConflito || []).find(e => {
        const inicio = e.data;
        const fim = e.data_fim || e.data;
        return dateStr >= inicio && dateStr <= fim && eventAppliesToTurma(e, turmaId);
    }) || null;
}

async function getBlockedReason(dateStr, turmaId) {
    const dataObj = new Date(dateStr + 'T00:00:00');
    const diaSemana = dataObj.getDay();
    if (diaSemana === 0 || diaSemana === 6) {
        return 'Chamada bloqueada: finais de semana.';
    }
    const dataProibida = await getCalendarEventForDate(dateStr, turmaId);
    if (dataProibida) {
        return `Chamada bloqueada: Data registrada no calendário como "${dataProibida.descricao}".`;
    }
    return null;
}

function getLockInfo(presencas) {
    const times = (presencas || [])
        .map(p => p.registrado_em)
        .filter(Boolean)
        .map(t => new Date(t));
    if (times.length === 0) {
        return { locked: false, lockAt: null };
    }
    const earliest = times.reduce((min, t) => (t < min ? t : min), times[0]);
    const lockAt = new Date(earliest.getTime() + 60 * 60 * 1000);
    const locked = new Date() > lockAt;
    return { locked, lockAt };
}

export async function loadChamada() {
    const turmaSelect = document.getElementById('professor-turma-select');
    const dataText = document.getElementById('professor-data-text');
    const listaAlunosContainer = document.getElementById('chamada-lista-alunos');
    const chamadaHeader = document.getElementById('chamada-header');
    const salvarChamadaBtn = document.getElementById('salvar-chamada-btn');
    const marcarTodosBtn = document.getElementById('chamada-marcar-todos-presentes-btn');
    const statusMsg = document.getElementById('chamada-status-msg');

    const turmaId = turmaSelect.value;
    const data = getLocalDateString();
    if (dataText) dataText.textContent = `Hoje: ${formatDateBr(data)}`;
    let isEditable = true;
    currentChamadaPresencas = [];
    currentChamadaLocked = false;
    listaAlunosContainer.innerHTML = '';
    chamadaHeader.textContent = 'Selecione uma turma e data';
    salvarChamadaBtn.classList.add('hidden');
    if (!turmaId || !data) {
        updateChamadaSummary();
        applyChamadaFaltasFilter();
        return;
    }
    chamadaHeader.innerHTML = '<div class="loader mx-auto"></div>';
    const { data: alunos } = await safeQuery(
        db.from('alunos')
            .select('id, nome_completo')
            .eq('turma_id', turmaId)
            .eq('status', 'ativo')
            .order('nome_completo')
    );
    if (!alunos || alunos.length === 0) {
        chamadaHeader.textContent = 'Nenhum aluno ativo encontrado.';
        return;
    }
    const { data: presencas } = await safeQuery(
        db.from('presencas')
            .select('aluno_id, status, justificativa, registrado_em')
            .eq('turma_id', turmaId)
            .eq('data', data)
    );
    currentChamadaPresencas = presencas || [];
    const blockedReason = await getBlockedReason(data, turmaId);
    const { locked, lockAt } = getLockInfo(currentChamadaPresencas);
    currentChamadaLocked = locked || !!blockedReason;
    if (blockedReason) {
        isEditable = false;
        if (statusMsg) statusMsg.textContent = blockedReason;
    } else if (locked) {
        isEditable = false;
        const lockText = lockAt ? lockAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
        if (statusMsg) statusMsg.textContent = `Chamada encerrada. Alterações bloqueadas após 1h (limite: ${lockText}).`;
    } else {
        if (statusMsg) statusMsg.textContent = 'Clique em “Presente” para marcar falta e informar justificativa.';
    }
    if (marcarTodosBtn) {
        marcarTodosBtn.disabled = !isEditable;
        marcarTodosBtn.classList.toggle('opacity-60', !isEditable);
        marcarTodosBtn.classList.toggle('cursor-not-allowed', !isEditable);
    }
    const presencasMap = new Map((presencas || []).map(p => [p.aluno_id, { status: p.status, justificativa: p.justificativa }]));
    alunos.forEach(aluno => {
        const presenca = presencasMap.get(aluno.id) || { status: 'presente', justificativa: null };
        const isJustificada = presenca.justificativa === 'Falta justificada';
        const isInjustificada = presenca.justificativa === 'Falta injustificada' || (!presenca.justificativa && presenca.status === 'falta');
        const statusAtual = presenca.status === 'falta' ? 'falta' : 'presente';
        const statusLabel = statusAtual === 'falta' ? 'Falta' : 'Presente';
        const statusClass = statusAtual === 'falta'
            ? 'bg-red-100 text-red-700 border-red-200'
            : 'bg-green-100 text-green-700 border-green-200';
        const alunoDiv = document.createElement('div');
        alunoDiv.className = 'p-3 bg-gray-50 rounded-lg';
        alunoDiv.dataset.alunoId = aluno.id;
        alunoDiv.dataset.status = statusAtual;
        alunoDiv.dataset.editable = isEditable ? 'true' : 'false';
        alunoDiv.innerHTML = `
            <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <span class="font-medium">${aluno.nome_completo}</span>
                <div class="flex flex-wrap items-center gap-3">
                    <label class="flex items-center gap-2 text-sm text-gray-700">
                        <input type="checkbox" class="falta-checkbox form-checkbox h-4 w-4 text-red-600" ${statusAtual === 'falta' ? 'checked' : ''} ${!isEditable ? 'disabled' : ''}>
                        <span>Faltou</span>
                    </label>
                    <button type="button" class="status-toggle px-3 py-1 text-sm font-semibold rounded-full border ${statusClass} ${!isEditable ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:opacity-80'}" ${!isEditable ? 'disabled' : ''}>${statusLabel}</button>
                </div>
            </div>
            <div class="justificativa-container mt-2 pt-2 border-t border-gray-200 ${statusAtual === 'falta' ? 'flex' : 'hidden'} items-center gap-x-3">
                <div class="text-sm font-medium">Justificativa:</div>
                <div class="flex items-center gap-x-3">
                    <label class="flex items-center cursor-pointer"><input type="radio" name="just-${aluno.id}" value="Falta justificada" class="form-radio h-4 w-4" ${isJustificada ? 'checked' : ''} ${!isEditable ? 'disabled' : ''}><span class="ml-2 text-sm">Justificada</span></label>
                    <label class="flex items-center cursor-pointer"><input type="radio" name="just-${aluno.id}" value="Falta injustificada" class="form-radio h-4 w-4" ${isInjustificada ? 'checked' : ''} ${!isEditable ? 'disabled' : ''}><span class="ml-2 text-sm">Injustificada</span></label>
                </div>
            </div>`;
        listaAlunosContainer.appendChild(alunoDiv);
    });
    chamadaHeader.textContent = `Chamada de hoje - ${turmaSelect.options[turmaSelect.selectedIndex].text}`;
    updateChamadaSummary();
    applyChamadaFaltasFilter();
    if (isEditable) {
        salvarChamadaBtn.classList.remove('hidden');
    } else {
        showToast('Visualizando chamada. Apenas a chamada do dia atual pode ser editada.', false);
    }
}

export async function saveChamada() {
    const salvarChamadaBtn = document.getElementById('salvar-chamada-btn');
    const dataChamadaStr = getLocalDateString();
    const turmaSelect = document.getElementById('professor-turma-select');
    const blockedReason = await getBlockedReason(dataChamadaStr, turmaSelect?.value);
    if (blockedReason) {
        showToast(blockedReason, true);
        return;
    }
    const { locked } = getLockInfo(currentChamadaPresencas);
    if (locked || currentChamadaLocked) {
        showToast('Chamada encerrada. Alterações bloqueadas após 1h.', true);
        return;
    }

    salvarChamadaBtn.disabled = true;
    salvarChamadaBtn.innerHTML = '<div class="loader mx-auto"></div>';

    const listaAlunosContainer = document.getElementById('chamada-lista-alunos');
    const presencasMap = new Map((currentChamadaPresencas || []).map(p => [p.aluno_id, p]));
    const registroAgora = new Date().toISOString();
    const registros = Array.from(listaAlunosContainer.querySelectorAll('[data-aluno-id]')).map(row => {
        const statusRadio = row.querySelector('.status-radio:checked');
        const status = statusRadio ? statusRadio.value : (row.dataset.status || 'presente');
        let justificativa = null;
        if (status === 'falta') {
            const justRadio = row.querySelector(`input[name="just-${row.dataset.alunoId}"]:checked`);
            justificativa = justRadio ? justRadio.value : 'Falta injustificada';
        }
        return {
            aluno_id: parseInt(row.dataset.alunoId),
            turma_id: parseInt(turmaSelect.value),
            data: dataChamadaStr,
            status: status,
            justificativa: justificativa,
            registrado_por_uid: state.currentUser.id,
            registrado_em: presencasMap.get(parseInt(row.dataset.alunoId))?.registrado_em || registroAgora
        };
    });

    const { error } = await safeQuery(db.from('presencas').upsert(registros, { onConflict: 'aluno_id, data' }));
    if (error) {
        showToast('Erro ao salvar chamada: ' + error.message, true);
    } else {
        await logAudit('chamada_save', 'presencas', null, { turma_id: parseInt(turmaSelect.value), data: dataChamadaStr, total: registros.length });
        showToast('Chamada salva com sucesso!');
        currentChamadaPresencas = registros;
    }
    salvarChamadaBtn.disabled = false;
    salvarChamadaBtn.textContent = 'Salvar Chamada';
}

function getChamadaRows() {
    return Array.from(document.querySelectorAll('#chamada-lista-alunos [data-aluno-id]'));
}

export function updateChamadaSummary() {
    const presentesEl = document.getElementById('chamada-count-presentes');
    const faltasEl = document.getElementById('chamada-count-faltas');
    if (!presentesEl || !faltasEl) return;
    const rows = getChamadaRows();
    let faltas = 0;
    rows.forEach(row => {
        if (row.dataset.status === 'falta') faltas++;
    });
    const presentes = rows.length - faltas;
    presentesEl.textContent = presentes;
    faltasEl.textContent = faltas;
}

export function applyChamadaFaltasFilter() {
    const filtro = document.getElementById('chamada-filtro-faltas');
    if (!filtro) return;
    const rows = getChamadaRows();
    const showOnlyFaltas = filtro.checked;
    rows.forEach(row => {
        row.classList.toggle('hidden', showOnlyFaltas && row.dataset.status !== 'falta');
    });
}

export function setChamadaRowStatus(row, status) {
    if (!row || row.dataset.editable === 'false') return;
    const newStatus = status === 'falta' ? 'falta' : 'presente';
    row.dataset.status = newStatus;
    const checkbox = row.querySelector('.falta-checkbox');
    if (checkbox) checkbox.checked = newStatus === 'falta';
    const btn = row.querySelector('.status-toggle');
    const justContainer = row.querySelector('.justificativa-container');
    if (btn) {
        btn.textContent = newStatus === 'falta' ? 'Falta' : 'Presente';
        btn.classList.toggle('bg-green-100', newStatus !== 'falta');
        btn.classList.toggle('text-green-700', newStatus !== 'falta');
        btn.classList.toggle('border-green-200', newStatus !== 'falta');
        btn.classList.toggle('bg-red-100', newStatus === 'falta');
        btn.classList.toggle('text-red-700', newStatus === 'falta');
        btn.classList.toggle('border-red-200', newStatus === 'falta');
    }
    if (justContainer) {
        justContainer.classList.toggle('hidden', newStatus !== 'falta');
        justContainer.classList.toggle('flex', newStatus === 'falta');
    }
    const radios = row.querySelectorAll(`input[name="just-${row.dataset.alunoId}"]`);
    if (newStatus === 'falta') {
        const alreadyChecked = Array.from(radios).some(r => r.checked);
        if (!alreadyChecked) {
            const injustificada = row.querySelector(`input[name="just-${row.dataset.alunoId}"][value="Falta injustificada"]`);
            if (injustificada) injustificada.checked = true;
        }
    } else {
        radios.forEach(r => r.checked = false);
    }
}

export function marcarTodosPresentes() {
    const rows = getChamadaRows();
    rows.forEach(row => setChamadaRowStatus(row, 'presente'));
    updateChamadaSummary();
    applyChamadaFaltasFilter();
}

export async function loadCorrecaoChamada() {
    const correcaoTurmaSel = document.getElementById('correcao-turma-select');
    const correcaoDataSel = document.getElementById('correcao-data-select');
    const correcaoListaAlunos = document.getElementById('correcao-chamada-lista-alunos');
    const avisoCalendario = document.getElementById('correcao-calendario-aviso');

    const turmaId = correcaoTurmaSel.value;
    const data = correcaoDataSel.value;
    correcaoListaAlunos.innerHTML = '';
    if (avisoCalendario) {
        avisoCalendario.classList.add('hidden');
        avisoCalendario.textContent = '';
    }
    if (!turmaId || !data) {
        correcaoListaAlunos.innerHTML = '<p class="text-center text-gray-500">Selecione uma turma e uma data.</p>';
        return;
    }
    const eventoCalendario = await getCalendarEventForDate(data, turmaId);
    if (eventoCalendario && avisoCalendario) {
        const inicio = formatDateBr(eventoCalendario.data);
        const fim = formatDateBr(eventoCalendario.data_fim || eventoCalendario.data);
        const periodoTexto = eventoCalendario.data_fim && eventoCalendario.data_fim !== eventoCalendario.data
            ? ` (de ${inicio} a ${fim})`
            : '';
        avisoCalendario.textContent = `Aviso: Esta data está marcada no calendário como "${eventoCalendario.descricao}"${periodoTexto}.`;
        avisoCalendario.classList.remove('hidden');
    }
    correcaoListaAlunos.innerHTML = '<div class="loader mx-auto"></div>';
    const { data: alunos } = await safeQuery(
        db.from('alunos')
            .select('id, nome_completo')
            .eq('turma_id', turmaId)
            .eq('status', 'ativo')
            .order('nome_completo')
    );
    if (!alunos || alunos.length === 0) {
        correcaoListaAlunos.innerHTML = '<p class="text-center text-gray-500">Nenhum aluno ativo nesta turma.</p>';
        return;
    }
    const { data: presencas } = await safeQuery(
        db.from('presencas')
            .select('aluno_id, status, justificativa')
            .eq('turma_id', turmaId)
            .eq('data', data)
    );
    const presencasMap = new Map((presencas || []).map(p => [p.aluno_id, { status: p.status, justificativa: p.justificativa }]));
    alunos.forEach(aluno => {
        const presenca = presencasMap.get(aluno.id) || { status: 'presente', justificativa: null };
        const isJustificada = presenca.justificativa === 'Falta justificada';
        const isInjustificada = presenca.justificativa === 'Falta injustificada' || (!presenca.justificativa && presenca.status === 'falta');
        const isOutros = !isJustificada && !isInjustificada && presenca.justificativa;
        const alunoDiv = document.createElement('div');
        alunoDiv.className = 'p-3 bg-gray-50 rounded-lg';
        alunoDiv.dataset.alunoId = aluno.id;
        alunoDiv.innerHTML = `
            <div class="flex items-center justify-between">
                <span class="font-medium">${aluno.nome_completo}</span>
                <div class="flex items-center gap-4">
                    <label class="flex items-center cursor-pointer"><input type="radio" name="corr-status-${aluno.id}" value="presente" class="form-radio h-5 w-5 text-green-600 status-radio" ${presenca.status === 'presente' ? 'checked' : ''}><span class="ml-2 text-sm">Presente</span></label>
                    <label class="flex items-center cursor-pointer"><input type="radio" name="corr-status-${aluno.id}" value="falta" class="form-radio h-5 w-5 text-red-600 status-radio" ${presenca.status === 'falta' ? 'checked' : ''}><span class="ml-2 text-sm">Falta</span></label>
                </div>
            </div>
            <div class="justificativa-container mt-3 pt-3 border-t border-gray-200 ${presenca.status === 'falta' ? '' : 'hidden'}">
                <div class="text-sm font-medium mb-2">Justificativa:</div>
                <div class="flex flex-wrap items-center gap-x-4 gap-y-2 pl-2">
                    <label class="flex items-center"><input type="radio" name="corr-just-${aluno.id}" value="Falta justificada" class="form-radio h-4 w-4" ${isJustificada ? 'checked' : ''}><span class="ml-2 text-sm">Justificada</span></label>
                    <label class="flex items-center"><input type="radio" name="corr-just-${aluno.id}" value="Falta injustificada" class="form-radio h-4 w-4" ${isInjustificada ? 'checked' : ''}><span class="ml-2 text-sm">Injustificada</span></label>
                    <label class="flex items-center"><input type="radio" name="corr-just-${aluno.id}" value="outros" class="form-radio h-4 w-4" ${isOutros ? 'checked' : ''}><span class="ml-2 text-sm">Outros</span></label>
                    <input type="text" class="justificativa-outros-input p-1 border rounded-md text-sm flex-grow min-w-0" placeholder="Motivo..." value="${isOutros ? (presenca.justificativa || '') : ''}">
                </div>
            </div>`;
        correcaoListaAlunos.appendChild(alunoDiv);
    });
}

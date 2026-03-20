import { db, safeQuery, getLocalDateString, getYearFromDateString, getEncaminhamentosTableName, ensureEncaminhamentosTableReady, SUPABASE_URL, SUPABASE_ANON_KEY } from './js/core.js';
import { requireAdminSession, signOut } from './js/auth.js';

const motivosOptions = [
    "Indisciplina / Xingamentos",
    "Gazeando aula",
    "Agressão / Bullying / Discriminação",
    "Uso de celular / fone de ouvido",
    "Dificuldade de aprendizado",
    "Desrespeito com professor / profissionais da unidade escolar",
    "Não produz e não participa em sala",
    "Outros"
];

const acoesOptions = [
    "Diálogo com o estudante",
    "Comunicado aos responsáveis",
    "Mensagem via WhatsApp",
    "Outros"
];

const providenciasOptions = [
    "Solicitar comparecimento do responsável na escola",
    "Advertência",
    "Outros"
];

const ptBrLocale = {
    days: ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'],
    daysShort: ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'],
    daysMin: ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'],
    months: ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'],
    monthsShort: ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'],
    today: 'Hoje',
    clear: 'Limpar',
    dateFormat: 'dd/MM/yyyy',
    timeFormat: 'HH:mm',
    firstDay: 0
};

const state = {
    selectionStart: null,
    selectionEnd: null,
    data: [],
    datepicker: null,
    suppressSelect: false
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

    initDashboard();
});

function initDashboard() {
    const dateInput = document.getElementById('dashboard-date-input');
    const clearBtn = document.getElementById('dashboard-clear-btn');
    const consistenciaBtn = document.getElementById('consistencia-open-btn');
    const consistenciaModal = document.getElementById('consistencia-modal');
    const consistenciaClose = document.getElementById('consistencia-close-btn');
    const consistenciaRefresh = document.getElementById('consistencia-refresh-btn');

    if (dateInput) {
        initDatepicker(dateInput, clearBtn);
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            clearSelection();
        });
    }

    if (consistenciaBtn && consistenciaModal) {
        consistenciaBtn.addEventListener('click', async () => {
            consistenciaModal.classList.remove('hidden');
            await loadConsistenciaModal();
        });
    }
    if (consistenciaClose && consistenciaModal) {
        consistenciaClose.addEventListener('click', () => consistenciaModal.classList.add('hidden'));
    }
    if (consistenciaModal) {
        consistenciaModal.addEventListener('click', (e) => {
            if (e.target === consistenciaModal) consistenciaModal.classList.add('hidden');
        });
    }
    if (consistenciaRefresh) {
        consistenciaRefresh.addEventListener('click', async () => {
            await loadConsistenciaModal();
        });
    }

    syncDateInput();
    loadDashboardData();
    loadQueueSummary();
    loadConsistenciaSummary();
    loadEncTotal();
}

// QR do dia foi movido para a Fila de Scans.

function initDatepicker(dateInput, clearBtn) {
    if (typeof AirDatepicker === 'undefined') {
        dateInput.readOnly = false;
        dateInput.type = 'date';
        dateInput.value = getLocalDateString();
        dateInput.addEventListener('change', () => {
            if (!dateInput.value) {
                clearSelection();
                return;
            }
            const date = new Date(`${dateInput.value}T00:00:00`);
            setSelectionFromDates([date]);
        });
        return;
    }

    const today = new Date();
    const locale = ptBrLocale;

    state.datepicker = new AirDatepicker(dateInput, {
        locale,
        multipleDates: 2,
        multipleDatesSeparator: ' a ',
        toggleSelected: true,
        autoClose: false,
        position: 'bottom right',
        offset: 8,
        isMobile: false,
        classes: 'enc-dashboard',
        onSelect: ({ date }) => {
            if (state.suppressSelect) return;
            const dates = Array.isArray(date) ? date.filter(Boolean) : (date ? [date] : []);
            setSelectionFromDates(dates);
        },
        onRenderCell: ({ date, cellType }) => {
            if (cellType !== 'day') return null;
            const classes = [];
            if (isSameDate(date, today)) classes.push('dp-today');
            if (date.getDay() === 0) classes.push('dp-sunday-cell');
            return classes.length ? { classes: classes.join(' ') } : null;
        },
        onShow: () => {
            scheduleWeekRowButtons();
        },
        onChangeViewDate: () => {
            scheduleWeekRowButtons();
        }
    });

    bindWeekRowSelectors();
    scheduleWeekRowButtons();

    if (clearBtn) clearBtn.classList.toggle('hidden', true);
}

function bindWeekRowSelectors() {
    const dpEl = state.datepicker?.$datepicker || document.querySelector('.air-datepicker.enc-dashboard');
    if (!dpEl) return;
    if (dpEl.dataset.weekSelectorsBound === '1') return;
    dpEl.dataset.weekSelectorsBound = '1';

    dpEl.addEventListener('click', (event) => {
        const btn = event.target?.closest?.('.dp-week-row-btn');
        if (!btn) return;
        event.preventDefault();
        event.stopPropagation();
        const row = Number(btn.getAttribute('data-row'));
        if (!Number.isFinite(row)) return;
        selectWeekdaysByRow(row);
    });
}

function scheduleWeekRowButtons() {
    const delays = [0, 40, 120];
    delays.forEach((delay) => {
        setTimeout(() => renderWeekRowButtons(), delay);
    });
}

function renderWeekRowButtons() {
    const dpEl = state.datepicker?.$datepicker || document.querySelector('.air-datepicker.enc-dashboard');
    if (!dpEl) return;
    const cellsWrap = dpEl.querySelector('.air-datepicker-body--cells');
    if (!cellsWrap) return;

    cellsWrap.querySelectorAll('.dp-week-row-btn').forEach((node) => node.remove());

    const dayCells = Array.from(cellsWrap.querySelectorAll('.air-datepicker-cell.-day-'));
    if (dayCells.length < 7) return;

    const rowCount = Math.floor(dayCells.length / 7);
    const iconSize = 16;
    for (let row = 0; row < rowCount; row += 1) {
        const sundayCell = dayCells[row * 7];
        if (!sundayCell) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dp-week-row-btn';
        btn.setAttribute('data-row', String(row));
        btn.setAttribute('aria-label', 'Selecionar semana útil');
        btn.title = 'Selecionar segunda a sexta desta semana';
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m6 12 4 4 8-8"/></svg>';
        const top = sundayCell.offsetTop + Math.round((sundayCell.offsetHeight - iconSize) / 2);
        const left = 7;
        btn.style.top = `${top}px`;
        btn.style.left = `${left}px`;
        cellsWrap.appendChild(btn);
    }
}

function selectWeekdaysByRow(row) {
    const viewDate = stripTime(state.datepicker?.viewDate || new Date());
    const sunday = getGridStartSunday(viewDate);
    sunday.setDate(sunday.getDate() + (row * 7));
    const monday = new Date(sunday);
    monday.setDate(sunday.getDate() + 1);
    const friday = new Date(sunday);
    friday.setDate(sunday.getDate() + 5);
    const start = stripTime(monday);
    const end = stripTime(friday);

    const sameWeekAlreadySelected = (
        state.selectionStart
        && state.selectionEnd
        && isSameDate(state.selectionStart, start)
        && isSameDate(state.selectionEnd, end)
    );

    if (sameWeekAlreadySelected) {
        const today = stripTime(new Date());
        state.suppressSelect = true;
        if (state.datepicker) {
            state.datepicker.clear();
            state.datepicker.selectDate(today, { silent: true });
            if (typeof state.datepicker.setViewDate === 'function') {
                state.datepicker.setViewDate(today);
            }
        }
        state.suppressSelect = false;
        setSelectionFromDates([today]);
        return;
    }

    state.suppressSelect = true;
    if (state.datepicker) {
        state.datepicker.clear();
        state.datepicker.selectDate([start, end], { silent: true });
        if (typeof state.datepicker.setViewDate === 'function') {
            state.datepicker.setViewDate(start);
        }
    }
    state.suppressSelect = false;

    setSelectionFromDates([start, end]);
}

function getGridStartSunday(viewDate) {
    const firstOfMonth = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
    const sunday = new Date(firstOfMonth);
    sunday.setDate(firstOfMonth.getDate() - firstOfMonth.getDay());
    return stripTime(sunday);
}

function clearSelection(options = {}) {
    state.suppressSelect = true;
    if (state.datepicker) {
        state.datepicker.clear();
        if (options.focusToday && typeof state.datepicker.setViewDate === 'function') {
            state.datepicker.setViewDate(new Date());
        }
    }
    state.suppressSelect = false;
    state.selectionStart = null;
    state.selectionEnd = null;
    syncDateInput();
    loadDashboardData();
}

function setSelectionFromDates(dates) {
    if (!dates || dates.length === 0) {
        state.selectionStart = null;
        state.selectionEnd = null;
        syncDateInput();
        loadDashboardData();
        return;
    }

    if (dates.length === 1) {
        const date = stripTime(dates[0]);
        const sameAsCurrent = state.selectionStart && !state.selectionEnd && isSameDate(state.selectionStart, date);
        if (sameAsCurrent) {
            clearSelection();
            return;
        }
        state.selectionStart = date;
        state.selectionEnd = null;
        syncDateInput();
        loadDashboardData();
        return;
    }

    const [first, second] = dates.map(stripTime).sort((a, b) => a - b);
    state.selectionStart = first;
    state.selectionEnd = second;
    syncDateInput();
    loadDashboardData();
}

function syncDateInput() {
    const input = document.getElementById('dashboard-date-input');
    const clearBtn = document.getElementById('dashboard-clear-btn');
    if (!input) return;

    if (!state.selectionStart) {
        const today = new Date();
        input.value = formatDateBrShort(toDateString(today));
        if (clearBtn) clearBtn.classList.add('hidden');
        return;
    }

    const startStr = toDateString(state.selectionStart);
    const endStr = state.selectionEnd ? toDateString(state.selectionEnd) : startStr;
    input.value = state.selectionEnd
        ? `${formatDateBrShort(startStr)} a ${formatDateBrShort(endStr)}`
        : formatDateBrShort(startStr);

    if (clearBtn) clearBtn.classList.remove('hidden');
}

function getSelectedRange() {
    if (state.selectionStart) {
        const start = stripTime(state.selectionStart);
        const end = stripTime(state.selectionEnd || state.selectionStart);
        return {
            start,
            end,
            mode: state.selectionEnd ? 'range' : 'day'
        };
    }

    const weekRange = getWeekRange(new Date());
    return {
        start: weekRange.start,
        end: weekRange.end,
        mode: 'week'
    };
}

function updateDashboardPeriod(range) {
    const periodEl = document.getElementById('dashboard-period');
    if (!periodEl) return;

    const weekInfo = getIsoWeekInfo(range.start);
    const currentInfo = getIsoWeekInfo(new Date());
    const isCurrent = weekInfo.week === currentInfo.week && weekInfo.year === currentInfo.year;
    const weekLabel = `Semana ${weekInfo.week}${isCurrent ? ' (Atual)' : ''}`;

    const startStr = toDateString(range.start);
    const endStr = toDateString(range.end);
    let detail = '';
    if (range.mode === 'day') {
        detail = `Dia ${formatDateBr(startStr)}`;
    } else if (range.mode === 'range') {
        detail = `Período ${formatDateBr(startStr)} a ${formatDateBr(endStr)}`;
    } else {
        detail = `${formatDateBr(startStr)} a ${formatDateBr(endStr)} (Seg–Sex)`;
    }

    periodEl.textContent = `${weekLabel} • ${detail}`;
}

async function loadDashboardData() {
    const range = getSelectedRange();
    updateDashboardPeriod(range);
    const rangeStart = toDateString(range.start);
    const rangeEnd = toDateString(range.end);

    try {
        const year = getYearFromDateString(rangeStart);
        await ensureEncaminhamentosTableReady(year);
        const tableName = getEncaminhamentosTableName(year);
        const { data } = await safeQuery(
            db.from(tableName)
                .select('id, data_encaminhamento, aluno_id, aluno_nome, professor_uid, professor_nome, motivos, acoes_tomadas, providencias, status, status_ligacao, whatsapp_enviado, whatsapp_status')
                .gte('data_encaminhamento', rangeStart)
                .lte('data_encaminhamento', rangeEnd)
                .order('data_encaminhamento', { ascending: false })
        );
        state.data = data || [];
        renderCards();
        renderMotivos();
        renderAcoesProvidencias();
        renderContato();
        await loadQueueSummary();
        await loadConsistenciaSummary();
        await loadEncTotal();
    } catch (err) {
        console.error('Erro ao carregar dashboard:', err?.message || err);
    }
}

async function loadQueueSummary() {
    const countEl = document.getElementById('dash-queue-count');
    if (!countEl) return;
    try {
        const { count } = await safeQuery(
            db.from('enc_scan_jobs')
                .select('*', { count: 'exact', head: true })
                .eq('status', 'novo')
        );
        countEl.textContent = String(count ?? 0);
    } catch (err) {
        countEl.textContent = '—';
    }
}

async function loadConsistenciaSummary() {
    const semTurmaEl = document.getElementById('dash-consistencia-sem-turma');
    const semMatriculaEl = document.getElementById('dash-consistencia-sem-matricula');
    try {
        const [alunosRes, turmasRes, alunosSemMatriculaRes] = await Promise.all([
            safeQuery(db.from('enc_alunos').select('id, turma_id, status')),
            safeQuery(db.from('turmas').select('id')),
            safeQuery(db.from('enc_alunos').select('*', { count: 'exact', head: true }).eq('status', 'ativo').or('matricula.is.null,matricula.eq.'))
        ]);
        const turmasById = new Set((turmasRes.data || []).map(t => Number(t.id)));
        const alunosSemTurmaCount = (alunosRes.data || []).filter(a =>
            (a.status || '') === 'ativo' && (!a.turma_id || !turmasById.has(Number(a.turma_id)))
        ).length;
        if (semTurmaEl) semTurmaEl.textContent = String(alunosSemTurmaCount);
        if (semMatriculaEl) semMatriculaEl.textContent = String(alunosSemMatriculaRes.count ?? 0);
    } catch (err) {
        if (semTurmaEl) semTurmaEl.textContent = '—';
        if (semMatriculaEl) semMatriculaEl.textContent = '—';
    }
}

async function loadEncTotal() {
    const totalEl = document.getElementById('dash-enc-total');
    if (!totalEl) return;
    try {
        const range = getSelectedRange();
        const year = getYearFromDateString(toDateString(range.start));
        await ensureEncaminhamentosTableReady(year);
        const tableName = getEncaminhamentosTableName(year);
        const { count } = await safeQuery(db.from(tableName).select('*', { count: 'exact', head: true }));
        totalEl.textContent = String(count ?? 0);
    } catch (err) {
        totalEl.textContent = '—';
    }
}

async function loadConsistenciaModal() {
    const alunosSemTurmaCountEl = document.getElementById('consistencia-alunos-sem-turma-count');
    const alunosSemMatriculaCountEl = document.getElementById('consistencia-alunos-sem-matricula-count');
    const totalAlunosCountEl = document.getElementById('consistencia-total-alunos-count');
    const totalProfessoresCountEl = document.getElementById('consistencia-total-professores-count');
    const alunosSemTurmaTable = document.getElementById('consistencia-alunos-sem-turma-table');
    const alunosSemMatriculaTable = document.getElementById('consistencia-alunos-sem-matricula-table');

    const setLoading = () => {
        if (alunosSemTurmaCountEl) alunosSemTurmaCountEl.textContent = '...';
        if (alunosSemMatriculaCountEl) alunosSemMatriculaCountEl.textContent = '...';
        if (totalAlunosCountEl) totalAlunosCountEl.textContent = '...';
        if (totalProfessoresCountEl) totalProfessoresCountEl.textContent = '...';
        if (alunosSemTurmaTable) alunosSemTurmaTable.innerHTML = '<tr><td colspan="2" class="p-4 text-center">Carregando...</td></tr>';
        if (alunosSemMatriculaTable) alunosSemMatriculaTable.innerHTML = '<tr><td colspan="2" class="p-4 text-center">Carregando...</td></tr>';
    };

    setLoading();

    try {
        const [alunosAtivosRes, alunosSemMatriculaRes, alunosSemMatriculaListRes, turmasRes, totalAlunosRes, totalProfessoresRes] = await Promise.all([
            safeQuery(db.from('enc_alunos').select('id, nome_completo, matricula, turma_id').eq('status', 'ativo')),
            safeQuery(db.from('enc_alunos').select('*', { count: 'exact', head: true }).eq('status', 'ativo').or('matricula.is.null,matricula.eq.')),
            safeQuery(db.from('enc_alunos').select('id, nome_completo, turma_id').eq('status', 'ativo').or('matricula.is.null,matricula.eq.').order('nome_completo').limit(50)),
            safeQuery(db.from('turmas').select('id, nome_turma')),
            safeQuery(db.from('enc_alunos').select('*', { count: 'exact', head: true })),
            safeQuery(db.from('enc_professores').select('*', { count: 'exact', head: true }))
        ]);

        const turmas = turmasRes.data || [];
        const turmasById = new Map(turmas.map(t => [Number(t.id), t.nome_turma]));
        const alunosAtivos = alunosAtivosRes.data || [];
        const alunosSemTurma = alunosAtivos
            .filter(a => !a.turma_id || !turmasById.has(Number(a.turma_id)))
            .sort((a, b) => (a.nome_completo || '').localeCompare(b.nome_completo || '', undefined, { sensitivity: 'base' }));
        const alunosSemTurmaCount = alunosSemTurma.length;
        if (alunosSemTurmaCountEl) alunosSemTurmaCountEl.textContent = alunosSemTurmaCount;
        if (alunosSemTurmaTable) {
            alunosSemTurmaTable.innerHTML = alunosSemTurma.length
                ? alunosSemTurma.slice(0, 50).map(a => `
                    <tr>
                        <td class="p-3">${a.nome_completo || '-'}</td>
                        <td class="p-3">${a.matricula || '-'}</td>
                    </tr>
                `).join('')
                : '<tr><td colspan="2" class="p-4 text-center">Nenhum encontrado.</td></tr>';
        }

        if (alunosSemMatriculaCountEl) alunosSemMatriculaCountEl.textContent = alunosSemMatriculaRes.count || 0;
        const alunosSemMatricula = alunosSemMatriculaListRes.data || [];
        if (alunosSemMatriculaTable) {
            alunosSemMatriculaTable.innerHTML = alunosSemMatricula.length
                ? alunosSemMatricula.slice(0, 50).map(a => `
                    <tr>
                        <td class="p-3">${a.nome_completo || '-'}</td>
                        <td class="p-3">${turmasById.get(Number(a.turma_id)) || '-'}</td>
                    </tr>
                `).join('')
                : '<tr><td colspan="2" class="p-4 text-center">Nenhum encontrado.</td></tr>';
        }

        if (totalAlunosCountEl) totalAlunosCountEl.textContent = totalAlunosRes.count ?? 0;
        if (totalProfessoresCountEl) totalProfessoresCountEl.textContent = totalProfessoresRes.count ?? 0;
    } catch (err) {
        console.error('Erro ao carregar consistencia:', err);
        if (alunosSemTurmaCountEl) alunosSemTurmaCountEl.textContent = 'Erro';
        if (alunosSemMatriculaCountEl) alunosSemMatriculaCountEl.textContent = 'Erro';
        if (totalAlunosCountEl) totalAlunosCountEl.textContent = 'Erro';
        if (totalProfessoresCountEl) totalProfessoresCountEl.textContent = 'Erro';
        if (alunosSemTurmaTable) alunosSemTurmaTable.innerHTML = '<tr><td colspan="2" class="p-4 text-center text-red-500">Erro ao carregar.</td></tr>';
        if (alunosSemMatriculaTable) alunosSemMatriculaTable.innerHTML = '<tr><td colspan="2" class="p-4 text-center text-red-500">Erro ao carregar.</td></tr>';
    }
}

function renderCards() {
    const total = state.data.length;
    const statusCounts = { Aberto: 0, 'Em Acompanhamento': 0, Resolvido: 0, Arquivado: 0 };
    state.data.forEach(item => {
        const status = item.status || 'Aberto';
        if (statusCounts[status] === undefined) statusCounts[status] = 0;
        statusCounts[status] += 1;
    });
    setCard('dash-total', total);
    setCard('dash-arquivados', statusCounts.Arquivado || 0);
    setCardWithPct('dash-aberto', 'dash-aberto-pct', 'dash-aberto-bar', statusCounts.Aberto || 0, total);
    setCardWithPct('dash-acomp', 'dash-acomp-pct', 'dash-acomp-bar', statusCounts['Em Acompanhamento'] || 0, total);
    setCardWithPct('dash-resolvido', 'dash-resolvido-pct', 'dash-resolvido-bar', statusCounts.Resolvido || 0, total);
}

function renderMotivos() {
    const container = document.getElementById('dash-motivos-list');
    if (!container) return;
    container.innerHTML = buildOptionList(motivosOptions, item => parseList(item.motivos), state.data);
}

function renderAcoesProvidencias() {
    const acoesEl = document.getElementById('dash-acoes-list');
    const provEl = document.getElementById('dash-providencias-list');
    if (acoesEl) acoesEl.innerHTML = buildOptionList(acoesOptions, item => parseList(item.acoes_tomadas), state.data);
    if (provEl) provEl.innerHTML = buildOptionList(providenciasOptions, item => parseList(item.providencias), state.data);
}

function renderContato() {
    const container = document.getElementById('dash-contato-list');
    if (!container) return;
    const total = state.data.length || 0;
    const countLigou = state.data.filter(i => !!i.status_ligacao).length;
    const countAtendeu = state.data.filter(i => i.status_ligacao === 'Atendeu').length;
    const countNaoAtendeu = state.data.filter(i => i.status_ligacao === 'Não atendeu').length;
    const countWhats = state.data.filter(i => i.whatsapp_enviado).length;
    const countWhatsResp = state.data.filter(i => i.whatsapp_status === 'Respondeu').length;
    const countWhatsNaoResp = state.data.filter(i => i.whatsapp_status === 'Não respondeu').length;

    container.innerHTML = [
        buildLine('Ligou', countLigou, total, 0),
        buildLine('Atendeu', countAtendeu, total, 1),
        buildLine('Não atendeu', countNaoAtendeu, total, 2),
        buildLine('WhatsApp enviado', countWhats, total, 3),
        buildLine('WhatsApp respondeu', countWhatsResp, total, 4),
        buildLine('WhatsApp não respondeu', countWhatsNaoResp, total, 5)
    ].join('');
}

function buildOptionList(options, getValues, data) {
    const total = data.length || 0;
    const counts = new Map(options.map(o => [o, 0]));

    data.forEach(item => {
        const values = getValues(item);
        const normalized = values.map(v => v.startsWith('Outros:') ? 'Outros' : v);
        options.forEach(opt => {
            if (normalized.includes(opt)) {
                counts.set(opt, (counts.get(opt) || 0) + 1);
            }
        });
    });

    const rows = options.map((opt, idx) => {
        const count = counts.get(opt) || 0;
        return buildLine(opt, count, total, idx);
    });
    return rows.join('');
}

function buildLine(label, count, total, idx = 0) {
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const rowClass = idx % 2 === 0 ? 'bg-gray-50' : 'bg-white';
    return `
        <div class="flex items-center justify-between gap-3 py-1 px-2 ${rowClass}">
            <span class="text-gray-700">${label}</span>
            <span class="text-gray-500 text-xs whitespace-nowrap flex-shrink-0 text-right">${pct}% <span class="text-gray-400">(${count})</span></span>
        </div>
    `;
}

function parseList(value) {
    if (!value) return [];
    return value.split(',').map(v => v.trim()).filter(Boolean);
}

function setCard(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function setCardWithPct(valueId, pctId, barId, count, total) {
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const valEl = document.getElementById(valueId);
    const pctEl = document.getElementById(pctId);
    const barEl = document.getElementById(barId);
    if (valEl) valEl.textContent = count;
    if (pctEl) pctEl.textContent = `${pct}% (${count})`;
    if (barEl) barEl.style.width = `${pct}%`;
}

function stripTime(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isSameDate(a, b) {
    if (!a || !b) return false;
    return a.getFullYear() === b.getFullYear()
        && a.getMonth() === b.getMonth()
        && a.getDate() === b.getDate();
}

function getWeekRange(date) {
    const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = copy.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const monday = new Date(copy);
    monday.setDate(copy.getDate() + diff);
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);
    return { start: monday, end: friday };
}

function toDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatDateBr(dateStr) {
    if (!dateStr) return '-';
    const [year, month, day] = dateStr.split('-');
    if (!year || !month || !day) return dateStr;
    return `${day}/${month}/${year}`;
}

function formatDateBrShort(dateStr) {
    if (!dateStr) return '-';
    const [year, month, day] = dateStr.split('-');
    if (!year || !month || !day) return dateStr;
    return `${day}/${month}/${year.slice(2)}`;
}

function getIsoWeekInfo(date) {
    const temp = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = temp.getUTCDay() || 7;
    temp.setUTCDate(temp.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(temp.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((temp - yearStart) / 86400000) + 1) / 7);
    return { week, year: temp.getUTCFullYear() };
}

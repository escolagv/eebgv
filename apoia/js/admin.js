import { db, state, getLocalDateString, getAuthRedirectUrl, safeQuery, showToast, closeModal, closeAllModals, logAudit, SUPABASE_URL, SUPABASE_ANON_KEY } from './core.js';

const APOIA_ITEMS_PER_PAGE = 10;
const CHAMADAS_ITEMS_PER_PAGE = 100;
let apoiaCurrentPage = 1;
let chamadasCurrentPage = 1;
let chamadasStartDate = null;
let chamadasEndDate = null;
let chamadasProfessorId = '';
let chamadasProfessorSearch = '';
let chamadasTurmaId = '';
let chamadasRegistroFilter = '';
let chamadasAnoLetivo = '';
let chamadasTurmaSearch = '';
let chamadasRegistroSearch = '';
let chamadasAnoSearch = '';
let chamadasDateCleared = false;
let chamadasCalendarOpen = false;
let chamadasCalendar = { month: new Date().getMonth(), year: new Date().getFullYear() };
let chamadasCacheKey = '';
let chamadasCacheRows = [];
let chamadasProfessorLookup = new Map();
let chamadasTurmaLookup = new Map();
let chamadasRegistroLookup = new Map();
let chamadasAnoLookup = new Map();
let chamadasSort = { key: 'data', dir: 'desc' };
let notificationsChannel = null;
let notificationsPollingId = null;
let notificationsReloadTimer = null;
let notificationsRealtimeStopping = false;
let notificationsChannelToken = 0;
let relatoriosPanelSignature = '';
const relatoriosSort = { key: 'turma', dir: 'asc' };
let relatoriosRowsCache = [];
const professoresSort = { key: 'nome', dir: 'asc' };
let consistenciaAnoLetivo = '';
const professorConsultaSort = { key: 'nome', dir: 'asc' };
const professorConsultaRows = {
    criados: [],
    confirmados: [],
    'nao-confirmados': []
};
const professorConsultaTabLabels = {
    criados: 'Criados',
    confirmados: 'Confirmados',
    'nao-confirmados': 'Não confirmados'
};

async function fetchAuthUserUidByEmail(email) {
    try {
        const { data, error } = await safeQuery(db.rpc('auth_user_uid_by_email', { p_email: email }));
        if (error) throw error;
        if (Array.isArray(data)) return data[0];
        return data;
    } catch (err) {
        console.warn('Falha ao buscar auth user:', err?.message || err);
        return null;
    }
}

async function generateProfessorAccessLink(email) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return { actionLink: null, error: 'Email inválido.' };

    try {
        const { data: sessionData, error: sessionError } = await db.auth.getSession();
        if (sessionError || !sessionData?.session?.access_token) {
            return { actionLink: null, error: 'Sessão expirada. Faça login novamente.' };
        }

        const response = await fetch(`${SUPABASE_URL}/functions/v1/generate-professor-access-link`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${sessionData.session.access_token}`,
                apikey: SUPABASE_ANON_KEY
            },
            body: JSON.stringify({
                email: normalizedEmail,
                redirect_to: getAuthRedirectUrl()
            })
        });

        let payload = null;
        try {
            payload = await response.json();
        } catch (err) {
            payload = null;
        }

        if (!response.ok) {
            return { actionLink: null, error: payload?.error || `Falha ao gerar link (HTTP ${response.status}).` };
        }

        return { actionLink: payload?.short_link || payload?.action_link || null, error: null };
    } catch (err) {
        return { actionLink: null, error: `Falha de rede ao gerar link: ${err?.message || err}` };
    }
}

async function upsertProfessorProfile(userUid, payload) {
    return await safeQuery(
        db.from('usuarios')
            .upsert({ user_uid: userUid, papel: 'professor', status: 'ativo', ...payload }, { onConflict: 'user_uid' })
            .select()
            .single()
    );
}

async function sendProfessorSignupConfirmation(email) {
    return await db.auth.resend({
        type: 'signup',
        email: String(email || '').trim().toLowerCase(),
        options: { emailRedirectTo: getAuthRedirectUrl() }
    });
}

async function updateAuthEmail(userUid, newEmail) {
    const { data: sessionData, error: sessionError } = await db.auth.getSession();
    if (sessionError || !sessionData?.session?.access_token) {
        throw new Error('Sessao expirada. Faça login novamente.');
    }
    const response = await fetch(`${SUPABASE_URL}/functions/v1/update-auth-email`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionData.session.access_token}`,
            apikey: SUPABASE_ANON_KEY
        },
        body: JSON.stringify({ user_uid: userUid, new_email: newEmail })
    });
    let payload = null;
    try {
        payload = await response.json();
    } catch (err) {
        payload = null;
    }
    if (!response.ok) {
        const message = payload?.error || `Erro ao atualizar email no login (HTTP ${response.status}).`;
        throw new Error(message);
    }
    return payload;
}

function normalizePhoneDigits(value) {
    return (value || '').toString().replace(/\D/g, '');
}

function formatPhoneDisplay(value) {
    const digits = normalizePhoneDigits(value);
    if (!digits) return '';
    if (digits.length <= 2) return `(${digits})`;
    const ddd = digits.slice(0, 2);
    const rest = digits.slice(2);
    if (!rest) return `(${ddd})`;
    if (rest.length <= 5) return `(${ddd})${rest}`;
    return `(${ddd})${rest.slice(0, 5)}-${rest.slice(5)}`;
}

function formatTimeForInput(value) {
    if (!value) return '';
    const match = String(value).match(/(\d{2}):(\d{2})/);
    return match ? `${match[1]}:${match[2]}` : '';
}

function normalizeTimeForDb(value) {
    if (!value) return null;
    const str = String(value).trim();
    if (!str) return null;
    const match = str.match(/(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return null;
    return `${match[1]}:${match[2]}:${match[3] || '00'}`;
}

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
            .select('id, user_uid, nome, papel, email_confirmado, status, vinculo, telefone')
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
    const today = getLocalDateString();
    const monthNames = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
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

    const classifyEventType = (descricao) => {
        const text = String(descricao || '').toLowerCase();
        if (text.includes('feriado')) return { key: 'feriado', label: 'FERIADO', color: '#dc2626', priority: 1 };
        if (text.includes('recesso')) return { key: 'recesso', label: 'RECESSO', color: '#059669', priority: 2 };
        if (text.includes('implant') || text.includes('sistema')) return { key: 'sistema', label: 'SISTEMA', color: '#7c3aed', priority: 4 };
        if (text.includes('pedag') || text.includes('formação') || text.includes('formacao')) return { key: 'pedagogico', label: 'PEDAGÓGICO', color: '#2563eb', priority: 3 };
        return { key: 'outros', label: 'EVENTO', color: '#eab308', priority: 5 };
    };

    const eventosByDate = new Map();
    (eventos || []).forEach(ev => {
        const inicio = new Date(ev.data + 'T00:00:00');
        const fim = new Date((ev.data_fim || ev.data) + 'T00:00:00');
        const tipo = classifyEventType(ev.descricao);
        const labelParts = [`[${tipo.label}]`, ev.descricao || 'Evento'];
        if (ev.abrangencia && ev.abrangencia !== 'global') {
            labelParts.push('Turmas específicas');
        }
        const label = labelParts.join(' - ');
        for (let d = new Date(inicio); d <= fim; d.setDate(d.getDate() + 1)) {
            const key = d.toISOString().split('T')[0];
            const current = eventosByDate.get(key) || [];
            if (!current.some(item => item.label === label)) current.push({ label, color: tipo.color, priority: tipo.priority });
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
        const isToday = dateStr === today;
        const isWeekend = [0, 6].includes(new Date(dateStr + 'T00:00:00').getDay());
        const eventItems = eventosByDate.get(dateStr) || [];
        const hasEvent = eventItems.length > 0;
        const eventTitle = hasEvent ? escapeAttr(eventItems.map(item => item.label).join(' | ')) : '';
        const accent = hasEvent ? [...eventItems].sort((a, b) => a.priority - b.priority)[0].color : '';
        const markersHtml = hasEvent
            ? `<span class="calendar-day-markers">${eventItems.slice(0, 3).map(item => `<i class="calendar-day-marker" style="background:${item.color};"></i>`).join('')}${eventItems.length > 3 ? '<i class="calendar-day-marker-more">+</i>' : ''}</span>`
            : '';
        html += `
            <div class="calendar-day-container ${isSelected ? 'calendar-day-selected' : ''} ${isToday ? 'calendar-day-today' : ''}" data-date="${dateStr}">
                <div class="calendar-day-content ${hasEvent ? 'calendar-day-event' : ''} ${isWeekend ? 'calendar-day-weekend' : ''}" ${accent ? `style="--event-accent:${accent};"` : ''} ${eventTitle ? `title="${eventTitle}"` : ''}>
                    <span class="calendar-day-number">${day}</span>
                    ${markersHtml}
                </div>
            </div>
        `;
    }
    calendarGrid.innerHTML = html;
}

export function setDashboardSelectedDate(dateStr) {
    if (!dateStr) return;
    const calendarGrid = document.getElementById('calendar-grid');
    if (!calendarGrid) return;

    state.dashboardSelectedDate = dateStr;

    const prevSelected = calendarGrid.querySelector('.calendar-day-container.calendar-day-selected');
    if (prevSelected) prevSelected.classList.remove('calendar-day-selected');

    const nextSelected = calendarGrid.querySelector(`.calendar-day-container[data-date="${dateStr}"]`);
    if (nextSelected) nextSelected.classList.add('calendar-day-selected');
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
    const criadoEmInput = document.getElementById('aluno-criado-em');
    if (criadoEmInput) criadoEmInput.value = '-';
    const alunoTurmaSelect = document.getElementById('aluno-turma');
    alunoTurmaSelect.innerHTML = '<option value="">Selecione...</option>';
    const anoLetivoFilter = document.getElementById('aluno-ano-letivo-filter');
    const anoAtual = anoLetivoFilter?.value || state.anosLetivosCache?.[0] || '';
    state.turmasCache
        .filter(t => !anoAtual || String(t.ano_letivo) === String(anoAtual))
        .forEach(t => alunoTurmaSelect.innerHTML += `<option value="${t.id}">${t.nome_turma}</option>`);

    if (editId) {
        const { data } = await safeQuery(db.from('alunos').select('*').eq('id', editId).single());
        if (data) {
            document.getElementById('aluno-id').value = data.id;
            document.getElementById('aluno-nome').value = data.nome_completo;
            document.getElementById('aluno-matricula').value = data.matricula || '';
            if (data.turma_id && !Array.from(alunoTurmaSelect.options).some(opt => opt.value === String(data.turma_id))) {
                const turmaRef = state.turmasCache.find(t => String(t.id) === String(data.turma_id));
                const label = turmaRef ? turmaRef.nome_turma : `ID ${data.turma_id}`;
                const opt = document.createElement('option');
                opt.value = data.turma_id;
                opt.textContent = label;
                alunoTurmaSelect.appendChild(opt);
            }
            document.getElementById('aluno-turma').value = data.turma_id || '';
            document.getElementById('aluno-responsavel').value = data.nome_responsavel || '';
            document.getElementById('aluno-telefone').value = data.telefone || '';
            document.getElementById('aluno-status').value = data.status || 'ativo';
            if (criadoEmInput) criadoEmInput.value = formatDateTimeSP(data.created_at) || '-';
        }
    }
    modal.classList.remove('hidden');
}

export async function handleAlunoFormSubmit(e) {
    const id = document.getElementById('aluno-id').value;
    const nomeValue = String(document.getElementById('aluno-nome').value || '').trim();
    const alunoData = {
        nome_completo: nomeValue,
        matricula: document.getElementById('aluno-matricula').value,
        turma_id: document.getElementById('aluno-turma').value || null,
        nome_responsavel: document.getElementById('aluno-responsavel').value,
        telefone: document.getElementById('aluno-telefone').value,
        status: document.getElementById('aluno-status').value || 'ativo'
    };
    const matriculaValue = (alunoData.matricula || '').trim();
    if (matriculaValue) {
        const { data: existing, error: existingError } = await safeQuery(
            db.from('alunos').select('id').eq('matricula', matriculaValue).limit(1)
        );
        if (existingError) {
            showToast('Erro ao validar matrícula: ' + existingError.message, true);
            return;
        }
        if (existing && existing.length > 0 && String(existing[0].id) !== String(id)) {
            showToast('Já existe um aluno com essa matrícula.', true);
            return;
        }

        const { data: duplicatePair, error: duplicatePairError } = await safeQuery(
            db.from('alunos')
                .select('id')
                .eq('matricula', matriculaValue)
                .eq('nome_completo', nomeValue)
                .limit(1)
        );
        if (duplicatePairError) {
            showToast('Erro ao validar duplicidade de aluno: ' + duplicatePairError.message, true);
            return;
        }
        if (duplicatePair && duplicatePair.length > 0 && String(duplicatePair[0].id) !== String(id)) {
            showToast('Já existe um aluno com o mesmo nome e matrícula.', true);
            return;
        }
    }
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

function bindApoiaRelatorioModal() {
    const openBtn = document.getElementById('apoia-relatorio-open-btn');
    const closeBtn = document.getElementById('apoia-relatorio-close-btn');
    const modal = document.getElementById('apoia-relatorio-modal');
    const alunoSelect = document.getElementById('apoia-relatorio-aluno-select');
    const alunoSearch = document.getElementById('apoia-relatorio-aluno-search');
    const alunoDatalist = document.getElementById('apoia-relatorio-aluno-options');
    const alunoClear = document.getElementById('apoia-relatorio-aluno-clear');
    if (!openBtn || !closeBtn || !modal) return;
    if (modal.dataset.bound === '1') return;
    modal.dataset.bound = '1';

    const alunoLookup = new Map();
    const normalize = (value) => String(value || '').trim().toLowerCase();
    const updateAlunoClear = () => {
        if (!alunoSearch || !alunoClear) return;
        alunoClear.classList.toggle('hidden', !alunoSearch.value.trim());
    };

    const renderAlunoOptions = () => {
        if (!alunoSelect || !alunoDatalist) return;
        const previouslySelected = String(alunoSelect.value || '');
        const turmasMap = new Map((state.turmasCache || []).map(t => [String(t.id), String(t.nome_turma || '').trim()]));
        const list = [...(state.alunosCache || [])]
            .map((a) => {
                const turmaNome = turmasMap.get(String(a.turma_id || '')) || 'Sem turma';
                return {
                    ...a,
                    _turma_nome: turmaNome
                };
            })
            .sort((a, b) => {
                const turmaCmp = String(a._turma_nome || '').localeCompare(String(b._turma_nome || ''), 'pt-BR', {
                    numeric: true,
                    sensitivity: 'base'
                });
                if (turmaCmp !== 0) return turmaCmp;
                return String(a.nome_completo || '').localeCompare(String(b.nome_completo || ''), 'pt-BR', {
                    sensitivity: 'base'
                });
            });
        const selectOptions = ['<option value="">Todos os alunos</option>'];
        const datalistOptions = [];
        alunoLookup.clear();
        list.forEach((a) => {
            const nome = String(a.nome_completo || '').trim();
            const turmaNome = String(a._turma_nome || '').trim();
            const id = String(a.id || '');
            if (!nome || !id) return;
            const label = `${turmaNome} • ${nome}`;
            selectOptions.push(`<option value="${id}">${label}</option>`);
            datalistOptions.push(`<option value="${label}"></option>`);
            if (!alunoLookup.has(normalize(label))) {
                alunoLookup.set(normalize(label), id);
            }
            if (!alunoLookup.has(normalize(nome))) {
                alunoLookup.set(normalize(nome), id);
            }
        });
        alunoSelect.innerHTML = selectOptions.join('');
        alunoDatalist.innerHTML = datalistOptions.join('');

        if (previouslySelected && Array.from(alunoSelect.options).some(opt => String(opt.value) === previouslySelected)) {
            alunoSelect.value = previouslySelected;
            const selectedLabel = alunoSelect.options[alunoSelect.selectedIndex]?.text || '';
            if (alunoSearch) alunoSearch.value = selectedLabel;
        } else {
            alunoSelect.value = '';
            if (alunoSearch) alunoSearch.value = '';
        }
        updateAlunoClear();
    };

    const ensureAlunosCache = async () => {
        if (state.alunosCache && state.alunosCache.length && Object.prototype.hasOwnProperty.call(state.alunosCache[0], 'turma_id')) return;
        const { data } = await safeQuery(
            db.from('alunos')
                .select('id, nome_completo, turma_id')
                .order('nome_completo', { ascending: true })
        );
        state.alunosCache = data || [];
    };

    openBtn.addEventListener('click', () => {
        modal.classList.remove('hidden');
        const tableBody = document.getElementById('apoia-relatorio-table-body');
        if (tableBody && !tableBody.children.length) {
            tableBody.innerHTML = '<tr><td colspan="5" class="p-4 text-center">Selecione o período e clique em Gerar Relatório.</td></tr>';
        }
        ensureAlunosCache().then(() => renderAlunoOptions());
    });

    closeBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.add('hidden');
    });

    if (alunoSearch) {
        alunoSearch.addEventListener('input', (e) => {
            const raw = String(e.target.value || '');
            const selectedId = alunoLookup.get(normalize(raw)) || '';
            if (alunoSelect) alunoSelect.value = selectedId;
            updateAlunoClear();
        });
    }

    if (alunoClear && alunoSearch) {
        alunoClear.addEventListener('click', () => {
            alunoSearch.value = '';
            if (alunoSelect) alunoSelect.value = '';
            updateAlunoClear();
            alunoSearch.focus();
        });
    }
}

export async function renderApoiaPanel(page = 1) {
    apoiaCurrentPage = page;
    bindApoiaRelatorioModal();
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
    const alunoId = document.getElementById('apoia-relatorio-aluno-select')?.value;
    const tableBody = document.getElementById('apoia-relatorio-table-body');
    const printBtn = document.getElementById('imprimir-apoia-relatorio-btn');
    const periodoEl = document.getElementById('apoia-relatorio-periodo-impressao');
    if (tableBody) {
        tableBody.innerHTML = '<tr><td colspan="5" class="p-4 text-center">Gerando relatório...</td></tr>';
    }
    if (printBtn) printBtn.classList.add('hidden');

    let queryBuilder = db
        .from('apoia_encaminhamentos')
        .select('aluno_id, data_encaminhamento, motivo, status, observacoes, alunos(nome_completo)')
        .order('data_encaminhamento');
    if (dataInicio) queryBuilder = queryBuilder.gte('data_encaminhamento', dataInicio);
    if (dataFim) queryBuilder = queryBuilder.lte('data_encaminhamento', dataFim);
    if (status) queryBuilder = queryBuilder.eq('status', status);
    if (alunoId) queryBuilder = queryBuilder.eq('aluno_id', alunoId);
    const { data, error } = await safeQuery(queryBuilder);
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

export async function renderProfessoresPanel(options = {}) {
    const silent = !!options.silent;
    const professoresTableBody = document.getElementById('professores-table-body');
    const searchInput = document.getElementById('professor-search-input');
    const statusFilterEl = document.getElementById('professor-status-filter');
    const vinculoFilterEl = document.getElementById('professor-vinculo-filter');
    const statusFilterValue = statusFilterEl?.value;
    const vinculoFilterValue = vinculoFilterEl?.value;
    bindProfessorSortHeaders();
    if (!silent) {
        professoresTableBody.innerHTML = '<tr><td colspan="7" class="p-4 text-center">Carregando...</td></tr>';
    } else if (!professoresTableBody.children.length) {
        professoresTableBody.innerHTML = '<tr><td colspan="7" class="p-4 text-center">Carregando...</td></tr>';
    }
    const { data, error } = await safeQuery(
        db.from('usuarios')
            .select('id, user_uid, nome, email, telefone, status, email_confirmado, vinculo')
            .eq('papel', 'professor')
    );
    if (error) {
        professoresTableBody.innerHTML = '<tr><td colspan="7" class="p-4 text-center text-red-500">Erro ao carregar.</td></tr>';
        return;
    }
    let filtered = await syncEmailConfirmations(data || []);
    if (statusFilterValue) {
        filtered = filtered.filter(p => p.status === statusFilterValue);
    }
    if (vinculoFilterValue) {
        filtered = filtered.filter(p => (p.vinculo || 'efetivo') === vinculoFilterValue);
    }
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
    const sorted = sortProfessores(filtered);
    professoresTableBody.innerHTML = sorted.map(p => {
        const telefoneDisplay = formatPhoneDisplay(p.telefone);
        const statusClass = p.status === 'ativo'
            ? 'bg-green-100 text-green-700'
            : 'bg-red-100 text-red-700';
        const confirmDot = p.email_confirmado ? 'bg-green-500' : 'bg-red-500';
        const confirmHtml = p.email_confirmado
            ? `<span class="inline-block w-3 h-3 rounded-full ${confirmDot}" title="Conta confirmada"></span>`
            : `<button type="button" class="resend-confirmation-btn inline-flex items-center justify-center" data-email="${p.email}" data-phone="${p.telefone || ''}" data-name="${(p.nome || '').replace(/"/g, '&quot;')}" title="Reenviar confirmação de conta">
                   <span class="inline-block w-3 h-3 rounded-full ${confirmDot}"></span>
               </button>`;
        const vinculoLabel = p.vinculo === 'act' ? 'ACT' : 'Efetivo';
        const vinculoClass = p.vinculo === 'act'
            ? 'bg-amber-100 text-amber-700'
            : 'bg-blue-100 text-blue-700';
        return `
        <tr>
            <td class="p-3">
                <span class="inline-flex items-center px-2 py-0.5 mr-2 text-xs font-semibold rounded-full ${vinculoClass}">${vinculoLabel}</span>
            </td>
            <td class="p-3">${p.nome}</td>
            <td class="p-3">${p.email}</td>
            <td class="p-3">${telefoneDisplay || '-'}</td>
            <td class="p-3"><span class="px-2 py-1 text-xs font-semibold rounded-full ${statusClass}">${p.status}</span></td>
            <td class="p-3 text-center">${confirmHtml}</td>
            <td class="p-3 space-x-4">
                <button class="text-blue-600 hover:underline edit-professor-btn" data-id="${p.id}">Editar</button>
            </td>
        </tr>
    `;
    }).join('');
}

function bindProfessorSortHeaders() {
    const panel = document.getElementById('admin-professores-panel');
    if (!panel) return;
    const headers = panel.querySelectorAll('th[data-sort]');
    if (!headers.length) return;
    headers.forEach(th => {
        if (th.dataset.sortBound === '1') return;
        th.dataset.sortBound = '1';
        th.addEventListener('click', () => {
            const key = th.dataset.sort;
            if (!key) return;
            if (professoresSort.key === key) {
                professoresSort.dir = professoresSort.dir === 'asc' ? 'desc' : 'asc';
            } else {
                professoresSort.key = key;
                professoresSort.dir = 'asc';
            }
            updateProfessorSortIndicators(headers);
            renderProfessoresPanel({ silent: true });
        });
    });
    updateProfessorSortIndicators(headers);
}

function updateProfessorSortIndicators(headers) {
    headers.forEach(th => {
        th.classList.remove('sorted-asc', 'sorted-desc');
        if (th.dataset.sort === professoresSort.key) {
            th.classList.add(professoresSort.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
        }
    });
}

function sortProfessores(list) {
    const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
    const getValue = (p) => {
        switch (professoresSort.key) {
            case 'email':
                return p.email || '';
            case 'telefone':
                return normalizePhoneDigits(p.telefone || '');
            case 'status':
                return p.status || '';
            case 'confirmacao':
                return p.email_confirmado ? 1 : 0;
            case 'vinculo':
                return p.vinculo || 'efetivo';
            case 'nome':
            default:
                return p.nome || '';
        }
    };
    const dir = professoresSort.dir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => {
        const valA = getValue(a);
        const valB = getValue(b);
        let cmp = 0;
        if (typeof valA === 'number' || typeof valB === 'number') {
            cmp = (Number(valA) || 0) - (Number(valB) || 0);
        } else {
            cmp = collator.compare(String(valA), String(valB));
        }
        if (cmp === 0) {
            cmp = collator.compare(a.nome || '', b.nome || '');
        }
        return cmp * dir;
    });
}

function formatDateTimeSP(value) {
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

function sortProfessorConsultaRows(rows) {
    const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
    const dir = professorConsultaSort.dir === 'desc' ? -1 : 1;
    return [...(rows || [])].sort((a, b) => {
        let cmp = 0;
        if (professorConsultaSort.key === 'email') {
            cmp = collator.compare(String(a.email || ''), String(b.email || ''));
        } else if (professorConsultaSort.key === 'evento') {
            cmp = (Number(a.eventoTs) || 0) - (Number(b.eventoTs) || 0);
        } else {
            cmp = collator.compare(String(a.nome || ''), String(b.nome || ''));
        }
        if (cmp !== 0) return cmp * dir;
        cmp = collator.compare(String(a.nome || ''), String(b.nome || ''));
        if (cmp !== 0) return cmp * dir;
        return collator.compare(String(a.email || ''), String(b.email || '')) * dir;
    });
}

function renderProfessorConsultaTable(tabKey) {
    const bodyIdMap = {
        criados: 'consulta-criados-body',
        confirmados: 'consulta-confirmados-body',
        'nao-confirmados': 'consulta-nao-confirmados-body'
    };
    const emptyMessageMap = {
        criados: 'Nenhum registro encontrado.',
        confirmados: 'Nenhum confirmado ainda.',
        'nao-confirmados': 'Nenhum não confirmado.'
    };
    const columnsMap = {
        criados: 3,
        confirmados: 3,
        'nao-confirmados': 4
    };
    const tbody = document.getElementById(bodyIdMap[tabKey]);
    if (!tbody) return;
    const rows = sortProfessorConsultaRows(professorConsultaRows[tabKey] || []);
    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="${columnsMap[tabKey] || 3}" class="p-4 text-center">${emptyMessageMap[tabKey]}</td></tr>`;
        return;
    }
    if (tabKey === 'nao-confirmados') {
        tbody.innerHTML = rows.map(item => {
            const emailAttr = String(item.email || '').replace(/"/g, '&quot;');
            const phoneAttr = String(item.telefone || '').replace(/"/g, '&quot;');
            const nameAttr = String(item.nome || '').replace(/"/g, '&quot;');
            return `
                <tr>
                    <td class="p-3">${item.nome || '-'}</td>
                    <td class="p-3">${item.email || '-'}</td>
                    <td class="p-3">${item.evento || '-'}</td>
                    <td class="p-3 text-center" data-print-hide="1">
                        <button type="button" class="resend-confirmation-btn inline-flex items-center justify-center" data-email="${emailAttr}" data-phone="${phoneAttr}" data-name="${nameAttr}" title="Reenviar confirmação de conta">
                            <span class="inline-block w-3 h-3 rounded-full bg-red-500"></span>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
        return;
    }
    tbody.innerHTML = rows.map(item => `
            <tr>
                <td class="p-3">${item.nome || '-'}</td>
                <td class="p-3">${item.email || '-'}</td>
                <td class="p-3">${item.evento || '-'}</td>
            </tr>
        `).join('');
}

function renderAllProfessorConsultaTables() {
    renderProfessorConsultaTable('criados');
    renderProfessorConsultaTable('confirmados');
    renderProfessorConsultaTable('nao-confirmados');
    updateProfessorConsultaTabCounts();
}

function updateProfessorConsultaTabCounts() {
    const tabButtons = document.querySelectorAll('#professor-consulta-modal .professor-consulta-tab');
    tabButtons.forEach(btn => {
        const tabKey = btn.dataset.consultaTab || '';
        const label = professorConsultaTabLabels[tabKey] || btn.textContent || '';
        const count = Array.isArray(professorConsultaRows[tabKey]) ? professorConsultaRows[tabKey].length : 0;
        btn.textContent = `${label} (${count})`;
    });
}

function updateProfessorConsultaSortIndicators() {
    const headers = document.querySelectorAll('#professor-consulta-modal .consulta-sortable-th');
    headers.forEach(th => {
        th.classList.remove('sorted-asc', 'sorted-desc');
        if (th.dataset.consultaSort === professorConsultaSort.key) {
            th.classList.add(professorConsultaSort.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
        }
    });
}

async function fetchAuthStatusByEmails(emails) {
    if (!emails || emails.length === 0) return [];
    const { data, error } = await safeQuery(
        db.rpc('auth_user_status_by_email', { p_emails: emails })
    );
    if (error) return [];
    return Array.isArray(data) ? data : [];
}

function setConsultaTab(activeTab) {
    const criadosPanel = document.getElementById('consulta-criados-panel');
    const confirmadosPanel = document.getElementById('consulta-confirmados-panel');
    const naoConfirmadosPanel = document.getElementById('consulta-nao-confirmados-panel');
    const modal = document.getElementById('professor-consulta-modal');
    const tabButtons = document.querySelectorAll('.professor-consulta-tab');
    tabButtons.forEach(btn => {
        const isActive = btn.dataset.consultaTab === activeTab;
        btn.classList.toggle('bg-blue-600', isActive);
        btn.classList.toggle('text-white', isActive);
        btn.classList.toggle('bg-gray-100', !isActive);
        btn.classList.toggle('text-gray-700', !isActive);
        btn.classList.toggle('hover:bg-gray-200', !isActive);
    });
    if (criadosPanel) criadosPanel.classList.toggle('hidden', activeTab !== 'criados');
    if (confirmadosPanel) confirmadosPanel.classList.toggle('hidden', activeTab !== 'confirmados');
    if (naoConfirmadosPanel) naoConfirmadosPanel.classList.toggle('hidden', activeTab !== 'nao-confirmados');
    if (modal) modal.dataset.activeTab = activeTab;
}

function bindProfessorConsultaModal() {
    const modal = document.getElementById('professor-consulta-modal');
    if (!modal || modal.dataset.bound === '1') return;
    modal.addEventListener('click', (e) => {
        const tabBtn = e.target.closest('.professor-consulta-tab');
        if (tabBtn) setConsultaTab(tabBtn.dataset.consultaTab);
        const sortBtn = e.target.closest('.consulta-sortable-th');
        if (sortBtn) {
            const key = sortBtn.dataset.consultaSort || 'nome';
            if (professorConsultaSort.key === key) {
                professorConsultaSort.dir = professorConsultaSort.dir === 'asc' ? 'desc' : 'asc';
            } else {
                professorConsultaSort.key = key;
                professorConsultaSort.dir = 'asc';
            }
            updateProfessorConsultaSortIndicators();
            renderAllProfessorConsultaTables();
        }
    });
    modal.dataset.bound = '1';
}

export async function openProfessorConsultaModal() {
    const modal = document.getElementById('professor-consulta-modal');
    if (!modal) return;
    bindProfessorConsultaModal();
    professorConsultaSort.key = 'nome';
    professorConsultaSort.dir = 'asc';
    professorConsultaRows.criados = [];
    professorConsultaRows.confirmados = [];
    professorConsultaRows['nao-confirmados'] = [];
    updateProfessorConsultaTabCounts();
    updateProfessorConsultaSortIndicators();
    setConsultaTab('criados');
    modal.classList.remove('hidden');

    const createdBody = document.getElementById('consulta-criados-body');
    const confirmedBody = document.getElementById('consulta-confirmados-body');
    const notConfirmedBody = document.getElementById('consulta-nao-confirmados-body');
    if (createdBody) createdBody.innerHTML = '<tr><td colspan="3" class="p-4 text-center">Carregando...</td></tr>';
    if (confirmedBody) confirmedBody.innerHTML = '<tr><td colspan="3" class="p-4 text-center">Carregando...</td></tr>';
    if (notConfirmedBody) notConfirmedBody.innerHTML = '<tr><td colspan="4" class="p-4 text-center">Carregando...</td></tr>';

    const { data: professores, error } = await safeQuery(
        db.from('usuarios')
            .select('nome, email, telefone, email_confirmado, status')
            .eq('papel', 'professor')
            .eq('status', 'ativo')
            .order('nome', { ascending: true })
    );
    if (error || !professores) {
        if (createdBody) createdBody.innerHTML = '<tr><td colspan="3" class="p-4 text-center text-red-500">Erro ao carregar dados.</td></tr>';
        if (confirmedBody) confirmedBody.innerHTML = '<tr><td colspan="3" class="p-4 text-center text-red-500">Erro ao carregar dados.</td></tr>';
        if (notConfirmedBody) notConfirmedBody.innerHTML = '<tr><td colspan="4" class="p-4 text-center text-red-500">Erro ao carregar dados.</td></tr>';
        return;
    }

    const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
    const syncedProfessores = await syncEmailConfirmations(professores || []);
    const emails = syncedProfessores.map(p => p.email).filter(Boolean);
    const statusData = await fetchAuthStatusByEmails(emails);
    const statusMap = new Map();
    statusData.forEach(item => statusMap.set(normalizeEmail(item.email), item));

    professorConsultaRows.criados = syncedProfessores.map(p => {
        const auth = statusMap.get(normalizeEmail(p.email));
        const createdAt = auth?.created_at ? formatDateTimeSP(auth.created_at) : '-';
        return {
            nome: p.nome || '-',
            email: p.email || '-',
            evento: createdAt,
            eventoTs: auth?.created_at ? new Date(auth.created_at).getTime() : 0,
            telefone: p.telefone || ''
        };
    });

    professorConsultaRows.confirmados = syncedProfessores
        .map(p => {
            const auth = statusMap.get(normalizeEmail(p.email));
            const confirmedAt = auth?.confirmed_at || auth?.email_confirmed_at;
            if (!p.email_confirmado) return null;
            return {
                nome: p.nome || '-',
                email: p.email || '-',
                evento: confirmedAt ? formatDateTimeSP(confirmedAt) : '-',
                eventoTs: confirmedAt ? new Date(confirmedAt).getTime() : 0,
                telefone: p.telefone || ''
            };
        })
        .filter(Boolean);

    professorConsultaRows['nao-confirmados'] = syncedProfessores
        .map(p => {
            const auth = statusMap.get(normalizeEmail(p.email));
            if (p.email_confirmado) return null;
            const createdAt = auth?.created_at ? formatDateTimeSP(auth.created_at) : '-';
            return {
                nome: p.nome || '-',
                email: p.email || '-',
                evento: createdAt,
                eventoTs: auth?.created_at ? new Date(auth.created_at).getTime() : 0,
                telefone: p.telefone || ''
            };
        })
        .filter(Boolean);

    renderAllProfessorConsultaTables();
}

export function handlePrintProfessorConsultaActiveTab() {
    const modal = document.getElementById('professor-consulta-modal');
    if (!modal) return;
    const activeTab = modal.dataset.activeTab || 'criados';

    const tabConfig = {
        criados: {
            panelId: 'consulta-criados-panel',
            title: 'Consulta de Professores - Criados'
        },
        confirmados: {
            panelId: 'consulta-confirmados-panel',
            title: 'Consulta de Professores - Confirmados'
        },
        'nao-confirmados': {
            panelId: 'consulta-nao-confirmados-panel',
            title: 'Consulta de Professores - Não confirmados'
        }
    };

    const config = tabConfig[activeTab] || tabConfig.criados;
    const panel = document.getElementById(config.panelId);
    const table = panel?.querySelector('table');
    if (!table) {
        showToast('Nenhum dado disponível para impressão.', true);
        return;
    }

    const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const logoUrl = new URL('./logo.png', window.location.href).href;
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    const printTable = table.cloneNode(true);
    printTable.querySelectorAll('[data-print-hide="1"]').forEach(el => el.remove());

    printWindow.document.write(`
        <html>
        <head>
            <title>${config.title}</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 16px; color: #111827; }
                .header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
                .logo { width: 34px; height: 34px; object-fit: contain; }
                h1 { font-size: 16px; margin: 0; }
                .meta { font-size: 11px; color: #6b7280; margin-bottom: 10px; }
                table { width: 100%; border-collapse: collapse; font-size: 13px; }
                th, td { border: 1px solid #d1d5db; padding: 4px 6px; text-align: left; line-height: 1.15; }
                th { background: #f3f4f6; font-weight: 700; }
                tbody tr:nth-child(even) td { background: #f8fafc; }
            </style>
        </head>
        <body>
            <div class="header">
                <img class="logo" src="${logoUrl}" alt="Logo">
                <h1>${config.title}</h1>
            </div>
            <div class="meta">Impresso em: ${now}</div>
            ${printTable.outerHTML}
            <script>window.onload = () => window.print();</script>
        </body>
        </html>
    `);
    printWindow.document.close();
}

async function syncEmailConfirmations(professores) {
    const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
    const emails = (professores || [])
        .map(p => normalizeEmail(p.email))
        .filter(Boolean);
    if (emails.length === 0) return professores;

    let data = null;
    let error = null;
    ({ data, error } = await safeQuery(
        db.rpc('auth_confirmed_by_email', { p_emails: emails })
    ));
    if (error || !Array.isArray(data)) {
        // Fallback para manter a bolinha coerente mesmo se a RPC principal falhar.
        const fallback = await fetchAuthStatusByEmails(emails);
        data = (fallback || []).map(item => ({
            email: normalizeEmail(item.email),
            confirmed: !!(item.confirmed_at || item.email_confirmed_at)
        }));
    }
    if (!Array.isArray(data) || data.length === 0) return professores;

    const confirmedByEmail = new Map();
    data.forEach(item => confirmedByEmail.set(normalizeEmail(item.email), !!item.confirmed));
    const toUpdateTrue = [];
    const toUpdateFalse = [];
    for (const professor of professores) {
        const emailKey = normalizeEmail(professor.email);
        if (!confirmedByEmail.has(emailKey)) continue;
        const confirmed = confirmedByEmail.get(emailKey) === true;
        if (confirmed && !professor.email_confirmado) {
            toUpdateTrue.push(professor.email);
        }
        if (!confirmed && professor.email_confirmado) {
            toUpdateFalse.push(professor.email);
        }
    }
    if (toUpdateTrue.length > 0) {
        await safeQuery(
            db.from('usuarios')
                .update({ email_confirmado: true })
                .in('email', toUpdateTrue)
        );
    }
    if (toUpdateFalse.length > 0) {
        await safeQuery(
            db.from('usuarios')
                .update({ email_confirmado: false })
                .in('email', toUpdateFalse)
        );
    }
    return professores.map(p => ({
        ...p,
        email_confirmado: confirmedByEmail.has(normalizeEmail(p.email))
            ? confirmedByEmail.get(normalizeEmail(p.email)) === true
            : !!p.email_confirmado
    }));
}

export async function openProfessorModal(editId = null) {
    const modal = document.getElementById('professor-modal');
    const form = document.getElementById('professor-form');
    const statusContainer = document.getElementById('status-field-container');
    const passwordContainer = document.getElementById('password-field-container');
    const vinculoSelect = document.getElementById('professor-vinculo');
    const passwordInput = document.getElementById('professor-password');
    const passwordToggle = document.getElementById('professor-password-show');
    const telefoneInput = document.getElementById('professor-telefone');
    const resetContainer = document.getElementById('professor-reset-container');
    const resetBtn = document.getElementById('professor-reset-password-btn');
    form.reset();
    form.dataset.originalEmail = '';
    form.dataset.userUid = '';
    document.getElementById('professor-id').value = '';
    document.getElementById('professor-modal-title').textContent = editId ? 'Editar Professor' : 'Adicionar Professor';
    document.getElementById('professor-delete-container').classList.toggle('hidden', !editId);
    if (resetContainer) resetContainer.classList.toggle('hidden', !editId);
    if (resetBtn) resetBtn.dataset.email = '';
    if (statusContainer) statusContainer.classList.toggle('hidden', !editId);
    if (passwordContainer) passwordContainer.classList.toggle('hidden', !!editId);
    if (passwordInput) passwordInput.type = 'password';
    if (passwordToggle) passwordToggle.checked = false;
    if (passwordInput && !editId) passwordInput.value = '123456';
    if (vinculoSelect) vinculoSelect.value = 'efetivo';
    if (editId) {
        const { data } = await safeQuery(db.from('usuarios').select('*').eq('id', editId).single());
        if (data) {
            document.getElementById('professor-id').value = data.id;
            document.getElementById('professor-nome').value = data.nome;
            document.getElementById('professor-email').value = data.email;
            document.getElementById('professor-status').value = data.status || 'ativo';
            if (telefoneInput) telefoneInput.value = formatPhoneDisplay(data.telefone) || '';
            if (vinculoSelect) vinculoSelect.value = data.vinculo || 'efetivo';
            form.dataset.originalEmail = data.email || '';
            form.dataset.userUid = data.user_uid || '';
            if (resetBtn) resetBtn.dataset.email = data.email || '';
        }
    }
    modal.classList.remove('hidden');
}

export async function handleProfessorFormSubmit(e) {
    const id = document.getElementById('professor-id').value;
    const nome = String(document.getElementById('professor-nome').value || '').trim();
    const email = String(document.getElementById('professor-email').value || '').trim().toLowerCase();
    const status = document.getElementById('professor-status').value || 'ativo';
    const vinculo = document.getElementById('professor-vinculo')?.value || 'efetivo';
    const telefoneRaw = document.getElementById('professor-telefone')?.value || '';
    const telefone = normalizePhoneDigits(telefoneRaw);
    const form = document.getElementById('professor-form');
    if (id) {
        const { data: duplicateEmail, error: duplicateEmailError } = await safeQuery(
            db.from('usuarios')
                .select('id')
                .eq('papel', 'professor')
                .eq('email', email)
                .neq('id', id)
                .limit(1)
        );
        if (duplicateEmailError) {
            showToast('Erro ao validar e-mail de professor: ' + duplicateEmailError.message, true);
            return;
        }
        if (duplicateEmail && duplicateEmail.length > 0) {
            showToast('Já existe professor com esse e-mail.', true);
            return;
        }

        const originalEmail = (form?.dataset?.originalEmail || '').trim().toLowerCase();
        const nextEmail = (email || '').trim().toLowerCase();
        let authUserUid = form?.dataset?.userUid || '';
        if (!authUserUid && originalEmail) {
            authUserUid = await fetchAuthUserUidByEmail(originalEmail);
        }
        const shouldUpdateAuthEmail = nextEmail && originalEmail && nextEmail !== originalEmail;
        if (shouldUpdateAuthEmail) {
            const existingAuthUid = await fetchAuthUserUidByEmail(nextEmail);
            if (existingAuthUid && existingAuthUid !== authUserUid) {
                showToast('Este e-mail já está em uso por outro professor.', true);
                return;
            }
        }
        if (shouldUpdateAuthEmail && !authUserUid) {
            showToast('Nao foi possivel localizar o usuario de login para atualizar o email.', true);
            return;
        }
        if (shouldUpdateAuthEmail && authUserUid) {
            try {
                await updateAuthEmail(authUserUid, nextEmail);
            } catch (err) {
                showToast(`Erro ao atualizar email do login: ${err?.message || err}`, true);
                return;
            }
        }
        const { error } = await safeQuery(db.from('usuarios').update({ nome, email, status, vinculo, telefone }).eq('id', id));
        if (error) showToast('Erro ao salvar professor: ' + error.message, true);
        else {
            await logAudit('update', 'professor', id, { nome, email, status, vinculo, telefone });
            showToast('Professor salvo com sucesso!');
            closeAllModals();
            await renderProfessoresPanel();
        }
    } else {
        const { data: existingProfessor } = await safeQuery(
            db.from('usuarios')
                .select('id, status')
                .eq('email', email)
                .eq('papel', 'professor')
                .maybeSingle()
        );
        if (existingProfessor) {
            if (existingProfessor.status === 'ativo') {
                showToast('Professor já cadastrado. Use a opção Editar para ajustar os dados.', true);
                return;
            }
        const { error: reactivateError } = await safeQuery(
            db.from('usuarios')
                .update({ nome, email, status: 'ativo', vinculo, telefone, precisa_trocar_senha: true, senha_aviso_count: 0 })
                .eq('id', existingProfessor.id)
        );
            if (reactivateError) {
                showToast('Erro ao reativar professor: ' + reactivateError.message, true);
                return;
            }
            await logAudit('reactivate', 'professor', existingProfessor.id, { nome, email, vinculo, telefone });
            const { error: confirmError } = await sendProfessorSignupConfirmation(email);
            const { error: resetError } = await db.auth.resetPasswordForEmail(email, { redirectTo: getAuthRedirectUrl() });
            if (confirmError && resetError) {
                showToast('Professor reativado, mas falhou envio de confirmação e redefinição: ' + confirmError.message, true);
            } else if (confirmError) {
                showToast('Professor reativado. Link de senha enviado, mas falhou confirmação de conta: ' + confirmError.message, true);
            } else if (resetError) {
                showToast('Professor reativado. Confirmação enviada, mas falhou link de senha: ' + resetError.message, true);
            } else {
                showToast('Professor reativado com sucesso! Confirmação de conta e link para criar senha enviados.');
            }
            closeAllModals();
            await renderProfessoresPanel();
            return;
        }
        const tempPassword = document.getElementById('professor-password')?.value?.trim();
        if (tempPassword && tempPassword.length < 6) {
            showToast('A senha temporária deve ter pelo menos 6 caracteres.', true);
            return;
        }
        const initialPassword = tempPassword || '123456';
        const existingUid = await fetchAuthUserUidByEmail(email);
        if (!existingUid) {
            const { data: authData, error: authError } = await db.auth.signUp({ email, password: initialPassword });
            if (authError) {
                showToast('Erro ao criar usuário: ' + authError.message, true);
                return;
            }
            const { data: profileData, error: profileError } = await safeQuery(
                db.from('usuarios').insert({ user_uid: authData.user.id, nome: nome, email: email, papel: 'professor', status: 'ativo', vinculo, telefone, email_confirmado: false, precisa_trocar_senha: true, senha_aviso_count: 0 }).select().single()
            );
            if (profileError) showToast('Erro ao salvar professor: ' + profileError.message, true);
            else {
                await logAudit('create', 'professor', profileData?.id || authData.user.id, { nome, email, status: 'ativo', vinculo, telefone });
                const { error: confirmError } = await sendProfessorSignupConfirmation(email);
                const { error: resetError } = await db.auth.resetPasswordForEmail(email, { redirectTo: getAuthRedirectUrl() });
                if (confirmError && resetError) {
                    showToast('Professor criado, mas falhou envio de confirmação e redefinição: ' + confirmError.message, true);
                } else if (confirmError) {
                    showToast('Professor criado. Link de senha enviado, mas falhou confirmação de conta: ' + confirmError.message, true);
                } else if (resetError) {
                    showToast('Professor criado. Confirmação enviada, mas falhou link de senha: ' + resetError.message, true);
                } else {
                    showToast('Professor criado com sucesso! Confirmação de conta e link para criar senha enviados.');
                }
                closeAllModals();
                await renderProfessoresPanel();
            }
            return;
        }
        const { data: profileData, error: profileError } = await upsertProfessorProfile(existingUid, { nome, email, vinculo, telefone });
        if (profileError) {
            showToast('Erro ao reativar professor: ' + profileError.message, true);
            return;
        }
        await logAudit('reactivate', 'professor', profileData?.id || null, { nome, email, vinculo, telefone });
        const { error: confirmError } = await sendProfessorSignupConfirmation(email);
        const { error: resetError } = await db.auth.resetPasswordForEmail(email, { redirectTo: getAuthRedirectUrl() });
        if (confirmError && resetError) {
            showToast('Professor reativado, mas falhou envio de confirmação e redefinição: ' + confirmError.message, true);
        } else if (confirmError) {
            showToast('Professor reativado. Link de senha enviado, mas falhou confirmação de conta: ' + confirmError.message, true);
        } else if (resetError) {
            showToast('Professor reativado. Confirmação enviada, mas falhou link de senha: ' + resetError.message, true);
        } else {
            showToast('Professor reativado com sucesso! Confirmação de conta e link para criar senha enviados.');
        }
        closeAllModals();
        await renderProfessoresPanel();
        return;
    }
}

export async function handleResetPassword(email) {
    const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: getAuthRedirectUrl() });
    if (error) showToast('Erro ao enviar email de recuperação: ' + error.message, true);
    else showToast('Email de redefinicao enviado!');
}

export async function handleResendProfessorConfirmation(email, phone = '', name = '') {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) {
        showToast('Email inválido para reenvio de confirmação.', true);
        return;
    }

    const { error } = await db.auth.resend({
        type: 'signup',
        email: normalizedEmail,
        options: { emailRedirectTo: getAuthRedirectUrl() }
    });

    if (error) {
        showToast('Erro ao reenviar confirmação: ' + error.message, true);
        return;
    }

    const { actionLink, error: linkError } = await generateProfessorAccessLink(normalizedEmail);

    const digits = normalizePhoneDigits(phone || '');
    if (digits.length < 10) {
        showToast('Email reenviado. Telefone ausente/inválido para abrir WhatsApp.');
        return;
    }

    const nomeParte = (name || '').trim() ? `${String(name).trim()}, ` : '';
    const linkParte = actionLink
        ? `\n\nLink de ativacao: ${actionLink}`
        : '\n\nNão consegui anexar o link automaticamente. Use o link recebido por email.';
    const msg = `${nomeParte}segue seu link de ativacao da conta no Sistema de chamadas da EEB Getulio Vargas.${linkParte}\n\nUse seu email cadastrado (${normalizedEmail}) para concluir o acesso.\n\nSe voce ja concluiu a ativacao, ignore esta mensagem.`;
    const encodedMsg = encodeURIComponent(msg);
    const appUrl = `whatsapp://send?phone=55${digits}&text=${encodedMsg}`;
    const webUrl = `https://wa.me/55${digits}?text=${encodedMsg}`;

    let openedViaApp = false;
    const onVisibilityChange = () => {
        if (document.visibilityState === 'hidden') {
            openedViaApp = true;
            document.removeEventListener('visibilitychange', onVisibilityChange);
        }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    // Tenta abrir o app instalado; se não abrir, cai para o WhatsApp Web.
    window.location.href = appUrl;
    setTimeout(() => {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        if (!openedViaApp) {
            window.open(webUrl, '_blank', 'noopener');
        }
    }, 900);

    if (linkError) {
        showToast(`Email reenviado. WhatsApp aberto, mas o link não foi anexado automaticamente: ${linkError}`);
    } else {
        showToast('Email reenviado e mensagem preparada no WhatsApp com link de ativação.');
    }
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
        const profs = (t.professores_turmas || [])
            .map(p => p.usuarios?.nome)
            .filter(Boolean)
            .sort((a, b) => String(a).localeCompare(String(b), 'pt-BR', { sensitivity: 'base' }))
            .join(', ') || '-';
        return `
            <tr>
                <td class="p-3">${t.nome_turma}</td>
                <td class="p-3">${profs}</td>
                <td class="p-3">
                    <button class="text-blue-600 hover:underline edit-turma-btn" data-id="${t.id}">Editar</button>
                </td>
            </tr>
        `;
    }).join('');
}

export async function openTurmaModal(editId = null) {
    const modal = document.getElementById('turma-modal');
    const form = document.getElementById('turma-form');
    const nomeInput = document.getElementById('turma-nome');
    const anoInput = document.getElementById('turma-ano-letivo');
    const editWarning = document.getElementById('turma-edit-warning');
    form.reset();
    document.getElementById('turma-id').value = '';
    document.getElementById('turma-modal-title').textContent = editId ? 'Editar Turma' : 'Adicionar Turma';
    document.getElementById('turma-delete-container').classList.toggle('hidden', !editId);
    if (editWarning) editWarning.classList.add('hidden');
    if (nomeInput) {
        nomeInput.readOnly = false;
        nomeInput.classList.remove('bg-gray-100', 'text-gray-500');
    }
    if (anoInput) {
        anoInput.readOnly = false;
        anoInput.classList.remove('bg-gray-100', 'text-gray-500');
    }

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
            if (nomeInput) {
                nomeInput.value = data.nome_turma;
                nomeInput.readOnly = true;
                nomeInput.classList.add('bg-gray-100', 'text-gray-500');
            }
            if (anoInput) {
                anoInput.value = data.ano_letivo;
                anoInput.readOnly = true;
                anoInput.classList.add('bg-gray-100', 'text-gray-500');
            }
            form.dataset.originalNome = data.nome_turma;
            form.dataset.originalAno = data.ano_letivo;
            if (editWarning) editWarning.classList.remove('hidden');
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
    const form = document.getElementById('turma-form');
    const nomeInput = document.getElementById('turma-nome');
    const anoInput = document.getElementById('turma-ano-letivo');
    const nome = (id && form?.dataset.originalNome) ? form.dataset.originalNome : nomeInput.value;
    const ano_letivo = (id && form?.dataset.originalAno) ? form.dataset.originalAno : anoInput.value;
    const professoresSelecionados = Array.from(document.querySelectorAll('.turma-professor-checkbox:checked')).map(cb => cb.value);
    const rels = professoresSelecionados.map(profId => ({ turma_id: id ? parseInt(id) : null, professor_id: profId }));
    const turmasScrollWrap = document.querySelector('#admin-turmas-panel .admin-card-scroll');
    const savedScrollTop = id && turmasScrollWrap ? turmasScrollWrap.scrollTop : 0;

    let duplicateTurmaQuery = db.from('turmas')
        .select('id')
        .eq('nome_turma', nome)
        .eq('ano_letivo', ano_letivo)
        .limit(1);
    if (id) duplicateTurmaQuery = duplicateTurmaQuery.neq('id', id);
    const { data: duplicateTurma, error: duplicateTurmaError } = await safeQuery(duplicateTurmaQuery);
    if (duplicateTurmaError) {
        showToast('Erro ao validar duplicidade de turma: ' + duplicateTurmaError.message, true);
        return;
    }
    if (duplicateTurma && duplicateTurma.length > 0) {
        showToast('Já existe turma com esse nome no mesmo ano letivo.', true);
        return;
    }

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
    if (id && turmasScrollWrap) {
        turmasScrollWrap.scrollTop = savedScrollTop;
    }
}

// ===============================================================
// ADMIN - RELATORIOS
// ===============================================================

function formatRelatorioDateBrDash(value) {
    if (!value) return '';
    const raw = String(value).trim();
    const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return `${isoMatch[3]}-${isoMatch[2]}-${isoMatch[1]}`;
    const slashMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (slashMatch) return `${slashMatch[1]}-${slashMatch[2]}-${slashMatch[3]}`;
    const dateObj = new Date(raw);
    if (!Number.isNaN(dateObj.getTime())) {
        const dd = String(dateObj.getDate()).padStart(2, '0');
        const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
        const yyyy = dateObj.getFullYear();
        return `${dd}-${mm}-${yyyy}`;
    }
    return raw;
}

function formatRelatorioHora(value) {
    return value ? new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '-';
}

function normalizeRelatorioHeaderLabel(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
}

function updateRelatoriosSortIndicators(headers) {
    const headerList = headers || document.querySelectorAll('#admin-relatorios-panel #relatorio-resultados thead th[data-sort]');
    headerList.forEach((th) => {
        th.classList.remove('sorted-asc', 'sorted-desc');
        if (th.dataset.sort === relatoriosSort.key) {
            th.classList.add(relatoriosSort.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
        }
    });
}

function sortRelatoriosRows(list) {
    const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
    const dir = relatoriosSort.dir === 'desc' ? -1 : 1;
    const toTs = (value) => {
        if (!value) return 0;
        const v = String(value);
        if (/^\d{4}-\d{2}-\d{2}/.test(v)) return new Date(`${v.slice(0, 10)}T00:00:00`).getTime();
        if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(v)) {
            const parts = v.replace(/\//g, '-').split('-');
            return new Date(`${parts[2]}-${parts[1]}-${parts[0]}T00:00:00`).getTime();
        }
        const ts = new Date(v).getTime();
        return Number.isNaN(ts) ? 0 : ts;
    };
    const getValue = (r) => {
        switch (relatoriosSort.key) {
            case 'data':
                return toTs(r.data);
            case 'hora':
                return r.registrado_em ? new Date(r.registrado_em).getTime() : 0;
            case 'aluno':
                return r.alunos?.nome_completo || '';
            case 'turma':
                return r.turmas?.nome_turma || '';
            case 'status':
                return r.status || '';
            case 'justificativa':
                return r.justificativa || '';
            case 'registrado_por':
                return r.usuarios?.nome || '';
            default:
                return '';
        }
    };
    return [...(list || [])].sort((a, b) => {
        const valA = getValue(a);
        const valB = getValue(b);
        let cmp = 0;

        if (typeof valA === 'number' || typeof valB === 'number') {
            cmp = (Number(valA) || 0) - (Number(valB) || 0);
        } else {
            cmp = collator.compare(String(valA), String(valB));
        }

        if (cmp === 0 && relatoriosSort.key !== 'turma') {
            cmp = collator.compare(String(a.turmas?.nome_turma || ''), String(b.turmas?.nome_turma || ''));
        }
        if (cmp === 0 && relatoriosSort.key !== 'aluno') {
            cmp = collator.compare(String(a.alunos?.nome_completo || ''), String(b.alunos?.nome_completo || ''));
        }
        if (cmp === 0) {
            cmp = (toTs(a.data) - toTs(b.data));
        }
        return cmp * dir;
    });
}

function renderRelatoriosRowsFromCache() {
    const relatorioTableBody = document.getElementById('relatorio-table-body');
    if (!relatorioTableBody) return;
    if (!Array.isArray(relatoriosRowsCache) || relatoriosRowsCache.length === 0) return;
    const sortedRows = sortRelatoriosRows(relatoriosRowsCache);
    relatorioTableBody.innerHTML = sortedRows.map((r) => `
        <tr>
            <td class="p-3">${formatRelatorioDateBrDash(r.data) || '-'}</td>
            <td class="p-3">${formatRelatorioHora(r.registrado_em)}</td>
            <td class="p-3">${r.alunos?.nome_completo || ''}</td>
            <td class="p-3">${r.turmas?.nome_turma || ''}</td>
            <td class="p-3">${r.status || ''}</td>
            <td class="p-3">${r.justificativa || '-'}</td>
            <td class="p-3">${r.usuarios?.nome || ''}</td>
        </tr>
    `).join('');
}

function bindRelatoriosSortHeaders() {
    const panel = document.getElementById('admin-relatorios-panel');
    if (!panel) return;
    const headers = panel.querySelectorAll('#relatorio-resultados thead th');
    if (!headers.length) return;

    const headerMap = {
        data: 'data',
        hora: 'hora',
        aluno: 'aluno',
        turma: 'turma',
        status: 'status',
        justificativa: 'justificativa',
        'registrado por': 'registrado_por'
    };

    headers.forEach((th) => {
        const text = normalizeRelatorioHeaderLabel(th.textContent || '');
        const key = headerMap[text];
        if (!key) return;
        th.dataset.sort = key;
        th.classList.add('sortable-th');
        if (!th.querySelector('.sort-indicator')) {
            const indicator = document.createElement('span');
            indicator.className = 'sort-indicator';
            th.appendChild(indicator);
        }
        if (th.dataset.sortBound === '1') return;
        th.dataset.sortBound = '1';
        th.addEventListener('click', () => {
            if (relatoriosSort.key === key) {
                relatoriosSort.dir = relatoriosSort.dir === 'asc' ? 'desc' : 'asc';
            } else {
                relatoriosSort.key = key;
                relatoriosSort.dir = (key === 'data' || key === 'hora') ? 'desc' : 'asc';
            }
            updateRelatoriosSortIndicators(headers);
            renderRelatoriosRowsFromCache();
        });
    });
    updateRelatoriosSortIndicators(headers);
}

export async function renderRelatoriosPanel() {
    const panel = document.getElementById('admin-relatorios-panel');
    const turmaFilter = document.getElementById('relatorio-turma-select');
    const alunoFilter = document.getElementById('relatorio-aluno-select');
    const profFilter = document.getElementById('relatorio-professor-select');
    if (!panel || !turmaFilter || !alunoFilter || !profFilter) return;

    const filtrosCard = panel.querySelector(':scope > .bg-white.p-6.rounded-lg.shadow-md');
    const resultadosCard = document.getElementById('relatorio-resultados');
    const topBar = panel.querySelector(':scope > .flex.justify-between.items-center.mb-4');
    const gerarBtn = document.getElementById('gerar-relatorio-btn');
    const limparBtn = document.getElementById('limpar-relatorio-btn');

    if (topBar && gerarBtn && limparBtn) {
        topBar.classList.add('relatorios-top-bar');
        let actions = topBar.querySelector('.relatorios-top-actions');
        if (!actions) {
            actions = document.createElement('div');
            actions.className = 'relatorios-top-actions';
            topBar.appendChild(actions);
        }
        gerarBtn.classList.remove('w-full');
        limparBtn.classList.remove('w-full');
        gerarBtn.classList.add('relatorios-top-btn');
        limparBtn.classList.add('relatorios-top-btn');
        if (gerarBtn.parentElement !== actions) actions.appendChild(gerarBtn);
        if (limparBtn.parentElement !== actions) actions.appendChild(limparBtn);
    }

    if (filtrosCard && resultadosCard) {
        const grids = filtrosCard.querySelectorAll(':scope > .grid');
        if (grids[0]) {
            grids[0].classList.add('relatorios-filtros-grid');
        }
        if (grids[1]) {
            grids[1].classList.add('relatorios-acoes-grid');
        }

        resultadosCard.classList.remove('bg-white', 'p-6', 'rounded-lg', 'shadow-md', 'mt-6');
        resultadosCard.classList.add('relatorios-resultados-section');

        if (resultadosCard.parentElement !== filtrosCard) {
            filtrosCard.appendChild(resultadosCard);
        }
    }

    const professores = state.usuariosCache.filter(u => u.papel === 'professor');
    const signature = [
        state.turmasCache.length,
        state.alunosCache.length,
        professores.length,
        state.turmasCache[0]?.id ?? '',
        state.alunosCache[0]?.id ?? '',
        professores[0]?.user_uid ?? ''
    ].join('|');

    if (signature === relatoriosPanelSignature) {
        bindRelatoriosSortHeaders();
        return;
    }
    relatoriosPanelSignature = signature;

    const turmaOptions = ['<option value="">Todas</option>'];
    for (const turma of state.turmasCache) {
        turmaOptions.push(`<option value="${turma.id}">${turma.nome_turma}</option>`);
    }

    const alunoOptions = ['<option value="">Todos</option>'];
    for (const aluno of state.alunosCache) {
        alunoOptions.push(`<option value="${aluno.id}">${aluno.nome_completo}</option>`);
    }

    const profOptions = ['<option value="">Todos</option>'];
    for (const professor of professores) {
        profOptions.push(`<option value="${professor.user_uid}">${professor.nome}</option>`);
    }

    turmaFilter.innerHTML = turmaOptions.join('');
    alunoFilter.innerHTML = alunoOptions.join('');
    profFilter.innerHTML = profOptions.join('');
    bindRelatoriosSortHeaders();
}

// ===============================================================
// ADMIN - CHAMADAS
// ===============================================================

function formatChamadasDateDisplay(value) {
    if (!value) return '';
    return new Date(`${value}T00:00:00`).toLocaleDateString('pt-BR');
}

function formatChamadasFullDateDisplay(value) {
    if (!value) return '';
    return new Date(`${value}T00:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatChamadasTimeDisplay(value) {
    return value ? new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '-';
}

function formatChamadasDateTimeDisplay(value) {
    if (!value) return '-';
    const dt = new Date(value);
    const date = dt.toLocaleDateString('pt-BR');
    const time = dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `${date} ${time}`;
}

function syncChamadasCalendarToSelection() {
    if (!chamadasStartDate) return;
    const base = new Date(`${chamadasStartDate}T00:00:00`);
    chamadasCalendar = { month: base.getMonth(), year: base.getFullYear() };
}

function ensureChamadasDefaults(options = {}) {
    const { defaultToLatestYear = false } = options;
    if (!chamadasDateCleared && !chamadasStartDate) {
        chamadasStartDate = getLocalDateString();
        chamadasEndDate = null;
    }
    if (defaultToLatestYear && Array.isArray(state.anosLetivosCache) && state.anosLetivosCache.length > 0) {
        const defaultAno = String(state.anosLetivosCache[0]);
        chamadasAnoLetivo = defaultAno;
        chamadasAnoSearch = defaultAno;
        chamadasCurrentPage = 1;
        chamadasCacheKey = '';
    }
    syncChamadasCalendarToSelection();
}

function updateChamadasPeriodoLabel() {
    const label = document.getElementById('chamadas-periodo-label');
    const clearBtn = document.getElementById('chamadas-periodo-clear');
    if (!label) return;
    if (chamadasStartDate && chamadasEndDate) {
        label.textContent = `${formatChamadasDateDisplay(chamadasStartDate)} - ${formatChamadasDateDisplay(chamadasEndDate)}`;
        if (clearBtn) clearBtn.classList.remove('opacity-30');
    } else if (chamadasStartDate) {
        label.textContent = formatChamadasDateDisplay(chamadasStartDate);
        if (clearBtn) clearBtn.classList.remove('opacity-30');
    } else {
        label.textContent = 'Sem filtro de data';
        if (clearBtn) clearBtn.classList.add('opacity-30');
    }
}

function renderChamadasCalendar() {
    const grid = document.getElementById('chamadas-calendar-grid');
    const monthYearEl = document.getElementById('chamadas-month-year');
    if (!grid || !monthYearEl) return;
    const monthNames = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    const { month, year } = chamadasCalendar;
    monthYearEl.textContent = `${monthNames[month]} ${year}`;

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startDateObj = chamadasStartDate ? new Date(`${chamadasStartDate}T00:00:00`) : null;
    const endDateObj = chamadasEndDate ? new Date(`${chamadasEndDate}T00:00:00`) : null;

    let html = '';
    for (let i = 0; i < firstDay; i++) html += '<div></div>';
    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dateObj = new Date(`${dateStr}T00:00:00`);
        const isWeekend = [0, 6].includes(dateObj.getDay());
        const isStart = !!startDateObj && dateStr === chamadasStartDate;
        const isEnd = !!endDateObj && dateStr === chamadasEndDate;
        const isRange = !!startDateObj && !!endDateObj && dateObj >= startDateObj && dateObj <= endDateObj;
        const rangeClass = isRange && !isStart && !isEnd ? 'calendar-day-range' : '';
        const startClass = isStart ? 'calendar-day-start' : '';
        const endClass = isEnd ? 'calendar-day-end' : '';
        html += `
            <div class="calendar-day-container chamadas-calendar-day ${rangeClass} ${startClass} ${endClass}" data-date="${dateStr}">
                <div class="calendar-day-content ${isWeekend ? 'calendar-day-weekend' : ''}">
                    <span class="calendar-day-number">${day}</span>
                </div>
            </div>
        `;
    }
    grid.innerHTML = html;
}

function buildChamadasQueryKey() {
    return `${chamadasStartDate || ''}|${chamadasEndDate || ''}|${chamadasProfessorId || ''}|${(chamadasProfessorSearch || '').toLowerCase()}|${chamadasTurmaId || ''}|${(chamadasTurmaSearch || '').toLowerCase()}|${chamadasRegistroFilter || ''}|${(chamadasRegistroSearch || '').toLowerCase()}|${chamadasAnoLetivo || ''}|${(chamadasAnoSearch || '').toLowerCase()}`;
}

async function loadChamadasData() {
    const key = buildChamadasQueryKey();
    if (key === chamadasCacheKey) return { data: chamadasCacheRows };

    let query = db.from('presencas')
        .select('data, registrado_em, status, justificativa, turma_id, registrado_por_uid, turmas ( nome_turma, ano_letivo ), usuarios ( nome, email )');

    if (chamadasProfessorId) query = query.eq('registrado_por_uid', chamadasProfessorId);
    if (chamadasStartDate && chamadasEndDate) {
        query = query.gte('data', chamadasStartDate).lte('data', chamadasEndDate);
    } else if (chamadasStartDate) {
        query = query.eq('data', chamadasStartDate);
    }

    query = query.order('data', { ascending: false }).order('registrado_em', { ascending: false });

    const { data, error } = await safeQuery(query);
    if (error) return { data: [], error };

    const grupos = new Map();
    (data || []).forEach((row) => {
        const keyItem = `${row.data}|${row.turma_id}|${row.registrado_por_uid || 'null'}`;
        const existing = grupos.get(keyItem) || {
            data: row.data,
            turmaId: row.turma_id,
            turma: row.turmas?.nome_turma || '-',
            anoLetivo: row.turmas?.ano_letivo || '',
            professor: row.usuarios?.nome || '-',
            professorEmail: row.usuarios?.email || '',
            professorId: row.registrado_por_uid || '',
            registradoEm: row.registrado_em,
            presentes: 0,
            faltasJustificadas: 0,
            faltasInjustificadas: 0
        };
        if (row.status === 'presente') existing.presentes += 1;
        if (row.status === 'falta') {
            if (row.justificativa === 'Falta justificada') existing.faltasJustificadas += 1;
            else existing.faltasInjustificadas += 1;
        }
        if (!existing.registradoEm || (row.registrado_em && row.registrado_em > existing.registradoEm)) {
            existing.registradoEm = row.registrado_em;
        }
        grupos.set(keyItem, existing);
    });

    let rows = Array.from(grupos.values()).sort((a, b) => {
        if (a.data !== b.data) return a.data < b.data ? 1 : -1;
        if (!a.registradoEm && b.registradoEm) return 1;
        if (a.registradoEm && !b.registradoEm) return -1;
        if (!a.registradoEm && !b.registradoEm) return 0;
        return a.registradoEm < b.registradoEm ? 1 : -1;
    });

    const { data: auditLogs } = await safeQuery(
        db.from('audit_logs')
            .select('created_at, user_uid, details')
            .eq('action', 'chamada_correcao')
            .eq('entity', 'presencas')
    );
    const adjustedKeys = new Set();
    const adjustmentsMap = new Map();
    const adjustmentUsers = new Set();
    (auditLogs || []).forEach(log => {
        const details = log.details || {};
        const turmaId = details.turma_id || details.turmaId;
        const dataVal = details.data || details.data_chamada || details.date;
        if (turmaId && dataVal) {
            adjustedKeys.add(`${turmaId}|${dataVal}`);
            const key = `${turmaId}|${dataVal}`;
            const list = adjustmentsMap.get(key) || [];
            list.push({ user_uid: log.user_uid, created_at: log.created_at });
            adjustmentsMap.set(key, list);
            if (log.user_uid) adjustmentUsers.add(log.user_uid);
        }
    });

    const userNameMap = new Map();
    state.usuariosCache.forEach(u => userNameMap.set(u.user_uid, u.nome));
    const missingUsers = Array.from(adjustmentUsers).filter(uid => uid && !userNameMap.has(uid));
    if (missingUsers.length > 0) {
        const { data: extraUsers } = await safeQuery(
            db.from('usuarios')
                .select('user_uid, nome')
                .in('user_uid', missingUsers)
        );
        (extraUsers || []).forEach(u => userNameMap.set(u.user_uid, u.nome));
    }

    rows = rows.map(r => ({
        ...r,
        adjusted: adjustedKeys.has(`${r.turmaId}|${r.data}`),
        adjustments: (adjustmentsMap.get(`${r.turmaId}|${r.data}`) || [])
            .map(a => ({
                ...a,
                nome: userNameMap.get(a.user_uid) || (a.user_uid ? `UID ${a.user_uid}` : 'Desconhecido')
            }))
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    }));

    const search = (chamadasProfessorSearch || '').trim().toLowerCase();
    if (!chamadasProfessorId && search) {
        rows = rows.filter(r =>
            (r.professor || '').toLowerCase().includes(search) ||
            (r.professorEmail || '').toLowerCase().includes(search)
        );
    }

    if (chamadasTurmaId) {
        rows = rows.filter(r => String(r.turmaId) === String(chamadasTurmaId));
    } else if (chamadasTurmaSearch) {
        rows = rows.filter(r => (r.turma || '').toLowerCase().includes(chamadasTurmaSearch));
    }
    if (chamadasRegistroFilter) {
        rows = rows.filter(r => chamadasRegistroFilter === 'alterada' ? r.adjusted : !r.adjusted);
    }
    if (chamadasAnoLetivo) {
        rows = rows.filter(r => String(r.anoLetivo) === String(chamadasAnoLetivo));
    } else if (chamadasAnoSearch) {
        rows = rows.filter(r => String(r.anoLetivo || '').includes(chamadasAnoSearch));
    }

    chamadasCacheKey = key;
    chamadasCacheRows = rows;
    return { data: rows };
}

function bindChamadasSortHeaders() {
    const panel = document.getElementById('admin-chamadas-panel');
    if (!panel) return;
    const headers = panel.querySelectorAll('th[data-sort]');
    if (!headers.length) return;
    headers.forEach(th => {
        if (th.dataset.sortBound === '1') return;
        th.dataset.sortBound = '1';
        th.addEventListener('click', () => {
            const key = th.dataset.sort;
            if (!key) return;
            if (chamadasSort.key === key) {
                chamadasSort.dir = chamadasSort.dir === 'asc' ? 'desc' : 'asc';
            } else {
                chamadasSort.key = key;
                chamadasSort.dir = key === 'data' ? 'desc' : 'asc';
            }
            updateChamadasSortIndicators(headers);
            renderChamadasPanel({ silent: true });
        });
    });
    updateChamadasSortIndicators(headers);
}

function updateChamadasSortIndicators(headers) {
    headers.forEach(th => {
        th.classList.remove('sorted-asc', 'sorted-desc');
        if (th.dataset.sort === chamadasSort.key) {
            th.classList.add(chamadasSort.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
        }
    });
}

function sortChamadas(list) {
    const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
    const dir = chamadasSort.dir === 'desc' ? -1 : 1;
    const getValue = (r) => {
        switch (chamadasSort.key) {
            case 'turma':
                return r.turma || '';
            case 'professor':
                return r.professor || '';
            case 'registro':
                return r.adjusted ? 1 : 0;
            case 'presencas':
                return r.presentes || 0;
            case 'justificadas':
                return r.faltasJustificadas || 0;
            case 'injustificadas':
                return r.faltasInjustificadas || 0;
            case 'hora':
                return r.registradoEm ? new Date(r.registradoEm).getTime() : 0;
            case 'data':
            default:
                return r.data || '';
        }
    };
    return [...list].sort((a, b) => {
        const valA = getValue(a);
        const valB = getValue(b);
        let cmp = 0;
        if (typeof valA === 'number' || typeof valB === 'number') {
            cmp = (Number(valA) || 0) - (Number(valB) || 0);
        } else {
            cmp = collator.compare(String(valA), String(valB));
        }
        if (cmp === 0) {
            cmp = collator.compare(String(a.turma || ''), String(b.turma || ''));
        }
        return cmp * dir;
    });
}

function fillChamadasExtraFilters() {
    const turmaInput = document.getElementById('chamadas-turma-filter');
    const turmaOptions = document.getElementById('chamadas-turma-options');
    const anoInput = document.getElementById('chamadas-ano-filter');
    const anoOptions = document.getElementById('chamadas-ano-options');
    const registroInput = document.getElementById('chamadas-registro-filter');
    if (turmaOptions) {
        turmaOptions.innerHTML = '';
        chamadasTurmaLookup = new Map();
        state.turmasCache.forEach(t => {
            const label = t.nome_turma || String(t.id);
            turmaOptions.innerHTML += `<option value="${label}"></option>`;
            if (label) chamadasTurmaLookup.set(label.trim().toLowerCase(), String(t.id));
        });
        if (turmaInput && chamadasTurmaSearch) turmaInput.value = chamadasTurmaSearch;
    }
    const turmaClear = document.getElementById('chamadas-turma-clear');
    if (turmaClear) turmaClear.classList.toggle('hidden', !chamadasTurmaSearch);

    if (anoOptions) {
        anoOptions.innerHTML = '';
        chamadasAnoLookup = new Map();
        state.anosLetivosCache.forEach(ano => {
            const label = String(ano);
            anoOptions.innerHTML += `<option value="${label}"></option>`;
            chamadasAnoLookup.set(label.trim().toLowerCase(), label);
        });
        if (anoInput && chamadasAnoSearch) anoInput.value = chamadasAnoSearch;
    }
    const anoClear = document.getElementById('chamadas-ano-clear');
    if (anoClear) anoClear.classList.toggle('hidden', !chamadasAnoSearch);

    if (registroInput) {
        if (!chamadasRegistroLookup.size) {
            chamadasRegistroLookup = new Map([
                ['original', 'original'],
                ['alterada', 'alterada']
            ]);
        }
        if (chamadasRegistroSearch) registroInput.value = chamadasRegistroSearch;
    }
    const registroClear = document.getElementById('chamadas-registro-clear');
    if (registroClear) registroClear.classList.toggle('hidden', !chamadasRegistroSearch);

    // Popovers are opened by user action; no automatic visibility handling here.
}

export function toggleChamadasExtraFilter(filterKey) {
    const wraps = document.querySelectorAll('#admin-chamadas-panel .filter-popover-wrap');
    if (!wraps.length) return;
    wraps.forEach(wrap => {
        const popover = wrap.querySelector('.filter-popover');
        if (!popover) return;
        if (wrap.dataset.filter === filterKey) {
            popover.classList.toggle('hidden');
            if (!popover.classList.contains('hidden')) {
                const input = popover.querySelector('input');
                if (input) input.focus();
            }
        } else {
            popover.classList.add('hidden');
        }
    });
}

export function closeChamadasFilterPopovers() {
    document.querySelectorAll('#admin-chamadas-panel .filter-popover').forEach(pop => {
        pop.classList.add('hidden');
    });
}

function renderChamadasPagination(container, currentPage, totalPages) {
    if (!container) return;
    if (totalPages <= 1) {
        container.innerHTML = '';
        return;
    }
    const prevDisabled = currentPage <= 1;
    const nextDisabled = currentPage >= totalPages;
    container.innerHTML = `
        <div class="flex items-center gap-2">
            <button class="px-3 py-1 border rounded-md ${prevDisabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100'}" ${prevDisabled ? 'disabled' : ''} data-chamadas-page="${currentPage - 1}">Anterior</button>
            <button class="px-3 py-1 border rounded-md ${nextDisabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100'}" ${nextDisabled ? 'disabled' : ''} data-chamadas-page="${currentPage + 1}">Próxima</button>
        </div>
        <div class="text-gray-500">Página ${currentPage} de ${totalPages}</div>
    `;
}

function fillChamadasProfessorFilter() {
    const input = document.getElementById('chamadas-professor-filter');
    const datalist = document.getElementById('chamadas-professor-options');
    if (!input || !datalist) return;
    const currentValue = (input.value || '').trim();
    datalist.innerHTML = '';
    chamadasProfessorLookup = new Map();
    state.usuariosCache
        .filter(u => u.papel === 'professor')
        .sort((a, b) => (a.nome || '').localeCompare(b.nome || ''))
        .forEach(p => {
            const label = p.email ? `${p.nome} <${p.email}>` : p.nome;
            const normalized = label.trim().toLowerCase();
            datalist.innerHTML += `<option value="${label}"></option>`;
            if (normalized) chamadasProfessorLookup.set(normalized, p.user_uid);
            if (p.email) chamadasProfessorLookup.set(p.email.trim().toLowerCase(), p.user_uid);
            if (p.nome) chamadasProfessorLookup.set(p.nome.trim().toLowerCase(), p.user_uid);
        });

    if (chamadasProfessorId) {
        const prof = state.usuariosCache.find(u => u.user_uid === chamadasProfessorId);
        if (prof) {
            input.value = prof.email ? `${prof.nome} <${prof.email}>` : prof.nome;
            return;
        }
    }
    if (!currentValue && chamadasProfessorSearch) {
        input.value = chamadasProfessorSearch;
    }
    const clearBtn = document.getElementById('chamadas-professor-clear');
    if (clearBtn) {
        clearBtn.classList.toggle('hidden', !(input.value || '').trim());
    }
}

export function handleChamadasCalendarSelect(dateStr) {
    if (!dateStr) return;
    if (!chamadasStartDate) {
        chamadasStartDate = dateStr;
        chamadasEndDate = null;
    } else if (!chamadasEndDate) {
        if (dateStr === chamadasStartDate) {
            chamadasStartDate = null;
            chamadasEndDate = null;
            chamadasDateCleared = true;
        } else if (dateStr > chamadasStartDate) {
            chamadasEndDate = dateStr;
        } else {
            chamadasEndDate = chamadasStartDate;
            chamadasStartDate = dateStr;
        }
    } else {
        if (dateStr === chamadasStartDate && dateStr === chamadasEndDate) {
            chamadasStartDate = null;
            chamadasEndDate = null;
            chamadasDateCleared = true;
        } else {
            chamadasStartDate = dateStr;
            chamadasEndDate = null;
        }
    }
    chamadasDateCleared = chamadasStartDate === null && chamadasEndDate === null;
    chamadasCurrentPage = 1;
    chamadasCacheKey = '';
    syncChamadasCalendarToSelection();
    renderChamadasPanel();
}

export function handleChamadasCalendarNav(direction) {
    const nextMonth = chamadasCalendar.month + direction;
    if (nextMonth < 0) {
        chamadasCalendar.month = 11;
        chamadasCalendar.year -= 1;
    } else if (nextMonth > 11) {
        chamadasCalendar.month = 0;
        chamadasCalendar.year += 1;
    } else {
        chamadasCalendar.month = nextMonth;
    }
    renderChamadasCalendar();
}

export function handleChamadasQuickDate(action) {
    const today = getLocalDateString();
    let target = today;
    if (action === 'yesterday') {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        target = d.toISOString().split('T')[0];
    }
    chamadasStartDate = target;
    chamadasEndDate = null;
    chamadasDateCleared = false;
    chamadasCurrentPage = 1;
    chamadasCacheKey = '';
    syncChamadasCalendarToSelection();
    renderChamadasPanel();
}

export function handleChamadasClearDates() {
    chamadasStartDate = null;
    chamadasEndDate = null;
    chamadasDateCleared = true;
    chamadasCurrentPage = 1;
    chamadasCacheKey = '';
    renderChamadasPanel();
}

export function handleChamadasToggleCalendar() {
    chamadasCalendarOpen = !chamadasCalendarOpen;
    renderChamadasPanel();
}

export function handleChamadasCloseCalendar() {
    if (!chamadasCalendarOpen) return;
    chamadasCalendarOpen = false;
    renderChamadasPanel();
}

export function handleChamadasProfessorFilterChange(value) {
    const raw = (value || '').trim();
    chamadasProfessorSearch = raw;
    const normalized = raw.toLowerCase();
    chamadasProfessorId = chamadasProfessorLookup.get(normalized) || '';
    const clearBtn = document.getElementById('chamadas-professor-clear');
    if (clearBtn) {
        clearBtn.classList.toggle('hidden', !raw);
    }
    chamadasCurrentPage = 1;
    chamadasCacheKey = '';
    renderChamadasPanel();
}

export function handleChamadasPageChange(page) {
    if (!page || page < 1) return;
    chamadasCurrentPage = page;
    renderChamadasPanel();
}

export function handleChamadasTurmaFilterChange(value) {
    const raw = (value || '').trim();
    chamadasTurmaSearch = raw;
    const normalized = raw.toLowerCase();
    chamadasTurmaId = chamadasTurmaLookup.get(normalized) || '';
    const clearBtn = document.getElementById('chamadas-turma-clear');
    if (clearBtn) clearBtn.classList.toggle('hidden', !raw);
    chamadasCurrentPage = 1;
    chamadasCacheKey = '';
    renderChamadasPanel();
}

export function handleChamadasRegistroFilterChange(value) {
    const raw = (value || '').trim();
    chamadasRegistroSearch = raw;
    const normalized = raw.toLowerCase();
    chamadasRegistroFilter = chamadasRegistroLookup.get(normalized) || '';
    const clearBtn = document.getElementById('chamadas-registro-clear');
    if (clearBtn) clearBtn.classList.toggle('hidden', !raw);
    chamadasCurrentPage = 1;
    chamadasCacheKey = '';
    renderChamadasPanel();
}

export function handleChamadasAnoFilterChange(value) {
    const raw = (value || '').trim();
    chamadasAnoSearch = raw;
    const normalized = raw.toLowerCase();
    chamadasAnoLetivo = chamadasAnoLookup.get(normalized) || '';
    const clearBtn = document.getElementById('chamadas-ano-clear');
    if (clearBtn) clearBtn.classList.toggle('hidden', !raw);
    chamadasCurrentPage = 1;
    chamadasCacheKey = '';
    renderChamadasPanel();
}
export async function renderChamadasPanel(options = {}) {
    const { defaultToLatestYear = false } = options;
    ensureChamadasDefaults({ defaultToLatestYear });
    fillChamadasProfessorFilter();
    fillChamadasExtraFilters();
    updateChamadasPeriodoLabel();
    renderChamadasCalendar();
    const calendarPanel = document.getElementById('chamadas-calendar-panel');
    if (calendarPanel) {
        calendarPanel.classList.toggle('hidden', !chamadasCalendarOpen);
    }

    const emptyState = document.getElementById('chamadas-empty-state');
    const resumoContainer = document.getElementById('chamadas-resumo-container');
    const tableBody = document.getElementById('chamadas-table-body');
    const summaryEl = document.getElementById('chamadas-summary');
    if (!emptyState || !tableBody) return;

    emptyState.textContent = 'Carregando chamadas...';
    emptyState.classList.remove('hidden');
    if (resumoContainer) resumoContainer.classList.add('hidden');

    const { data, error } = await loadChamadasData();
    if (error) {
        emptyState.textContent = 'Erro ao carregar chamadas.';
        return;
    }
    if (!data || data.length === 0) {
        emptyState.textContent = 'Nenhum registro encontrado.';
        if (summaryEl) summaryEl.textContent = 'Sem dados para o filtro atual.';
        tableBody.innerHTML = '';
        if (resumoContainer) resumoContainer.classList.add('hidden');
        return;
    }

    const sortedRows = sortChamadas(data);
    const totalPages = Math.max(1, Math.ceil(sortedRows.length / CHAMADAS_ITEMS_PER_PAGE));
    if (chamadasCurrentPage > totalPages) chamadasCurrentPage = totalPages;
    const startIndex = (chamadasCurrentPage - 1) * CHAMADAS_ITEMS_PER_PAGE;
    const pageRows = sortedRows.slice(startIndex, startIndex + CHAMADAS_ITEMS_PER_PAGE);

    const totalPresencas = sortedRows.reduce((sum, r) => sum + r.presentes, 0);
    const totalJustificadas = sortedRows.reduce((sum, r) => sum + r.faltasJustificadas, 0);
    const totalInjustificadas = sortedRows.reduce((sum, r) => sum + r.faltasInjustificadas, 0);

    if (summaryEl) {
        summaryEl.innerHTML = `
            <div class="flex flex-col gap-1">
                <span>Chamadas encontradas: <strong>${sortedRows.length}</strong></span>
                <span>Presenças: <strong>${totalPresencas}</strong></span>
                <span>Justificadas: <strong>${totalJustificadas}</strong></span>
                <span>Injustificadas: <strong>${totalInjustificadas}</strong></span>
            </div>
        `;
    }

    tableBody.innerHTML = pageRows.map(r => {
        const statusLabel = r.adjusted ? 'Alterada' : 'Original';
        const statusClass = r.adjusted ? 'chamada-stamp-adjusted' : 'chamada-stamp-original';
        return `
        <tr class="border-t chamadas-log-row hover:bg-gray-50 cursor-pointer" data-chamada-date="${r.data}" data-chamada-turma-id="${r.turmaId}" data-chamada-prof-id="${r.professorId || ''}" data-chamada-turma="${r.turma}" data-chamada-professor="${r.professor}" data-chamada-ajustada="${r.adjusted ? '1' : '0'}">
            <td class="p-3">${formatChamadasDateDisplay(r.data)}</td>
            <td class="p-3">${r.turma}</td>
            <td class="p-3">
                <div class="font-medium">${r.professor}</div>
            </td>
            <td class="p-3">
                <div class="registro-stack">
                    <span class="chamada-stamp ${statusClass}">${statusLabel}</span>
                </div>
            </td>
            <td class="p-3 text-center">${r.presentes}</td>
            <td class="p-3 text-center">${r.faltasJustificadas}</td>
            <td class="p-3 text-center">${r.faltasInjustificadas}</td>
            <td class="p-3 text-center">${formatChamadasTimeDisplay(r.registradoEm)}</td>
        </tr>
    `;}).join('');

    renderChamadasPagination(document.getElementById('chamadas-pagination-top'), chamadasCurrentPage, totalPages);
    renderChamadasPagination(document.getElementById('chamadas-pagination-bottom'), chamadasCurrentPage, totalPages);

    emptyState.classList.add('hidden');
    if (resumoContainer) resumoContainer.classList.remove('hidden');
    bindChamadasSortHeaders();
}

export async function openChamadaLogModal(payload) {
    const modal = document.getElementById('chamada-log-modal');
    const subtitle = document.getElementById('chamada-log-subtitle');
    const subtitlePrint = document.getElementById('chamada-log-subtitle-print');
    const editBtn = document.getElementById('editar-chamada-log-btn');
    const stamps = document.getElementById('chamada-log-stamps');
    const summary = document.getElementById('chamada-log-summary');
    const tableBody = document.getElementById('chamada-log-table-body');
    if (!modal || !subtitle || !stamps || !summary || !tableBody) return;

    const { date, turmaId, turmaName, professorId, professorName, adjusted } = payload;
    const subtitleText = `${formatChamadasFullDateDisplay(date)} • Turma ${turmaName || turmaId || '-' } • ${professorName || 'Professor'}`;
    subtitle.textContent = subtitleText;
    if (subtitlePrint) subtitlePrint.textContent = subtitleText;
    if (editBtn) {
        editBtn.dataset.turmaId = turmaId ? String(turmaId) : '';
        editBtn.dataset.data = date || '';
        editBtn.disabled = !turmaId || !date;
        editBtn.classList.toggle('opacity-50', editBtn.disabled);
        editBtn.classList.toggle('cursor-not-allowed', editBtn.disabled);
    }
    stamps.innerHTML = `
        <span class="chamada-stamp chamada-stamp-original">Feita por: ${professorName || '-'}</span>
        <span class="chamada-stamp ${adjusted ? 'chamada-stamp-adjusted' : 'chamada-stamp-original'}">${adjusted ? 'Ajustada' : 'Sem ajuste'}</span>
    `;
    summary.innerHTML = '<div class="p-3 rounded border bg-gray-50 text-sm">Carregando...</div>';
    tableBody.innerHTML = '';
    modal.classList.remove('hidden');

    const { data: auditLogs } = await safeQuery(
        db.from('audit_logs')
            .select('created_at, user_uid, details')
            .eq('action', 'chamada_correcao')
            .eq('entity', 'presencas')
    );
    const adjustments = (auditLogs || [])
        .map(log => {
            const details = log.details || {};
            const turmaVal = details.turma_id || details.turmaId;
            const dataVal = details.data || details.data_chamada || details.date;
            if (String(turmaVal) !== String(turmaId) || String(dataVal) !== String(date)) return null;
            return { user_uid: log.user_uid, created_at: log.created_at };
        })
        .filter(Boolean)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    if (adjustments.length) {
        const userMap = new Map(state.usuariosCache.map(u => [u.user_uid, u.nome]));
        const missing = adjustments.map(a => a.user_uid).filter(uid => uid && !userMap.has(uid));
        if (missing.length) {
            const { data: extraUsers } = await safeQuery(
                db.from('usuarios').select('user_uid, nome').in('user_uid', missing)
            );
            (extraUsers || []).forEach(u => userMap.set(u.user_uid, u.nome));
        }
        const listHtml = adjustments.map(a => {
            const nome = userMap.get(a.user_uid) || (a.user_uid ? `UID ${a.user_uid}` : 'Desconhecido');
            return `<span class="chamada-stamp chamada-stamp-adjusted">Ajuste: ${nome} • ${formatChamadasDateTimeDisplay(a.created_at)}</span>`;
        }).join('');
        stamps.innerHTML += listHtml;
    }

    let query = db.from('presencas')
        .select('status, justificativa, registrado_em, alunos ( nome_completo )')
        .eq('turma_id', turmaId)
        .eq('data', date);
    if (professorId) query = query.eq('registrado_por_uid', professorId);
    query = query.order('nome_completo', { foreignTable: 'alunos', ascending: true });

    const { data, error } = await safeQuery(query);
    if (error) {
        summary.innerHTML = '<div class="p-3 rounded border bg-red-50 text-sm text-red-600">Erro ao carregar detalhes.</div>';
        return;
    }
    if (!data || data.length === 0) {
        summary.innerHTML = '<div class="p-3 rounded border bg-gray-50 text-sm">Nenhum registro encontrado.</div>';
        return;
    }

    let presentes = 0;
    let just = 0;
    let injust = 0;
    tableBody.innerHTML = data.map((item) => {
        const statusRaw = item.status || '';
        const status = statusRaw.toLowerCase();
        const justificativa = item.justificativa || (status === 'falta' ? 'Falta injustificada' : '-');
        if (status === 'presente') presentes += 1;
        if (status === 'falta') {
            if (justificativa === 'Falta justificada') just += 1;
            else injust += 1;
        }
        return `
            <tr class="border-t">
                <td class="p-3">${item.alunos?.nome_completo || '-'}</td>
                <td class="p-3 text-center">${statusRaw || status || '-'}</td>
                <td class="p-3">${justificativa}</td>
                <td class="p-3 text-center">${formatChamadasTimeDisplay(item.registrado_em)}</td>
            </tr>
        `;
    }).join('');

    summary.innerHTML = `
        <div class="p-3 rounded border bg-green-50 text-sm">
            <div class="text-xs text-gray-500">Presenças</div>
            <div class="text-lg font-bold text-green-700">${presentes}</div>
        </div>
        <div class="p-3 rounded border bg-yellow-50 text-sm">
            <div class="text-xs text-gray-500">Justificadas</div>
            <div class="text-lg font-bold text-yellow-700">${just}</div>
        </div>
        <div class="p-3 rounded border bg-red-50 text-sm">
            <div class="text-xs text-gray-500">Injustificadas</div>
            <div class="text-lg font-bold text-red-700">${injust}</div>
        </div>
    `;
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
    const tituloPrint = document.getElementById('relatorio-titulo-impressao');
    const periodoPrint = document.getElementById('relatorio-periodo-impressao');
    const turmaSel = document.getElementById('relatorio-turma-select');
    const alunoSel = document.getElementById('relatorio-aluno-select');
    const professorSel = document.getElementById('relatorio-professor-select');

    if (tituloPrint) {
        if (status === 'falta') tituloPrint.textContent = 'Relatório de Faltas';
        else if (status === 'presente') tituloPrint.textContent = 'Relatório de Presenças';
        else tituloPrint.textContent = 'Relatório de Frequência';
    }

    if (periodoPrint) {
        const periodo = dataInicio || dataFim
            ? `Período: ${formatRelatorioDateBrDash(dataInicio) || '...'} até ${formatRelatorioDateBrDash(dataFim) || '...'}`
            : 'Período: Todos os registros';
        const extras = [];
        if (turmaId && turmaSel) extras.push(`Turma: ${turmaSel.options[turmaSel.selectedIndex]?.text || ''}`);
        if (alunoId && alunoSel) extras.push(`Aluno: ${alunoSel.options[alunoSel.selectedIndex]?.text || ''}`);
        if (professorId && professorSel) extras.push(`Registrado por: ${professorSel.options[professorSel.selectedIndex]?.text || ''}`);
        periodoPrint.textContent = extras.length ? `${periodo} • ${extras.join(' • ')}` : periodo;
    }

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
        relatoriosRowsCache = [];
        relatorioTableBody.innerHTML = '<tr><td colspan="7" class="p-4 text-center text-red-500">Erro ao gerar relatorio.</td></tr>';
        if (printBtn) printBtn.classList.add('hidden');
        return;
    }
    if (!data || data.length === 0) {
        relatoriosRowsCache = [];
        relatorioTableBody.innerHTML = '<tr><td colspan="7" class="p-4 text-center">Nenhum registro encontrado.</td></tr>';
        if (printBtn) printBtn.classList.add('hidden');
        return;
    }

    relatoriosRowsCache = data;
    bindRelatoriosSortHeaders();
    renderRelatoriosRowsFromCache();
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
    relatoriosRowsCache = [];
    const periodoEl = document.getElementById('relatorio-periodo-impressao');
    if (periodoEl) periodoEl.textContent = 'Período: Todos os registros';
    const tituloEl = document.getElementById('relatorio-titulo-impressao');
    if (tituloEl) tituloEl.textContent = 'Relatório de Frequência';
    const printBtn = document.getElementById('imprimir-relatorio-btn');
    if (printBtn) printBtn.classList.add('hidden');
}

// ===============================================================
// ADMIN - CONFIGURACOES
// ===============================================================

export async function renderConfigPanel() {
    try {
        const { data } = await safeQuery(
            db.from('configuracoes').select('*').order('id', { ascending: true }).limit(1)
        );
        const config = data?.[0];
        if (!config) return;
        const faltasConsecutivas = config.faltas_consecutivas ?? config.faltas_consecutivas_limite ?? '';
        const faltasIntercaladas = config.faltas_intercaladas ?? config.faltas_intercaladas_limite ?? '';
        const faltasDias = config.faltas_dias ?? config.faltas_intercaladas_dias ?? '';
        const alertaChamada = config.alerta_chamada_ativo ?? config.alerta_chamada_nao_feita_ativo ?? false;
        document.getElementById('config-faltas-consecutivas').value = faltasConsecutivas;
        document.getElementById('config-faltas-intercaladas').value = faltasIntercaladas;
        document.getElementById('config-faltas-dias').value = faltasDias;
        document.getElementById('config-alerta-horario').value = formatTimeForInput(config.alerta_horario);
        document.getElementById('config-alerta-faltas-ativo').checked = !!config.alerta_faltas_ativo;
        document.getElementById('config-alerta-chamada-ativo').checked = !!alertaChamada;
        const appprofVersionInput = document.getElementById('config-appprof-versao');
        const appprofApkInput = document.getElementById('config-appprof-apk-url');
        const defaultApkUrl = new URL('../appprof/downloads/appprof.apk', window.location.href).toString();
        if (appprofVersionInput) appprofVersionInput.value = config.appprof_versao || '';
        if (appprofApkInput) appprofApkInput.value = config.appprof_apk_url || defaultApkUrl;

        const metricsLink = document.getElementById('supabase-metrics-link');
        if (metricsLink) {
            const projectRef = (() => {
                try {
                    const url = new URL(SUPABASE_URL);
                    return (url.hostname || '').split('.')[0];
                } catch {
                    return '';
                }
            })();
            if (projectRef) {
                metricsLink.href = `https://supabase.com/dashboard/project/${projectRef}`;
                metricsLink.classList.remove('opacity-50', 'pointer-events-none');
            } else {
                metricsLink.href = '#';
                metricsLink.classList.add('opacity-50', 'pointer-events-none');
            }
        }
    } catch (err) {
        console.warn('Falha ao carregar configuracoes:', err?.message || err);
    }
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
    const appprofVersionInput = document.getElementById('config-appprof-versao');
    const appprofApkInput = document.getElementById('config-appprof-apk-url');
    const appprofVersao = appprofVersionInput?.value?.trim() || null;
    const defaultApkUrl = new URL('../appprof/downloads/appprof.apk', window.location.href).toString();
    const appprofApkUrl = appprofApkInput?.value?.trim() || defaultApkUrl;
    const configData = {
        faltas_consecutivas: faltasConsecutivas,
        faltas_consecutivas_limite: faltasConsecutivas,
        faltas_intercaladas: faltasIntercaladas,
        faltas_intercaladas_limite: faltasIntercaladas,
        faltas_dias: faltasDias,
        faltas_intercaladas_dias: faltasDias,
        alerta_horario: normalizeTimeForDb(document.getElementById('config-alerta-horario').value),
        alerta_faltas_ativo: document.getElementById('config-alerta-faltas-ativo').checked,
        alerta_chamada_ativo: alertaChamada,
        alerta_chamada_nao_feita_ativo: alertaChamada,
        appprof_versao: appprofVersao,
        appprof_apk_url: appprofApkUrl
    };

    const { data: existing } = await safeQuery(
        db.from('configuracoes').select('id').order('id', { ascending: true }).limit(1)
    );

    let error;
    const existingId = existing?.[0]?.id;
    if (existingId) {
        ({ error } = await safeQuery(db.from('configuracoes').update(configData).eq('id', existingId)));
    } else {
        ({ error } = await safeQuery(db.from('configuracoes').insert(configData)));
    }
    if (error) showToast('Erro ao salvar configurações: ' + error.message, true);
    else {
        await logAudit('update', 'configuracoes', null, { configData });
        showToast('Configurações salvas com sucesso!');
        await renderConfigPanel();
    }
}

// ===============================================================
// ADMIN - CONSISTENCIA
// ===============================================================

function bindConsistenciaCollapsibles() {
    const panel = document.getElementById('admin-consistencia-panel');
    if (!panel || panel.dataset.collapsibleBound === '1') return;
    panel.addEventListener('click', (e) => {
        const summary = e.target.closest('[data-consistencia-summary="1"]');
        if (!summary) return;
        e.preventDefault();
        e.stopPropagation();
        const container = summary.closest('details.consistencia-collapsible');
        if (!container) return;
        container.open = !container.open;
    });
    panel.dataset.collapsibleBound = '1';
}

export async function renderConsistenciaPanel() {
    bindConsistenciaCollapsibles();
    const anoFilterEl = document.getElementById('consistencia-ano-filter');
    const alunosSemTurmaCountEl = document.getElementById('consistencia-alunos-sem-turma-count');
    const profSemTurmaCountEl = document.getElementById('consistencia-prof-sem-turma-count');
    const turmasDuplicadasCountEl = document.getElementById('consistencia-turmas-duplicadas-count');
    const alunosOrfaosCountEl = document.getElementById('consistencia-alunos-orfaos-count');
    const totalAlunosCountEl = document.getElementById('consistencia-total-alunos-count');
    const totalProfessoresCountEl = document.getElementById('consistencia-total-professores-count');

    const alunosSemTurmaTable = document.getElementById('consistencia-alunos-sem-turma-table');
    const profSemTurmaTable = document.getElementById('consistencia-prof-sem-turma-table');
    const turmasDuplicadasTable = document.getElementById('consistencia-turmas-duplicadas-table');
    const alunosOrfaosTable = document.getElementById('consistencia-alunos-orfaos-table');

    const setLoading = () => {
        if (anoFilterEl && state.anosLetivosCache?.length) {
            const anos = [...state.anosLetivosCache].map(a => String(a));
            if (!consistenciaAnoLetivo || !anos.includes(String(consistenciaAnoLetivo))) {
                consistenciaAnoLetivo = String(anos[0]);
            }
            anoFilterEl.innerHTML = anos.map(ano => `<option value="${ano}">${ano}</option>`).join('');
            anoFilterEl.value = String(consistenciaAnoLetivo);
        }
        alunosSemTurmaCountEl.textContent = '...';
        profSemTurmaCountEl.textContent = '...';
        turmasDuplicadasCountEl.textContent = '...';
        alunosOrfaosCountEl.textContent = '...';
        if (totalAlunosCountEl) totalAlunosCountEl.textContent = '...';
        if (totalProfessoresCountEl) totalProfessoresCountEl.textContent = '...';
        alunosSemTurmaTable.innerHTML = '<tr><td colspan="2" class="p-4 text-center">Carregando...</td></tr>';
        profSemTurmaTable.innerHTML = '<tr><td colspan="2" class="p-4 text-center">Carregando...</td></tr>';
        turmasDuplicadasTable.innerHTML = '<tr><td colspan="3" class="p-4 text-center">Carregando...</td></tr>';
        alunosOrfaosTable.innerHTML = '<tr><td colspan="3" class="p-4 text-center">Carregando...</td></tr>';
    };

    setLoading();

    const fetchAllAlunosAtivos = async () => {
        const pageSize = 1000;
        let from = 0;
        const rows = [];
        while (true) {
            const { data, error } = await safeQuery(
                db.from('alunos')
                    .select('id, nome_completo, matricula, turma_id')
                    .eq('status', 'ativo')
                    .order('id', { ascending: true })
                    .range(from, from + pageSize - 1)
            );
            if (error) throw error;
            const batch = data || [];
            rows.push(...batch);
            if (batch.length < pageSize) break;
            from += pageSize;
        }
        return rows;
    };

    try {
        const [
            alunosAtivos,
            profsRes,
            profsTurmasRes,
            turmasRes
        ] = await Promise.all([
            fetchAllAlunosAtivos(),
            safeQuery(db.from('usuarios').select('id, user_uid, nome, email').eq('papel', 'professor').order('nome')),
            safeQuery(db.from('professores_turmas').select('professor_id, turma_id')),
            safeQuery(db.from('turmas').select('id, nome_turma, ano_letivo'))
        ]);

        const profs = profsRes.data || [];
        const profsTurmas = profsTurmasRes.data || [];
        const turmas = turmasRes.data || [];

        const turmasAno = consistenciaAnoLetivo
            ? turmas.filter(t => String(t.ano_letivo) === String(consistenciaAnoLetivo))
            : turmas;
        const turmasAnoIds = new Set(turmasAno.map(t => t.id));
        const turmasIdsValidos = new Set(turmas.map(t => t.id));

        // Alunos sem turma no ano: sem vínculo ou vínculo fora do ano selecionado.
        const alunosSemTurmaNoAno = alunosAtivos.filter(a => {
            const turmaId = a.turma_id;
            if (!turmaId) return true;
            if (!turmasIdsValidos.has(turmaId)) return false; // turma inválida entra no card próprio
            return !turmasAnoIds.has(turmaId);
        });
        alunosSemTurmaCountEl.textContent = alunosSemTurmaNoAno.length;
        alunosSemTurmaTable.innerHTML = alunosSemTurmaNoAno.length
            ? alunosSemTurmaNoAno.slice(0, 50).map(a => `
                <tr>
                    <td class="p-3">${a.nome_completo}</td>
                    <td class="p-3">${a.matricula || '-'}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="2" class="p-4 text-center">Nenhum encontrado.</td></tr>';

        // Professores sem turma no ano
        const profsComTurmaNoAno = new Set(
            profsTurmas
                .filter(p => turmasAnoIds.has(p.turma_id))
                .map(p => p.professor_id)
        );
        const profsSemTurma = profs.filter(p => !profsComTurmaNoAno.has(p.user_uid));
        profSemTurmaCountEl.textContent = profsSemTurma.length;
        profSemTurmaTable.innerHTML = profsSemTurma.length
            ? profsSemTurma.slice(0, 50).map(p => `
                <tr>
                    <td class="p-3">${p.nome}</td>
                    <td class="p-3">${p.email}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="2" class="p-4 text-center">Nenhum encontrado.</td></tr>';

        // Turmas duplicadas no ano selecionado
        const dupMap = new Map();
        turmasAno.forEach(t => {
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

        // Alunos duplicados por nome + matrícula (no recorte do ano).
        const alunosBaseDuplicidade = alunosAtivos.filter(a => a.turma_id && turmasAnoIds.has(a.turma_id));
        const duplicidadeMap = new Map();
        alunosBaseDuplicidade.forEach(a => {
            const nome = String(a.nome_completo || '').trim().toLowerCase();
            const matricula = String(a.matricula || '').trim();
            if (!nome || !matricula) return;
            const key = `${nome}__${matricula}`;
            const current = duplicidadeMap.get(key) || {
                id: a.id,
                nome_completo: a.nome_completo,
                matricula: a.matricula,
                qtd: 0
            };
            current.qtd += 1;
            duplicidadeMap.set(key, current);
        });
        const duplicados = Array.from(duplicidadeMap.values())
            .filter(item => item.qtd > 1)
            .sort((a, b) => b.qtd - a.qtd || String(a.nome_completo).localeCompare(String(b.nome_completo), 'pt-BR', { sensitivity: 'base' }));
        alunosOrfaosCountEl.textContent = duplicados.length;
        alunosOrfaosTable.innerHTML = duplicados.length
            ? duplicados.slice(0, 50).map(a => `
                <tr>
                    <td class="p-3">${a.nome_completo}</td>
                    <td class="p-3">${a.matricula || '-'}</td>
                    <td class="p-3">${a.qtd}</td>
                </tr>
            `).join('')
            : '<tr><td colspan="3" class="p-4 text-center">Nenhum encontrado.</td></tr>';

        // Totais do ano selecionado
        const alunosNoAno = alunosAtivos.filter(a => a.turma_id && turmasAnoIds.has(a.turma_id));
        const alunosComTurmaInvalida = alunosAtivos.filter(a => !!a.turma_id && !turmasIdsValidos.has(a.turma_id));
        const totalAlunosNoAno = alunosNoAno.length + alunosSemTurmaNoAno.length + alunosComTurmaInvalida.length;
        if (totalAlunosCountEl) totalAlunosCountEl.textContent = totalAlunosNoAno;
        if (totalProfessoresCountEl) totalProfessoresCountEl.textContent = profs.length;
    } catch (err) {
        console.error('Erro ao carregar consistencia:', err);
        alunosSemTurmaCountEl.textContent = 'Erro';
        profSemTurmaCountEl.textContent = 'Erro';
        turmasDuplicadasCountEl.textContent = 'Erro';
        alunosOrfaosCountEl.textContent = 'Erro';
        if (totalAlunosCountEl) totalAlunosCountEl.textContent = 'Erro';
        if (totalProfessoresCountEl) totalProfessoresCountEl.textContent = 'Erro';
        alunosSemTurmaTable.innerHTML = '<tr><td colspan="2" class="p-4 text-center text-red-500">Erro ao carregar.</td></tr>';
        profSemTurmaTable.innerHTML = '<tr><td colspan="2" class="p-4 text-center text-red-500">Erro ao carregar.</td></tr>';
        turmasDuplicadasTable.innerHTML = '<tr><td colspan="3" class="p-4 text-center text-red-500">Erro ao carregar.</td></tr>';
        alunosOrfaosTable.innerHTML = '<tr><td colspan="3" class="p-4 text-center text-red-500">Erro ao carregar.</td></tr>';
    }
}

export function handleConsistenciaAnoFilterChange(value) {
    consistenciaAnoLetivo = String(value || '').trim();
    renderConsistenciaPanel();
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
    const isTurmas = value === 'turmas';
    turmasContainer.classList.toggle('opacity-60', !isTurmas);
    turmasContainer.classList.toggle('pointer-events-none', !isTurmas);
    const selectAllBtn = document.getElementById('evento-turmas-select-all');
    const clearBtn = document.getElementById('evento-turmas-clear');
    if (selectAllBtn) selectAllBtn.disabled = !isTurmas;
    if (clearBtn) clearBtn.disabled = !isTurmas;
    document.querySelectorAll('.evento-turma-btn').forEach(btn => { btn.disabled = !isTurmas; });
}

let eventoTurmasDisponiveis = [];
let eventoTurmasSelecionadas = new Set();

function updateEventoTurmasResumo() {
    const resumoEl = document.getElementById('evento-turmas-resumo');
    if (!resumoEl) return;
    const selecionadas = eventoTurmasSelecionadas.size;
    resumoEl.textContent = selecionadas > 0
        ? `${selecionadas} turma(s) selecionada(s)`
        : 'Nenhuma turma selecionada';
}

function renderEventoTurmasUI(selectedIds = []) {
    const gridEl = document.getElementById('evento-turmas-grid');
    if (!gridEl) return;
    eventoTurmasSelecionadas = new Set((selectedIds || []).map(Number));

    const filtered = eventoTurmasDisponiveis
        .sort((a, b) => (a.nome_turma || '').localeCompare((b.nome_turma || ''), undefined, { numeric: true }));

    if (!eventoTurmasDisponiveis.length) {
        gridEl.innerHTML = '<p class="text-xs text-gray-500 p-2">Nenhuma turma encontrada no ano letivo atual.</p>';
        updateEventoTurmasResumo();
        return;
    }
    gridEl.innerHTML = filtered.map(t => {
        const selected = eventoTurmasSelecionadas.has(Number(t.id));
        const nome = String(t.nome_turma || '');
        const isMultisseriada = nome.toLowerCase().includes('multisseriada');
        const sizeClass = isMultisseriada ? 'evento-turma-btn-multi' : 'evento-turma-btn-fixed';
        return `<button type="button" class="evento-turma-btn ${sizeClass} px-2 py-1 rounded border text-xs ${selected ? 'bg-blue-100 border-blue-300 text-blue-700' : 'bg-white border-gray-300 text-gray-700'}" data-id="${t.id}">${nome}</button>`;
    }).join('');
    updateEventoTurmasResumo();
}

function setEventoTurmasDisponiveis(turmas = []) {
    eventoTurmasDisponiveis = (turmas || []).map(t => ({
        id: Number(t.id),
        nome_turma: t.nome_turma || ''
    }));
}

function addEventoTurma(id) {
    const numId = Number(id);
    if (!Number.isFinite(numId)) return;
    eventoTurmasSelecionadas.add(numId);
    renderEventoTurmasUI(Array.from(eventoTurmasSelecionadas));
}

function removeEventoTurma(id) {
    eventoTurmasSelecionadas.delete(Number(id));
    renderEventoTurmasUI(Array.from(eventoTurmasSelecionadas));
}

function addAllEventoTurmasFiltered() {
    eventoTurmasDisponiveis.forEach(t => eventoTurmasSelecionadas.add(Number(t.id)));
    renderEventoTurmasUI(Array.from(eventoTurmasSelecionadas));
}

function clearEventoTurmasSelecionadas() {
    eventoTurmasSelecionadas.clear();
    renderEventoTurmasUI([]);
}

function bindEventoTurmasSelectBehavior() {
    const turmasContainer = document.getElementById('evento-turmas-container');
    const selectAllBtn = document.getElementById('evento-turmas-select-all');
    const clearBtn = document.getElementById('evento-turmas-clear');
    const gridEl = document.getElementById('evento-turmas-grid');
    if (!turmasContainer || turmasContainer.dataset.multiBound === '1') return;

    if (selectAllBtn) {
        selectAllBtn.addEventListener('click', () => {
            addAllEventoTurmasFiltered();
        });
    }
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            clearEventoTurmasSelecionadas();
        });
    }
    if (gridEl) {
        gridEl.addEventListener('click', (e) => {
            const btn = e.target.closest('.evento-turma-btn');
            if (!btn) return;
            const id = Number(btn.dataset.id);
            if (eventoTurmasSelecionadas.has(id)) eventoTurmasSelecionadas.delete(id);
            else eventoTurmasSelecionadas.add(id);
            renderEventoTurmasUI(Array.from(eventoTurmasSelecionadas));
        });
    }

    turmasContainer.dataset.multiBound = '1';
}

function renderEventoTurmasChecklist(turmas = [], selectedIds = []) {
    // Mantido apenas para compatibilidade de chamadas antigas.
    setEventoTurmasDisponiveis(turmas);
    renderEventoTurmasUI(selectedIds);
}

async function ensureEventoTurmasCache() {
    if (Array.isArray(state.turmasCache) && state.turmasCache.length > 0) return;
    const { data, error } = await safeQuery(
        db.from('turmas')
            .select('id, nome_turma, ano_letivo')
            .order('ano_letivo', { ascending: false })
            .order('nome_turma', { ascending: true })
    );
    if (error) {
        console.error('Erro ao carregar turmas para evento:', error.message || error);
    }
    state.turmasCache = data || [];
}

async function fetchEventoTurmasDoAnoAtual() {
    const anoLetivoAtual = String(state.anosLetivosCache?.[0] || new Date().getFullYear());
    const { data, error } = await safeQuery(
        db.from('turmas')
            .select('id, nome_turma, ano_letivo')
            .eq('ano_letivo', anoLetivoAtual)
            .order('nome_turma', { ascending: true })
    );
    if (error) {
        console.error('Erro ao carregar turmas do calendário:', error.message || error);
        return [];
    }
    return data || [];
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
    const gridEl = document.getElementById('evento-turmas-grid');
    const abrangenciaSelect = document.getElementById('evento-abrangencia-select');

    if (abrangenciaSelect && !abrangenciaSelect.dataset.bound) {
        abrangenciaSelect.addEventListener('change', (ev) => {
            applyEventoAbrangenciaUI(ev.target.value);
        });
        abrangenciaSelect.dataset.bound = 'true';
    }

    eventoForm.reset();
    document.getElementById('evento-delete-container').classList.add('hidden');
    // Define estado inicial imediatamente para evitar "duplo clique"
    if (!editId) {
        document.getElementById('evento-modal-title').textContent = 'Adicionar Evento';
        document.getElementById('evento-id').value = '';
        if (abrangenciaSelect) abrangenciaSelect.value = 'global';
        applyEventoAbrangenciaUI('global');
    }

    // Abre imediatamente e mostra loading da lista.
    eventoModal.classList.remove('hidden');
    if (gridEl) {
        gridEl.innerHTML = '<p class="text-xs text-gray-500 p-2">Carregando turmas...</p>';
    }

    bindEventoTurmasSelectBehavior();
    const [turmasDoAno, eventoEditData] = await Promise.all([
        fetchEventoTurmasDoAnoAtual(),
        editId ? safeQuery(db.from('eventos').select('*').eq('id', editId).single()).then(r => r.data || null) : Promise.resolve(null)
    ]);
    renderEventoTurmasChecklist(turmasDoAno, []);

    // Mantém cache em sincronia para demais usos.
    await ensureEventoTurmasCache();
    if (editId) {
        const data = eventoEditData;
        if (!data) { showToast('Evento não encontrado.', true); return; }
        document.getElementById('evento-modal-title').textContent = 'Editar Evento';
        document.getElementById('evento-id').value = data.id;
        document.getElementById('evento-descricao').value = data.descricao;
        document.getElementById('evento-data-inicio').value = data.data;
        document.getElementById('evento-data-fim').value = data.data_fim;
        const turmasIds = normalizeTurmasIds(data.turmas_ids);
        const abrangencia = turmasIds.length > 0 || data.abrangencia === 'turmas' ? 'turmas' : 'global';
        if (abrangenciaSelect) abrangenciaSelect.value = abrangencia;
        renderEventoTurmasChecklist(turmasDoAno, turmasIds);
        applyEventoAbrangenciaUI(abrangencia);
        updateEventoTurmasResumo();
        document.getElementById('evento-delete-container').classList.remove('hidden');
    } else {
        renderEventoTurmasChecklist(turmasDoAno, []);
        applyEventoAbrangenciaUI('global');
        updateEventoTurmasResumo();
    }
}

export async function handleEventoFormSubmit(e) {
    const id = document.getElementById('evento-id').value;
    const abrangencia = document.getElementById('evento-abrangencia-select')?.value || 'global';
    const turmasIds = Array.from(eventoTurmasSelecionadas).filter(Number.isFinite);
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
    if (!listEl) return;
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
    const title = document.getElementById('delete-confirm-title');
    const msg = document.getElementById('delete-confirm-message');
    const checkbox = document.getElementById('delete-confirm-checkbox');
    const confirmBtn = document.getElementById('confirm-delete-btn');
    if (type === 'professor') {
        if (title) title.textContent = 'Confirmar Inativação';
        msg.textContent = 'Tem certeza que deseja inativar este professor?';
        confirmBtn.textContent = 'Inativar';
    } else {
        if (title) title.textContent = 'Confirmar Exclusão';
        msg.textContent = `Tem certeza que deseja excluir este ${type}?`;
        confirmBtn.textContent = 'Excluir Permanentemente';
    }
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
            await safeQuery(db.from('usuarios').update({ status: 'inativo' }).eq('id', id));
        } else if (type === 'evento') {
            await safeQuery(db.from('eventos').delete().eq('id', id));
        } else if (type === 'acompanhamento') {
            await safeQuery(db.from('apoia_encaminhamentos').delete().eq('id', id));
        }
        const auditAction = type === 'professor' ? 'inactivate' : 'delete';
        await logAudit(auditAction, type, id, null);
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

async function resolvePrintLogoSrc(primaryUrl, fallbackUrl) {
    const toDataUrl = async (url) => {
        if (!url) return null;
        try {
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) return null;
            const blob = await response.blob();
            return await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
            });
        } catch (_) {
            return null;
        }
    };

    return (await toDataUrl(primaryUrl))
        || (await toDataUrl(fallbackUrl))
        || primaryUrl
        || fallbackUrl
        || '';
}

export async function handleImprimirRelatorio(reportType) {
    const reportSelectors = {
        faltas: '#relatorio-resultados .printable-area',
        apoia: '#apoia-relatorio-resultados .printable-area',
        historico: '#aluno-historico-modal .printable-area',
        chamada: '#chamada-log-modal .printable-area'
    };
    const reportEl = document.querySelector(reportSelectors[reportType]);
    if (!reportEl) return;
    const cloned = reportEl.cloneNode(true);
    const titleByType = {
        faltas: document.getElementById('relatorio-titulo-impressao')?.textContent?.trim() || 'Relatório de Frequência',
        apoia: document.getElementById('apoia-relatorio-titulo-impressao')?.textContent?.trim() || 'Relatório de Acompanhamento APOIA',
        historico: document.getElementById('historico-titulo-impressao')?.textContent?.trim() || 'Histórico de Frequência do Aluno',
        chamada: 'Detalhes da Chamada'
    };
    const subtitleByType = {
        faltas: document.getElementById('relatorio-periodo-impressao')?.textContent?.trim() || 'Período: Todos os registros',
        apoia: document.getElementById('apoia-relatorio-periodo-impressao')?.textContent?.trim() || '',
        historico: document.getElementById('historico-aluno-nome-impressao')?.textContent?.trim() || '',
        chamada: document.getElementById('chamada-log-subtitle-print')?.textContent?.trim()
            || document.getElementById('chamada-log-subtitle')?.textContent?.trim()
            || ''
    };

    const expectedTitle = titleByType[reportType] || 'Relatório';
    const expectedSubtitle = subtitleByType[reportType] || '';
    const printLogoUrl = new URL('./logo.png', window.location.href).href;
    const printLogoFallbackUrl = new URL('./logo_admin.png', window.location.href).href;
    const embeddedLogoSrc = await resolvePrintLogoSrc(printLogoUrl, printLogoFallbackUrl);
    const ensurePrintHeaderLogo = (header) => {
        if (!header) return;
        let img = header.querySelector('img');
        if (!img) {
            img = document.createElement('img');
            img.alt = 'Logo da Escola';
            header.prepend(img);
        }
        img.src = embeddedLogoSrc || printLogoUrl;
        img.alt = 'Logo da Escola';
        img.setAttribute('onerror', `this.onerror=null;this.src='${printLogoFallbackUrl}'`);
        img.style.minWidth = '56px';
        img.style.minHeight = '56px';
    };

    let headerEl = cloned.querySelector('.print-header');
    if (!headerEl) {
        headerEl = document.createElement('div');
        headerEl.className = 'print-header';
        const img = document.createElement('img');
        img.src = embeddedLogoSrc || printLogoUrl;
        img.alt = 'Logo da Escola';
        img.setAttribute('onerror', `this.onerror=null;this.src='${printLogoFallbackUrl}'`);
        const info = document.createElement('div');
        info.className = 'print-header-info';
        const h2 = document.createElement('h2');
        h2.textContent = expectedTitle;
        const p = document.createElement('p');
        p.textContent = expectedSubtitle;
        info.appendChild(h2);
        info.appendChild(p);
        headerEl.appendChild(img);
        headerEl.appendChild(info);
        cloned.prepend(headerEl);
    } else {
        const h2 = headerEl.querySelector('h2');
        const p = headerEl.querySelector('p');
        if (h2) h2.textContent = expectedTitle;
        if (p) p.textContent = expectedSubtitle;
    }
    ensurePrintHeaderLogo(headerEl);

    if (reportType === 'faltas') {
        cloned.classList.add('print-faltas-compact');
        const normalizeLabel = (value) => String(value || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim();
        const normalizeBrDashDate = (value) => {
            if (!value) return '-';
            const raw = String(value).trim();
            const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
            if (isoMatch) return `${isoMatch[3]}-${isoMatch[2]}-${isoMatch[1]}`;
            const slashMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
            if (slashMatch) return `${slashMatch[1]}-${slashMatch[2]}-${slashMatch[3]}`;
            const dashMatch = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
            if (dashMatch) return raw;
            const dateObj = new Date(raw);
            if (!Number.isNaN(dateObj.getTime())) {
                const dd = String(dateObj.getDate()).padStart(2, '0');
                const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
                const yyyy = dateObj.getFullYear();
                return `${dd}-${mm}-${yyyy}`;
            }
            return raw;
        };

        const table = cloned.querySelector('table');
        let dataInfo = '-';
        let horaInfo = '-';
        let registradoPorInfo = '-';

        if (table) {
            const headCells = Array.from(table.querySelectorAll('thead th'));
            const dataIdx = headCells.findIndex((th) => normalizeLabel(th.textContent) === 'data');
            const horaIdx = headCells.findIndex((th) => normalizeLabel(th.textContent) === 'hora');
            const registradoIdx = headCells.findIndex((th) => normalizeLabel(th.textContent).startsWith('registrado por'));

            const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
            const getColumnValues = (idx) => bodyRows
                .map((row) => row.children[idx]?.textContent?.trim() || '')
                .filter((text) => text && text !== '-');
            const uniqueOrSummary = (values, multipleLabel) => {
                const unique = [...new Set(values)];
                if (unique.length === 0) return '-';
                if (unique.length === 1) return unique[0];
                return multipleLabel;
            };

            if (dataIdx >= 0) {
                dataInfo = uniqueOrSummary(
                    getColumnValues(dataIdx).map((v) => normalizeBrDashDate(v)),
                    'Múltiplas datas'
                );
            }
            if (horaIdx >= 0) {
                horaInfo = uniqueOrSummary(getColumnValues(horaIdx), 'Múltiplos horários');
            }
            if (registradoIdx >= 0) {
                registradoPorInfo = uniqueOrSummary(getColumnValues(registradoIdx), 'Múltiplos registros');
            }

            [registradoIdx, horaIdx, dataIdx]
                .filter((idx) => idx >= 0)
                .sort((a, b) => b - a)
                .forEach((idx) => {
                    const currentHeadCells = table.querySelectorAll('thead th');
                    if (currentHeadCells[idx]) currentHeadCells[idx].remove();
                    table.querySelectorAll('tbody tr').forEach((row) => {
                        if (row.children[idx]) row.children[idx].remove();
                    });
                });
        }

        const headerInfo = headerEl?.querySelector('.print-header-info');
        if (headerInfo) {
            let meta = headerInfo.querySelector('.print-report-meta');
            if (!meta) {
                meta = document.createElement('p');
                meta.className = 'print-report-meta';
                headerInfo.appendChild(meta);
            }
            const dataHora = dataInfo === '-' && horaInfo === '-'
                ? '-'
                : `${dataInfo}${horaInfo !== '-' ? ` às ${horaInfo}` : ''}`;
            meta.textContent = `Data/Hora: ${dataHora} • Registrado por: ${registradoPorInfo}`;
        }
    }

    const reportHtml = cloned.outerHTML || '';
    if (!reportHtml.trim()) return;
    const schoolInfo = await getSchoolInfo();
    const schoolInfoLine = buildSchoolInfoLine(schoolInfo);
    const reportTitle = expectedTitle;
    const baseHref = window.location.href.split('#')[0];
    const bodyContent = reportHtml.includes('printable-area')
        ? reportHtml
        : `<div class="printable-area">${reportHtml}</div>`;
    const html = `
        <html>
        <head>
            <title>${reportTitle}</title>
            <base href="${baseHref}">
            <script src="https://cdn.tailwindcss.com"><\/script>
            <link rel="stylesheet" href="style.css">
            <style>
                body { font-family: 'Inter', sans-serif; background: #f3f4f6; padding: 24px; }
                .print-header {
                    display: flex !important;
                    justify-content: space-between;
                    align-items: center;
                    padding-bottom: 1rem;
                    margin-bottom: 1.5rem;
                    border-bottom: 2px solid #e5e7eb;
                }
                .print-header img { max-height: 60px; width: auto; }
                .print-header-info { text-align: right; color: #1f2937; }
                .print-header-info h2 { font-size: 1.25rem; font-weight: 700; margin: 0; }
                .print-header-info p { font-size: 0.875rem; margin: 0; }
                .print-header-info .print-report-meta { font-size: 0.72rem; margin-top: 0.22rem; color: #4b5563; }
                .printable-area table thead th { background: #eef2f7 !important; }
                .printable-area table tbody tr:nth-child(odd) td { background: #ffffff !important; }
                .printable-area table tbody tr:nth-child(even) td { background: #f5f7fb !important; }
                .print-faltas-compact table { font-size: 10px; line-height: 1.02; table-layout: auto; width: 100%; }
                .print-faltas-compact th, .print-faltas-compact td { padding: 2px 4px !important; vertical-align: middle; }
                .print-faltas-compact th:nth-child(1), .print-faltas-compact td:nth-child(1) { white-space: nowrap; }
                .print-faltas-compact .print-header { margin-bottom: 0.75rem; padding-bottom: 0.55rem; }
                .print-faltas-compact .print-header-info h2 { font-size: 1.05rem; }
                .print-faltas-compact .print-header-info p { font-size: 0.72rem; }
                .print-faltas-compact .print-school-line { font-size: 0.66rem; margin-bottom: 0.12rem; }
                @media print {
                    @page { size: A4 portrait; margin: 8mm; }
                    body { background: #fff; padding: 0; }
                    body, .printable-area, .printable-area * {
                        -webkit-print-color-adjust: exact !important;
                        print-color-adjust: exact !important;
                    }
                    .no-print { display: none !important; }
                    .printable-area { width: 100%; }
                    .printable-area .max-h-96,
                    .printable-area .max-h-80,
                    .printable-area .overflow-x-auto,
                    .printable-area .overflow-y-auto,
                    .printable-area .overflow-auto {
                        max-height: none !important;
                        overflow: visible !important;
                    }
                }
            </style>
        </head>
        <body class="bg-gray-100 p-8">
            ${bodyContent}
        </body>
        </html>
    `;
    const newWindow = window.open('', '_blank');
    if (!newWindow) return;
    let printed = false;
    const triggerPrint = () => {
        if (printed || newWindow.closed) return;
        printed = true;
        injectSchoolInfoIntoPrintHeader(newWindow, schoolInfoLine);
        newWindow.focus();
        setTimeout(() => {
            if (!newWindow.closed) newWindow.print();
        }, 120);
    };
    newWindow.document.open();
    newWindow.document.write(html);
    newWindow.document.close();
    newWindow.addEventListener('load', triggerPrint, { once: true });
    setTimeout(triggerPrint, 900);
}

export async function openAlunoHistoricoModal(alunoId) {
    const modal = document.getElementById('aluno-historico-modal');
    if (!modal) return;
    const { data: aluno } = await safeQuery(db.from('alunos').select('nome_completo').eq('id', alunoId).single());
    const { data: presencas } = await safeQuery(
        db.from('presencas').select('data, registrado_em, status, justificativa').eq('aluno_id', alunoId).order('data', { ascending: false })
    );

    const alunoNomeEl = document.getElementById('historico-aluno-nome-impressao');
    if (alunoNomeEl) alunoNomeEl.textContent = aluno?.nome_completo || '';
    const tableBody = document.getElementById('aluno-historico-table-body');
    if (!tableBody) {
        modal.classList.remove('hidden');
        return;
    }
    tableBody.innerHTML = '<tr><td colspan="4" class="p-4 text-center">Carregando historico...</td></tr>';

    if (!presencas || presencas.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="4" class="p-4 text-center">Nenhum registro de frequencia encontrado.</td></tr>';
        modal.classList.remove('hidden');
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
    if (!assiduidadeModal) return;
    const anoSelAluno = document.getElementById('assiduidade-aluno-ano');
    const anoSelTurma = document.getElementById('assiduidade-turma-ano');
    const anoSelProf = document.getElementById('assiduidade-prof-ano');
    const defaultAno = state.anosLetivosCache.length > 0 ? String(state.anosLetivosCache[0]) : '';

    assiduidadeModal.classList.remove('hidden');

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
    window.setTimeout(() => {
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
    }, 0);
}

export async function generateAssiduidadeReport() {
    const baseHref = window.location.href.split('#')[0];
    const newWindow = window.open(baseHref, '_blank');
    newWindow.document.write(`
        <html>
        <head>
            <title>Relatorio de Assiduidade</title>
            <script src="https://cdn.tailwindcss.com"><\/script>
            <script src="https://cdn.jsdelivr.net/npm/chart.js"><\/script>
            <style>
                body { font-family: 'Inter', sans-serif; }
                .print-header { display: none; }
                @media print {
                    .no-print { display: none !important; }
                    .printable-area { position: absolute; left: 0; top: 0; width: 100%; }
                    body * { visibility: hidden; }
                    .printable-area, .printable-area * { visibility: visible; }
                    .print-header {
                        display: flex !important;
                        justify-content: flex-start;
                        gap: 16px;
                        align-items: center;
                        padding-bottom: 1rem;
                        margin-bottom: 1.5rem;
                        border-bottom: 2px solid #e5e7eb;
                    }
                    .print-header img { max-height: 60px; width: auto; }
                    .print-header-info { text-align: left; }
                    .print-header-info h2 { font-size: 1.25rem; font-weight: bold; margin: 0; }
                    .print-header-info p { font-size: 0.875rem; margin: 0; }
                    .print-header-info .print-school-line { font-size: 0.75rem; color: #6b7280; margin-bottom: 0.25rem; }
                    body[data-print-mode="simple"] .print-full-only { display: none !important; }
                    body[data-print-mode="full"] .print-simple-only { display: none !important; }
                    .printable-area .max-h-96,
                    .printable-area .overflow-x-auto,
                    .printable-area .overflow-y-auto,
                    .printable-area .overflow-auto {
                        max-height: none !important;
                        overflow: visible !important;
                    }
                }
                body[data-print-preview="true"] .print-only { display: block; }
                body[data-print-preview="true"] .no-print { display: none !important; }
                body[data-print-preview="true"] .printable-area .max-h-96,
                body[data-print-preview="true"] .printable-area .overflow-x-auto,
                body[data-print-preview="true"] .printable-area .overflow-y-auto,
                body[data-print-preview="true"] .printable-area .overflow-auto {
                    max-height: none !important;
                    overflow: visible !important;
                }
            </style>
        </head>
        <body class="bg-gray-100 p-8" data-print-mode="full">
            <div class="printable-area">
                <div id="report-content">
                    <div class="text-center">
                        <div class="loader" style="width: 48px; height: 48px; margin: auto;"></div>
                        <p class="mt-4 text-gray-600">Gerando relatorio, por favor aguarde...</p>
                    </div>
                </div>
            </div>
        </body>
        </html>
    `);
    newWindow.document.close();

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
                    if (window.__printInProgress) return;
                    window.__printInProgress = true;
                    document.body.dataset.printMode = mode || 'full';
                    document.body.dataset.printPreview = 'true';
                    setTimeout(() => {
                        if (window.renderPrintCharts) window.renderPrintCharts();
                        setTimeout(() => { window.print(); }, 300);
                    }, 50);
                    // Fallback in case afterprint doesn't fire (e.g. canceled dialog)
                    setTimeout(() => {
                        window.__printInProgress = false;
                        document.body.removeAttribute('data-print-preview');
                    }, 3000);
                };
                window.addEventListener('afterprint', () => {
                    window.__printInProgress = false;
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

            let query = db.from('presencas').select('status, justificativa, alunos!inner(id, nome_completo), turmas!inner(id, nome_turma, ano_letivo)');
            if (dataInicio) query = query.gte('data', dataInicio);
            if (dataFim) query = query.lte('data', dataFim);
            if (ano) query = query.eq('turmas.ano_letivo', ano);
            if (alunoId) query = query.eq('aluno_id', alunoId);
            const { data, error } = await safeQuery(query);
            if (error) throw error;

            const agrupado = {};
            (data || []).forEach(item => {
                const key = `${item.alunos.id}__${item.turmas.id}`;
                if (!agrupado[key]) {
                    agrupado[key] = {
                        aluno: item.alunos.nome_completo,
                        turma: item.turmas.nome_turma,
                        aluno_id: item.alunos.id,
                        turma_id: item.turmas.id,
                        presencas: 0,
                        faltasJ: 0,
                        faltasI: 0
                    };
                }
                if (item.status === 'presente') agrupado[key].presencas++;
                if (item.status === 'falta' && item.justificativa === 'Falta justificada') agrupado[key].faltasJ++;
                if (item.status === 'falta' && item.justificativa !== 'Falta justificada') agrupado[key].faltasI++;
            });

            const rows = Object.values(agrupado);
            const totalPresencas = rows.reduce((s, r) => s + r.presencas, 0);
            const totalFaltasJ = rows.reduce((s, r) => s + r.faltasJ, 0);
            const totalFaltasI = rows.reduce((s, r) => s + r.faltasI, 0);

            let autoMap = new Map();
            const alunoIds = Array.from(new Set(rows.map(r => r.aluno_id).filter(Boolean)));
            if (alunoIds.length > 0) {
                const { data: autoData } = await safeQuery(
                    db.from('apoia_encaminhamentos')
                        .select('aluno_id, auto_regra')
                        .eq('auto_faltas', true)
                        .in('aluno_id', alunoIds)
                );
                autoMap = new Map((autoData || []).map(a => [a.aluno_id, a.auto_regra]));
            }

            const formatAutoRegra = (regra) => {
                if (!regra) return '-';
                if (regra === 'faltas_consecutivas_5') return '5 seguidas';
                if (regra === 'faltas_intercaladas_7_30d') return '7/30 dias';
                return 'Auto';
            };

            const tableRows = rows.map(r => {
                const total = r.presencas + r.faltasJ + r.faltasI;
                const assiduidade = total ? Math.round((r.presencas / total) * 100) : 0;
                const autoRegra = autoMap.get(r.aluno_id);
                const autoLabel = formatAutoRegra(autoRegra);
                const autoHtml = autoRegra
                    ? `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-100 text-red-700">Apoia (${autoLabel})</span>`
                    : '-';
                return `
                    <tr>
                        <td class="p-3">${r.aluno}</td>
                        <td class="p-3">${r.turma}</td>
                        <td class="p-3 text-center">${r.presencas}</td>
                        <td class="p-3 text-center">${r.faltasJ}</td>
                        <td class="p-3 text-center">${r.faltasI}</td>
                        <td class="p-3 text-center">${assiduidade}%</td>
                        <td class="p-3 text-center">${autoHtml}</td>
                    </tr>
                `;
            }).join('');

            const reportHTML = `<div class="print-header"><img src="./logo.png"><div class="print-header-info"><h2>Relatorio de Assiduidade de Alunos</h2><p>${periodoTexto}</p></div></div><div class="flex justify-between items-center mb-6 no-print"><h1 class="text-2xl font-bold">Relatorio de Assiduidade de Alunos</h1><p class="text-sm text-gray-600">${periodoTexto}</p><div class="flex gap-2"><button onclick="preparePrint('simple')" class="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700">Imprimir simples</button><button onclick="preparePrint('full')" class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">Imprimir completa</button></div></div><div class="grid grid-cols-1 lg:grid-cols-3 gap-6"><div class="lg:col-span-1 bg-white p-4 rounded-lg shadow-md print-full-only"><div style="height: 320px; position: relative;"><canvas id="assiduidadeChart"></canvas></div></div><div class="lg:col-span-2 bg-white p-6 rounded-lg shadow-md"><h3 class="font-bold mb-4">Detalhes da Frequencia</h3><div class="max-h-96 overflow-y-auto"><table class="w-full text-sm"><thead class="bg-gray-50 sticky top-0"><tr><th class="p-3 text-left">Aluno</th><th class="p-3 text-left">Turma</th><th class="p-3 text-center">Presencas</th><th class="p-3 text-center">Faltas Just.</th><th class="p-3 text-center">Faltas Injust.</th><th class="p-3 text-center">Assiduidade</th><th class="p-3 text-center">Acompanhamento</th></tr></thead><tbody>${tableRows}</tbody></table></div></div></div>`;
            const chartScriptContent = `
                const ensureChart = (fn, tries = 0) => {
                    if (window.Chart) return fn();
                    if (tries > 50) return;
                    setTimeout(() => ensureChart(fn, tries + 1), 100);
                };
                const buildAssiduidadeChart = () => {
                    const ctx = document.getElementById('assiduidadeChart');
                    if (!ctx) return;
                    if (window.__assiduidadeChart) window.__assiduidadeChart.destroy();
                    const hasData = (${totalPresencas} + ${totalFaltasJ} + ${totalFaltasI}) > 0;
                    const labels = hasData
                        ? ['Presencas', 'Faltas Justificadas', 'Faltas Injustificadas']
                        : ['Sem dados'];
                    const data = hasData ? [${totalPresencas}, ${totalFaltasJ}, ${totalFaltasI}] : [1];
                    const colors = hasData ? ['#10B981', '#F59E0B', '#EF4444'] : ['#e5e7eb'];
                    window.__assiduidadeChart = new Chart(ctx, {
                        type: 'pie',
                        data: { labels, datasets: [{ data, backgroundColor: colors }] },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: false,
                            devicePixelRatio: 1,
                            layout: { padding: 8 },
                            plugins: {
                                legend: { position: 'bottom', labels: { boxWidth: 10, padding: 10, font: { size: 11 } } },
                                title: { display: true, text: 'Visao Geral da Frequencia' }
                            }
                        }
                    });
                };
                window.renderPrintCharts = () => ensureChart(buildAssiduidadeChart);
                ensureChart(buildAssiduidadeChart);
            `;
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
                    agrupado[key] = { turma: item.turmas.nome_turma, turma_id: item.turmas.id, presencas: 0, faltas: 0 };
                }
                if (item.status === 'presente') agrupado[key].presencas++;
                if (item.status === 'falta') agrupado[key].faltas++;
            });

            const rows = Object.values(agrupado);
            const totalPresencas = rows.reduce((s, r) => s + r.presencas, 0);
            const totalFaltas = rows.reduce((s, r) => s + r.faltas, 0);

            let autoByTurma = new Map();
            const turmaIdsAuto = Array.from(new Set(rows.map(r => r.turma_id).filter(Boolean)));
            if (turmaIdsAuto.length > 0) {
                const { data: autoData } = await safeQuery(
                    db.from('apoia_encaminhamentos')
                        .select('aluno_id, alunos!inner(turma_id)')
                        .eq('auto_faltas', true)
                        .in('alunos.turma_id', turmaIdsAuto)
                );
                (autoData || []).forEach(item => {
                    const tid = item.alunos?.turma_id;
                    if (!tid) return;
                    autoByTurma.set(tid, (autoByTurma.get(tid) || 0) + 1);
                });
            }

            const tableRows = rows.map(r => {
                const total = r.presencas + r.faltas;
                const assiduidade = total ? Math.round((r.presencas / total) * 100) : 0;
                const autoCount = autoByTurma.get(r.turma_id) || 0;
                return `
                    <tr>
                        <td class="p-3">${r.turma}</td>
                        <td class="p-3 text-center">${r.presencas}</td>
                        <td class="p-3 text-center">${r.faltas}</td>
                        <td class="p-3 text-center">${assiduidade}%</td>
                        <td class="p-3 text-center">${autoCount}</td>
                    </tr>
                `;
            }).join('');

            const reportHTML = `<div class="print-header"><img src="./logo.png"><div class="print-header-info"><h2>Relatorio de Assiduidade por Turma</h2><p>${periodoTexto}</p></div></div><div class="flex justify-between items-center mb-6 no-print"><h1 class="text-2xl font-bold">Relatorio de Assiduidade por Turma</h1><p class="text-sm text-gray-600">${periodoTexto}</p><div class="flex gap-2"><button onclick="preparePrint('simple')" class="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700">Imprimir simples</button><button onclick="preparePrint('full')" class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">Imprimir completa</button></div></div><div class="grid grid-cols-1 lg:grid-cols-3 gap-6"><div class="lg:col-span-1 bg-white p-4 rounded-lg shadow-md print-full-only"><div style="height: 320px; position: relative;"><canvas id="assiduidadeTurmaChart"></canvas></div></div><div class="lg:col-span-2 bg-white p-6 rounded-lg shadow-md"><h3 class="font-bold mb-4">Dados Consolidados</h3><div class="max-h-96 overflow-y-auto"><table class="w-full text-sm"><thead class="bg-gray-50 sticky top-0"><tr><th class="p-3 text-left">Turma</th><th class="p-3 text-center">Presencas</th><th class="p-3 text-center">Faltas</th><th class="p-3 text-center">Assiduidade</th><th class="p-3 text-center">Acomp. APOIA</th></tr></thead><tbody>${tableRows}</tbody></table></div></div></div>`;
            const chartScriptContent = `
                const ensureChart = (fn, tries = 0) => {
                    if (window.Chart) return fn();
                    if (tries > 50) return;
                    setTimeout(() => ensureChart(fn, tries + 1), 100);
                };
                const buildTurmaChart = () => {
                    const ctx = document.getElementById('assiduidadeTurmaChart');
                    if (!ctx) return;
                    if (window.__assiduidadeTurmaChart) window.__assiduidadeTurmaChart.destroy();
                    const hasData = (${totalPresencas} + ${totalFaltas}) > 0;
                    const labels = hasData ? ['Total de Presencas', 'Total de Faltas'] : ['Sem dados'];
                    const data = hasData ? [${totalPresencas}, ${totalFaltas}] : [1];
                    const colors = hasData ? ['#10B981', '#EF4444'] : ['#e5e7eb'];
                    window.__assiduidadeTurmaChart = new Chart(ctx, {
                        type: 'pie',
                        data: { labels, datasets: [{ label: 'Frequencia Geral', data, backgroundColor: colors }] },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: false,
                            devicePixelRatio: 1,
                            layout: { padding: 8 },
                            plugins: {
                                legend: { position: 'bottom', labels: { boxWidth: 10, padding: 10, font: { size: 11 } } },
                                title: { display: true, text: 'Frequencia Geral das Turmas' }
                            }
                        }
                    });
                };
                window.renderPrintCharts = () => ensureChart(buildTurmaChart);
                ensureChart(buildTurmaChart);
            `;
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
            const statusFilter = document.getElementById('assiduidade-prof-status').value;
            const isDateBlocked = (dateStr, turmaId, eventosList) => {
                return (eventosList || []).some(e => {
                    const inicio = e.data;
                    const fim = e.data_fim || e.data;
                    return dateStr >= inicio && dateStr <= fim && eventAppliesToTurma(e, turmaId);
                });
            };

            let profQuery = db.from('usuarios').select('user_uid, nome, status').eq('papel', 'professor');
            if (statusFilter) profQuery = profQuery.eq('status', statusFilter);
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

            let autoByTurma = new Map();
            if (turmaIds.length > 0) {
                const { data: autoData } = await safeQuery(
                    db.from('apoia_encaminhamentos')
                        .select('aluno_id, alunos!inner(turma_id)')
                        .eq('auto_faltas', true)
                        .in('alunos.turma_id', turmaIds)
                );
                (autoData || []).forEach(item => {
                    const tid = item.alunos?.turma_id;
                    if (!tid) return;
                    autoByTurma.set(tid, (autoByTurma.get(tid) || 0) + 1);
                });
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
                const autoCount = turmas.reduce((s, turmaId) => s + (autoByTurma.get(turmaId) || 0), 0);
                const baseName = p.nome || 'Professor';
                const suffix = p.status === 'inativo' ? ' <span class="text-xs text-gray-500">(inativo)</span>' : '';
                const professorLabel = (turmas.length === 0 ? `${baseName} - não vinculado` : baseName) + suffix;
                return { professor: professorLabel, lancadas, naoLancadas, assiduidade, detalhes, autoCount, sortKey: baseName };
            });
            rows.sort((a, b) => (a.sortKey || '').localeCompare((b.sortKey || ''), undefined, { sensitivity: 'base' }));

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
                    <td class="p-3 text-center">${r.autoCount}</td>
                    <td class="p-3 text-center">${r.assiduidade}%</td>
                </tr>
                `;
            }).join('');
            const simpleTableRows = rows.map(r => `
                <tr>
                    <td class="p-3">${r.professor}</td>
                    <td class="p-3 text-center">${r.lancadas}</td>
                    <td class="p-3 text-center">${r.naoLancadas}</td>
                    <td class="p-3 text-center">${r.autoCount}</td>
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
                            <div>
                                <div><span class="font-semibold">${r.lancadas + r.naoLancadas}</span> total</div>
                                <div class="mt-2 text-xs text-gray-600">Acomp. APOIA: ${r.autoCount}</div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            const printSummary = `
                <div class="print-only print-full-only print-summary print-page-break">
                    <div class="bg-white p-4 rounded-lg shadow-md mb-4">
                        <div class="print-chart-wrap">
                            <div class="print-chart-title">Visão Geral de Lançamentos</div>
                            <div class="print-chart-canvas"><canvas id="lancamentoChartPrint" width="260" height="260"></canvas></div>
                            <div class="print-chart-legend">
                                <span><span class="legend-dot legend-green"></span>Chamadas lançadas</span>
                                <span><span class="legend-dot legend-red"></span>Chamadas não lançadas</span>
                            </div>
                        </div>
                    </div>
                    <div class="bg-white p-6 rounded-lg shadow-md">
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
                                    <th class="p-3 text-center">Acomp. APOIA</th>
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
                    .print-chart-wrap { display: flex; flex-direction: column; align-items: center; gap: 8px; }
                    .print-chart-title { font-weight: 600; font-size: 0.95rem; color: #374151; }
                    .print-chart-canvas { width: 260px; height: 260px; position: relative; }
                    .print-chart-canvas canvas { width: 100% !important; height: 100% !important; }
                    .print-chart-legend { display: flex; gap: 16px; flex-wrap: wrap; justify-content: center; font-size: 0.75rem; color: #4b5563; }
                    .print-chart-legend span { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
                    .legend-dot { width: 10px; height: 10px; border-radius: 9999px; display: inline-block; }
                    .legend-green { background: #10B981; }
                    .legend-red { background: #EF4444; }
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
                                            <th class="p-3 text-center">Acomp. APOIA</th>
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
                    if (tries > 50) return;
                    setTimeout(() => ensureChart(fn, tries + 1), 100);
                };
                const buildChart = (ctx) => {
                    if (!ctx) return;
                    const isPrint = ctx.id === 'lancamentoChartPrint';
                    if (isPrint && window.__printChart) window.__printChart.destroy();
                    if (!isPrint && window.__screenChart) window.__screenChart.destroy();
                    const hasData = (${totalLancadas} + ${totalNaoLancadas}) > 0;
                    const labels = hasData ? ['Chamadas Lançadas', 'Chamadas Não Lançadas'] : ['Sem dados'];
                    const data = hasData ? [${totalLancadas}, ${totalNaoLancadas}] : [1];
                    const colors = hasData ? ['#10B981', '#EF4444'] : ['#e5e7eb'];
                    const chartInstance = new Chart(ctx, {
                        type: 'pie',
                        data: {
                            labels,
                            datasets: [{ data, backgroundColor: colors }]
                        },
                        options: {
                            responsive: !isPrint,
                            maintainAspectRatio: false,
                            aspectRatio: isPrint ? 1 : undefined,
                            animation: false,
                            devicePixelRatio: 1,
                            layout: { padding: 8 },
                            plugins: {
                                legend: {
                                    display: !isPrint,
                                    position: 'bottom',
                                    align: 'center',
                                    labels: { boxWidth: 10, padding: 10, font: { size: 11 } }
                                },
                                title: { display: !isPrint, text: 'Visão Geral de Lançamentos' }
                            }
                        }
                    });
                    if (isPrint) window.__printChart = chartInstance;
                    else window.__screenChart = chartInstance;
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

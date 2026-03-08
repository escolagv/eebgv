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

const state = {
    selectedDate: new Date(),
    calendarMonth: new Date().getMonth(),
    calendarYear: new Date().getFullYear(),
    data: []
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
    initQrModal();
});

function initDashboard() {
    const dateInput = document.getElementById('dashboard-date-input');
    const todayBtn = document.getElementById('dashboard-today-btn');
    const latestBtn = document.getElementById('dashboard-latest-btn');
    const latestClose = document.getElementById('latest-close-btn');
    const modal = document.getElementById('latest-modal');

    if (dateInput) {
        dateInput.value = getLocalDateString();
        dateInput.addEventListener('change', () => {
            const value = dateInput.value;
            if (value) {
                state.selectedDate = new Date(`${value}T00:00:00`);
                state.calendarMonth = state.selectedDate.getMonth();
                state.calendarYear = state.selectedDate.getFullYear();
                renderCalendar();
                loadDashboardData();
            }
        });
    }

    if (todayBtn) {
        todayBtn.addEventListener('click', () => {
            const now = new Date();
            state.selectedDate = now;
            state.calendarMonth = now.getMonth();
            state.calendarYear = now.getFullYear();
            if (dateInput) dateInput.value = getLocalDateString();
            renderCalendar();
            loadDashboardData();
        });
    }

    if (latestBtn && modal) {
        latestBtn.addEventListener('click', () => {
            modal.classList.remove('hidden');
            renderLatestList();
        });
    }

    if (latestClose && modal) {
        latestClose.addEventListener('click', () => modal.classList.add('hidden'));
    }
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.add('hidden');
        });
    }

    const prevBtn = document.getElementById('cal-prev');
    const nextBtn = document.getElementById('cal-next');
    if (prevBtn) prevBtn.addEventListener('click', () => changeMonth(-1));
    if (nextBtn) nextBtn.addEventListener('click', () => changeMonth(1));

    renderCalendar();
    loadDashboardData();
}

function initQrModal() {
    const openBtn = document.getElementById('qr-open-btn');
    const modal = document.getElementById('qr-modal');
    const closeBtn = document.getElementById('qr-close-btn');
    const newBtn = document.getElementById('qr-new-btn');
    if (!openBtn || !modal) return;

    openBtn.addEventListener('click', async () => {
        modal.classList.remove('hidden');
        await loadQrCode(false);
    });
    if (closeBtn) {
        closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
    }
    if (newBtn) {
        newBtn.addEventListener('click', async () => {
            await loadQrCode(true);
        });
    }
    modal.addEventListener('click', (event) => {
        if (event.target === modal) modal.classList.add('hidden');
    });
}

async function loadQrCode(forceNew = false) {
    const qrEl = document.getElementById('qr-code');
    const statusEl = document.getElementById('qr-status');
    if (!qrEl || !statusEl) return;
    statusEl.textContent = 'Gerando...';
    try {
        const { data: sessionData, error: sessionError } = await db.auth.getSession();
        if (sessionError || !sessionData?.session?.access_token) {
            statusEl.textContent = 'Sessão expirada. Faça login novamente.';
            return;
        }
        const response = await fetch(`${SUPABASE_URL}/functions/v1/enc_qr_issue`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${sessionData.session.access_token}`,
                apikey: SUPABASE_ANON_KEY
            },
            body: JSON.stringify({ force: forceNew })
        });
        const payload = await response.json();
        if (!response.ok) {
            statusEl.textContent = payload?.error || 'Falha ao gerar QR.';
            return;
        }
        const token = payload?.token;
        const expiresAt = payload?.expires_at;
        const usedAt = payload?.used_at;
        if (!token) {
            statusEl.textContent = 'Token não encontrado.';
            return;
        }
        const pwaUrl = new URL('/encaminhamentos/pwa.html', window.location.origin);
        pwaUrl.searchParams.set('token', token);
        pwaUrl.searchParams.set('v', Date.now().toString());
        qrEl.innerHTML = '';
        if (window.QRCode) {
            // qrcodejs
            new QRCode(qrEl, {
                text: pwaUrl.toString(),
                width: 220,
                height: 220
            });
        }
        const usedLabel = usedAt ? ' (já usado)' : '';
        statusEl.textContent = expiresAt ? `Expira às 18h${usedLabel}` : `QR pronto${usedLabel}`;
    } catch (err) {
        statusEl.textContent = 'Erro ao gerar QR.';
        console.error(err);
    }
}

function changeMonth(delta) {
    state.calendarMonth += delta;
    if (state.calendarMonth < 0) {
        state.calendarMonth = 11;
        state.calendarYear -= 1;
    }
    if (state.calendarMonth > 11) {
        state.calendarMonth = 0;
        state.calendarYear += 1;
    }
    renderCalendar();
}

function renderCalendar() {
    const monthYear = document.getElementById('cal-month-year');
    const grid = document.getElementById('cal-grid');
    if (!monthYear || !grid) return;

    const monthNames = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    monthYear.textContent = `${monthNames[state.calendarMonth]} ${state.calendarYear}`;
    grid.innerHTML = '';

    const firstDay = new Date(state.calendarYear, state.calendarMonth, 1);
    const startDay = firstDay.getDay();
    const daysInMonth = new Date(state.calendarYear, state.calendarMonth + 1, 0).getDate();
    const selectedWeek = getWeekRange(state.selectedDate);

    for (let i = 0; i < startDay; i += 1) {
        const empty = document.createElement('div');
        empty.className = 'h-7';
        grid.appendChild(empty);
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
        const date = new Date(state.calendarYear, state.calendarMonth, day);
        const dateStr = toDateString(date);
        const isInWeek = dateStr >= selectedWeek.start && dateStr <= selectedWeek.end;
        const isSelected = dateStr === toDateString(state.selectedDate);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `h-7 rounded-md text-xs ${isInWeek ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-100'} ${isSelected ? 'ring-2 ring-blue-500' : ''}`;
        btn.textContent = day;
        btn.addEventListener('click', () => {
            state.selectedDate = date;
            const dateInput = document.getElementById('dashboard-date-input');
            if (dateInput) dateInput.value = toDateString(date);
            renderCalendar();
            loadDashboardData();
        });
        grid.appendChild(btn);
    }
}

async function loadDashboardData() {
    const range = getWeekRange(state.selectedDate);
    const periodEl = document.getElementById('dashboard-period');
    if (periodEl) {
        periodEl.textContent = `Semana: ${formatDateBr(range.start)} a ${formatDateBr(range.end)} (Seg–Sex)`;
    }

    try {
        const year = getYearFromDateString(range.start);
        await ensureEncaminhamentosTableReady(year);
        const tableName = getEncaminhamentosTableName(year);
        const { data } = await safeQuery(
            db.from(tableName)
                .select('id, data_encaminhamento, aluno_id, aluno_nome, professor_uid, professor_nome, motivos, acoes_tomadas, providencias, status, status_ligacao, whatsapp_enviado, whatsapp_status')
                .gte('data_encaminhamento', range.start)
                .lte('data_encaminhamento', range.end)
                .order('data_encaminhamento', { ascending: false })
        );
        state.data = data || [];
        renderCards();
        renderMotivos();
        renderAcoesProvidencias();
        renderContato();
        renderLatestList();
    } catch (err) {
        console.error('Erro ao carregar dashboard:', err?.message || err);
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
        buildLine('Ligou', countLigou, total),
        buildLine('Atendeu', countAtendeu, total),
        buildLine('Não atendeu', countNaoAtendeu, total),
        buildLine('WhatsApp enviado', countWhats, total),
        buildLine('WhatsApp respondeu', countWhatsResp, total),
        buildLine('WhatsApp não respondeu', countWhatsNaoResp, total)
    ].join('');
}

function renderLatestList() {
    const list = document.getElementById('latest-list');
    if (!list) return;
    const latest = [...state.data].sort((a, b) => {
        const da = a.data_encaminhamento || '';
        const db = b.data_encaminhamento || '';
        if (da === db) return (b.id || 0) - (a.id || 0);
        return da < db ? 1 : -1;
    }).slice(0, 5);

    if (latest.length === 0) {
        list.innerHTML = '<p class="text-sm text-gray-500">Nenhum encaminhamento na semana selecionada.</p>';
        return;
    }
    list.innerHTML = latest.map(item => `
        <div class="p-3 border border-gray-200 rounded-md bg-gray-50">
            <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div class="font-semibold text-gray-800">${item.aluno_nome || 'Aluno'}</div>
                <div class="text-xs text-gray-500">${formatDateBr(item.data_encaminhamento || '')}</div>
            </div>
            <div class="text-sm text-gray-600 mt-1">Prof: ${item.professor_nome || '-'}</div>
            <div class="text-xs text-gray-500 mt-1">Motivos: ${item.motivos || '-'}</div>
        </div>
    `).join('');
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

    const rows = options.map(opt => {
        const count = counts.get(opt) || 0;
        return buildLine(opt, count, total);
    });
    return rows.join('');
}

function buildLine(label, count, total) {
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    return `
        <div class="flex items-center justify-between gap-3">
            <span class="text-gray-700">${label}</span>
            <span class="text-gray-500 text-xs">${pct}% <span class="text-gray-400">(${count})</span></span>
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

function getWeekRange(date) {
    const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = copy.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const monday = new Date(copy);
    monday.setDate(copy.getDate() + diff);
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);
    return { start: toDateString(monday), end: toDateString(friday) };
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

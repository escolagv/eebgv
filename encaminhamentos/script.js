import { db, safeQuery, getLocalDateString, formatDateTimeSP, getYearFromDateString, getEncaminhamentosTableName, ensureEncaminhamentosYear, getCurrentYear } from './js/core.js';
import { signOut, requireAdminSession } from './js/auth.js';

// ===================================================================
// DADOS PARA CHECKBOXES DINÂMICOS
// ===================================================================
const motivosOptions = [
    "Indisciplina / Xingamentos",
    "Gazeando aula",
    "Agressão / Bullying / Discriminação",
    "Uso de celular / fone de ouvido",
    "Dificuldade de aprendizado",
    "Desrespeito com professor / profissionais da unidade escolar",
    "Não produz e não participa em sala"
];
const acoesOptions = [
    "Diálogo com o estudante",
    "Comunicado aos responsáveis",
    "Mensagem via WhatsApp"
];
const providenciasOptions = [
    "Solicitar comparecimento do responsável na escola",
    "Advertência"
];

const SYNC_INTERVAL_MS = 15 * 60 * 1000;

const state = {
    currentUser: null,
    profile: null,
    alunos: [],
    professores: [],
    turmas: [],
    alunosById: new Map(),
    professoresById: new Map(),
    turmasById: new Map(),
    turmasAnoAtual: new Set(),
    anoLetivoAtual: null,
    syncTimer: null,
    encYear: null,
    editYear: null,
    currentCodigo: '',
    scanJob: null,
    scanUrl: ''
};

// ===================================================================
// INICIALIZAÇÃO
// ===================================================================
document.addEventListener('DOMContentLoaded', async () => {
    const encaminhamentoForm = document.getElementById('encaminhamentoForm');
    const salvarEdicaoButton = document.getElementById('btnSalvarEdicao');
    const logoutBtn = document.getElementById('logout-btn');
    const syncNowBtn = document.getElementById('sync-now-btn');

    createCheckboxes('motivos-container', motivosOptions, 'motivo');
    createCheckboxes('acoes-container', acoesOptions, 'acao');
    createCheckboxes('providencias-container', providenciasOptions, 'providencia');
    initSearchPanels();

    encaminhamentoForm.addEventListener('submit', saveRecord);
    salvarEdicaoButton.addEventListener('click', updateRecord);
    if (syncNowBtn) {
        syncNowBtn.addEventListener('click', async () => {
            await syncEncCache();
            await loadCaches();
        });
    }

    logoutBtn.addEventListener('click', async () => {
        await signOut();
        clearSyncTimer();
        window.location.href = 'login.html';
    });

    document.getElementById('estudante').addEventListener('change', handleAlunoChange);
    const dataEncInput = document.getElementById('dataEncaminhamento');
    if (dataEncInput) {
        dataEncInput.addEventListener('change', async () => {
            state.encYear = getYearFromDateString(dataEncInput.value);
            await ensureEncaminhamentosYear(state.encYear);
            await loadCodigoPreview(true);
        });
    }
    document.getElementById('numeroTelefone').addEventListener('input', updateContatoResumo);
    document.getElementById('horarioLigacao').addEventListener('input', updateContatoResumo);
    document.getElementById('recadoCom').addEventListener('input', updateContatoResumo);
    document.getElementById('responsavelNome').addEventListener('input', updateContatoResumo);
    document.getElementById('solicitacaoComparecimentoData').addEventListener('change', updateSolicitacaoComparecimento);
    document.getElementById('solicitacaoComparecimentoHora').addEventListener('change', updateSolicitacaoComparecimento);

    const whatsappCheckbox = document.getElementById('whatsapp-enviado');
    if (whatsappCheckbox) {
        const toggleWhatsapp = () => {
            const enabled = whatsappCheckbox.checked;
            document.querySelectorAll('input[name="whatsapp-status"]').forEach(radio => {
                radio.disabled = !enabled;
                if (!enabled) radio.checked = false;
            });
            updateContatoResumo();
        };
        whatsappCheckbox.addEventListener('change', toggleWhatsapp);
        document.querySelectorAll('input[name="whatsapp-status"]').forEach(radio => {
            radio.addEventListener('change', updateContatoResumo);
        });
        toggleWhatsapp();
    }

    const ligacaoCheckbox = document.getElementById('ligacao-realizada');
    if (ligacaoCheckbox) {
        const toggleLigacao = () => {
            const enabled = ligacaoCheckbox.checked;
            document.querySelectorAll('input[name="ligacao-status"]').forEach(radio => {
                radio.disabled = !enabled;
                if (!enabled) radio.checked = false;
            });
            updateContatoResumo();
        };
        ligacaoCheckbox.addEventListener('change', toggleLigacao);
        document.querySelectorAll('input[name="ligacao-status"]').forEach(radio => {
            radio.addEventListener('change', updateContatoResumo);
        });
        toggleLigacao();
    }

    switchToEditMode(false);
    await initApp();
});

async function initApp() {
    const { session, profile } = await requireAdminSession();
    if (session && profile) {
        await loadApp(session.user, profile);
    } else {
        window.location.href = 'login.html';
    }

    db.auth.onAuthStateChange(async (event, session) => {
        if (!session) {
            clearSyncTimer();
            window.location.href = 'login.html';
            return;
        }
        const result = await requireAdminSession();
        if (result.session && result.profile) {
            await loadApp(result.session.user, result.profile);
        } else {
            window.location.href = 'login.html';
        }
    });
}

async function loadApp(user, profile) {
    state.currentUser = user;
    state.profile = profile;
    document.getElementById('user-name').textContent = profile.nome || user.email || '-';
    document.getElementById('registradoPor').value = profile.nome || user.email || '';
    const registradoLabel = document.getElementById('registradoPorLabel');
    if (registradoLabel) registradoLabel.textContent = profile.nome || user.email || '';
    document.getElementById('dataEncaminhamento').value = getLocalDateString();
    state.encYear = getYearFromDateString(document.getElementById('dataEncaminhamento').value);
    await ensureEncaminhamentosYear(state.encYear);

    await syncEncCache();
    await loadCaches();
    await loadScanJobFromParams();
    checkEditMode();
    startSyncTimer();
    updateContatoResumo();
}

// ===================================================================
// SINCRONIZAÇÃO
// ===================================================================
function startSyncTimer() {
    clearSyncTimer();
    state.syncTimer = setInterval(() => {
        syncEncCache();
    }, SYNC_INTERVAL_MS);
}

function clearSyncTimer() {
    if (state.syncTimer) {
        clearInterval(state.syncTimer);
        state.syncTimer = null;
    }
}

async function syncEncCache() {
    const statusEl = document.getElementById('sync-status');
    try {
        if (statusEl) statusEl.textContent = 'Sincronizando...';
        await safeQuery(db.rpc('sync_enc_cache'));
        if (statusEl) statusEl.textContent = `OK ${formatDateTimeSP(new Date().toISOString())}`;
    } catch (err) {
        if (statusEl) statusEl.textContent = 'Falha';
        console.error('Falha ao sincronizar:', err?.message || err);
    }
}

// ===================================================================
// CARGA DE DADOS (CACHE)
// ===================================================================
async function loadCaches() {
    const [alunosRes, professoresRes, turmasRes] = await Promise.all([
        safeQuery(db.from('enc_alunos').select('id, nome_completo, matricula, turma_id, nome_responsavel, telefone, status').order('nome_completo')),
        safeQuery(db.from('enc_professores').select('user_uid, nome, status').order('nome')),
        safeQuery(db.from('turmas').select('id, nome_turma, ano_letivo'))
    ]);

    state.alunos = alunosRes.data || [];
    state.professores = professoresRes.data || [];
    state.turmas = turmasRes.data || [];
    state.anoLetivoAtual = getAnoLetivoAtual(state.turmas);
    state.turmasAnoAtual = new Set(
        state.turmas
            .filter(t => state.anoLetivoAtual && String(t.ano_letivo) === String(state.anoLetivoAtual))
            .map(t => Number(t.id))
    );
    state.alunosById = new Map(state.alunos.map(a => [Number(a.id), a]));
    state.professoresById = new Map(state.professores.map(p => [p.user_uid, p]));
    state.turmasById = new Map(state.turmas.map(t => [Number(t.id), t]));

    populateSelects();
    refreshSearchLists();
}

function populateSelects() {
    const professorSelect = document.getElementById('professor');
    const alunoSelect = document.getElementById('estudante');

    professorSelect.innerHTML = '<option value="">Selecione...</option>';
    state.professores.filter(p => p.status !== 'inativo').forEach(p => {
        const option = document.createElement('option');
        option.value = p.user_uid;
        option.textContent = p.nome || p.user_uid;
        professorSelect.appendChild(option);
    });

    alunoSelect.innerHTML = '<option value="">Selecione...</option>';
    state.alunos
        .filter(a => a.status !== 'inativo')
        .filter(a => {
            if (!state.anoLetivoAtual) return true;
            return state.turmasAnoAtual.has(Number(a.turma_id));
        })
        .forEach(a => {
            const option = document.createElement('option');
            option.value = a.id;
            option.textContent = a.nome_completo || `Aluno ${a.id}`;
            alunoSelect.appendChild(option);
        });
}

// ===================================================================
// BUSCA RÁPIDA (ALUNOS / PROFESSORES)
// ===================================================================
const searchPanels = {
    aluno: {
        panelId: 'aluno-search-panel',
        inputId: 'aluno-search-input',
        listId: 'aluno-search-list',
        selectId: 'estudante'
    },
    professor: {
        panelId: 'professor-search-panel',
        inputId: 'professor-search-input',
        listId: 'professor-search-list',
        selectId: 'professor'
    }
};

function initSearchPanels() {
    Object.entries(searchPanels).forEach(([type, cfg]) => {
        const panel = document.getElementById(cfg.panelId);
        const input = document.getElementById(cfg.inputId);
        const list = document.getElementById(cfg.listId);
        const select = document.getElementById(cfg.selectId);
        if (!panel || !input || !list || !select) return;

        const openPanel = () => {
            if (panel.classList.contains('hidden')) {
                panel.classList.remove('hidden');
                input.value = '';
                renderSearchList(type, '');
            }
            input.focus();
        };

        const blockNativeSelect = (event) => {
            event.preventDefault();
            select.blur();
            openPanel();
        };

        select.addEventListener('mousedown', blockNativeSelect);
        select.addEventListener('touchstart', blockNativeSelect, { passive: false });
        select.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
                event.preventDefault();
                openPanel();
            }
        });
        select.addEventListener('focus', () => {
            openPanel();
        });

        input.addEventListener('input', () => {
            renderSearchList(type, input.value);
        });

        document.addEventListener('click', (event) => {
            if (!panel.contains(event.target) && event.target !== select) {
                panel.classList.add('hidden');
            }
        });
    });
}

function refreshSearchLists() {
    renderSearchList('aluno', document.getElementById(searchPanels.aluno.inputId)?.value || '');
    renderSearchList('professor', document.getElementById(searchPanels.professor.inputId)?.value || '');
}

function renderSearchList(type, query) {
    const cfg = searchPanels[type];
    if (!cfg) return;
    const list = document.getElementById(cfg.listId);
    if (!list) return;

    const q = (query || '').trim().toLowerCase();
    const items = type === 'aluno'
        ? state.alunos.filter(a => a.status !== 'inativo').filter(a => {
            if (!state.anoLetivoAtual) return true;
            return state.turmasAnoAtual.has(Number(a.turma_id));
        })
        : state.professores.filter(p => p.status !== 'inativo');

    const filtered = !q ? items : items.filter(item => {
        if (type === 'aluno') {
            const nome = (item.nome_completo || '').toLowerCase();
            const matricula = (item.matricula || '').toLowerCase();
            return nome.includes(q) || matricula.includes(q);
        }
        const nome = (item.nome || '').toLowerCase();
        return nome.includes(q);
    });

    list.innerHTML = '';
    if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'py-2 text-gray-500 text-sm';
        empty.textContent = 'Nenhum resultado.';
        list.appendChild(empty);
        return;
    }

    filtered.forEach(item => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'w-full text-left px-2 py-1 hover:bg-gray-100';
        row.dataset.value = type === 'aluno' ? item.id : item.user_uid;
        if (type === 'aluno') {
            const matricula = item.matricula ? ` • ${item.matricula}` : '';
            const turma = item.turma_id ? state.turmasById.get(Number(item.turma_id)) : null;
            const turmaLabel = turma?.nome_turma ? ` • ${turma.nome_turma}` : '';
            row.textContent = `${item.nome_completo || ''}${matricula}${turmaLabel}`;
        } else {
            row.textContent = item.nome || item.user_uid;
        }
        row.addEventListener('click', () => {
            const select = document.getElementById(cfg.selectId);
            if (select) select.value = row.dataset.value || '';
            if (type === 'aluno') handleAlunoChange();
            const panel = document.getElementById(cfg.panelId);
            if (panel) panel.classList.add('hidden');
        });
        list.appendChild(row);
    });
}

function getAnoLetivoAtual(turmas) {
    const anos = (turmas || [])
        .map(t => parseInt(t.ano_letivo, 10))
        .filter(Number.isFinite);
    if (anos.length === 0) return null;
    return Math.max(...anos);
}

function handleAlunoChange() {
    const alunoId = Number(document.getElementById('estudante').value);
    const telefoneInput = document.getElementById('numeroTelefone');
    const responsavelInput = document.getElementById('responsavelNome');
    const aluno = state.alunosById.get(alunoId);
    telefoneInput.value = aluno?.telefone || '';
    responsavelInput.value = aluno?.nome_responsavel || '';
    updateContatoResumo();
    updateSolicitacaoComparecimento();
}

// ===================================================================
// FUNÇÕES DO SISTEMA (Formulário Principal)
// ===================================================================
function createCheckboxes(containerId, options, groupName) {
    const container = document.getElementById(containerId);
    if (!container) return;

    options.forEach(option => {
        const div = document.createElement('div');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.name = groupName; checkbox.value = option;
        const label = document.createElement('label');
        label.textContent = ` ${option}`; label.style.fontWeight = 'normal';
        div.appendChild(checkbox); div.appendChild(label);
        container.appendChild(div);
    });

    if (groupName === 'acao' || groupName === 'providencia' || groupName === 'motivo') {
        const divOutros = document.createElement('div');
        const checkboxOutros = document.createElement('input');
        checkboxOutros.type = 'checkbox'; checkboxOutros.name = groupName; checkboxOutros.value = 'Outros'; checkboxOutros.id = `${groupName}-outros-check`;
        const labelOutros = document.createElement('label');
        labelOutros.htmlFor = checkboxOutros.id; labelOutros.textContent = ' Outros:'; labelOutros.style.fontWeight = 'normal';
        const textOutros = document.createElement('input');
        textOutros.type = 'text'; textOutros.id = `${groupName}-outros-text`; textOutros.placeholder = 'Especifique...'; textOutros.style.display = 'inline'; textOutros.style.width = '65%'; textOutros.disabled = true;
        checkboxOutros.addEventListener('change', function() {
            textOutros.disabled = !this.checked;
            if (this.checked) { textOutros.focus(); } else { textOutros.value = ''; }
        });
        divOutros.appendChild(checkboxOutros); divOutros.appendChild(labelOutros); divOutros.appendChild(textOutros);
        container.appendChild(divOutros);
    }
}

async function saveRecord(e) {
    e.preventDefault();
    const newRecord = getFormData();
    if (!newRecord.registrado_por_uid) {
        showStatusMessage("Por favor, faça login novamente.", false);
        return;
    }
    if (!newRecord.aluno_id || !newRecord.professor_uid) {
        showStatusMessage("Selecione aluno e professor.", false);
        return;
    }
    setLoadingState(true, 'Salvando...');
    try {
        const encYear = getYearFromDateString(newRecord.data_encaminhamento);
        await ensureEncaminhamentosYear(encYear);
        const tableName = getEncaminhamentosTableName(encYear);
        const { data: created } = await safeQuery(db.from(tableName).insert(newRecord).select().single());
        await linkScanJob(created?.id);
        const codigoMsg = created?.codigo ? ` Código: ${created.codigo}` : '';
        showStatusMessage(`✅ Encaminhamento registrado com sucesso!${codigoMsg}`, true);
        resetForm();
    } catch (err) {
        handleSupabaseError(err);
    } finally {
        setLoadingState(false, 'Registrar Encaminhamento');
    }
}

async function updateRecord() {
    const recordId = document.getElementById('editId').value;
    if (!recordId) return;
    const updatedRecord = getFormData();
    setLoadingState(true, 'Atualizando...', true);
    try {
        const encYear = state.editYear || getYearFromDateString(updatedRecord.data_encaminhamento);
        await ensureEncaminhamentosYear(encYear);
        const tableName = getEncaminhamentosTableName(encYear);
        await safeQuery(
            db.from(tableName)
                .update({ ...updatedRecord, updated_at: new Date().toISOString() })
                .eq('id', recordId)
        );
        showStatusMessage('✅ Encaminhamento atualizado com sucesso!', true);
        setTimeout(() => {
            window.location.href = 'results.html';
        }, 1500);
    } catch (err) {
        handleSupabaseError(err);
    } finally {
        setLoadingState(false, 'Salvar Alterações', true);
    }
}

async function checkEditMode() {
    const params = new URLSearchParams(window.location.search);
    const recordId = params.get('editId');
    if (recordId) {
        const yearParam = Number(params.get('year')) || getCurrentYear();
        state.editYear = yearParam;
        await ensureEncaminhamentosYear(yearParam);
        const formTitle = document.getElementById('form-title');
        formTitle.textContent = "Editando Encaminhamento";
        showStatusMessage('Carregando dados...', false);
        document.getElementById('editId').value = recordId;
        try {
            const { data } = await safeQuery(
                db.from(getEncaminhamentosTableName(yearParam)).select('*').eq('id', recordId).single()
            );
            if (data) {
                populateForm(data);
                switchToEditMode(true);
                document.getElementById('status-message').style.display = 'none';
            } else {
                showStatusMessage('❌ Erro: Registro não encontrado.', false);
            }
        } catch (err) {
            handleSupabaseError(err);
        }
    } else {
        await loadCodigoPreview(true);
    }
}

async function loadScanJobFromParams() {
    const params = new URLSearchParams(window.location.search);
    const scanId = params.get('scanId');
    const editId = params.get('editId');
    if (!scanId || editId) return;

    try {
        const { data: job } = await safeQuery(
            db.from('enc_scan_jobs')
                .select('id, status, storage_path, mime_type, created_at, device_id')
                .eq('id', scanId)
                .single()
        );

        if (!job) return;
        state.scanJob = job;
        state.scanUrl = '';

        if (job.storage_path) {
            const { data: signed, error } = await db.storage
                .from('enc_temp')
                .createSignedUrl(job.storage_path, 60 * 60);
            if (!error && signed?.signedUrl) {
                state.scanUrl = signed.signedUrl;
            }
        }
        showScanPreview(job, state.scanUrl);
    } catch (err) {
        console.warn('Falha ao carregar scan:', err?.message || err);
    }
}

function showScanPreview(job, url) {
    const container = document.getElementById('scan-preview');
    const meta = document.getElementById('scan-meta');
    const img = document.getElementById('scan-image');
    const link = document.getElementById('scan-open-link');
    const clearBtn = document.getElementById('scan-clear-btn');
    if (!container || !meta || !img || !link) return;

    const created = job?.created_at ? formatDateTimeSP(job.created_at) : '-';
    const status = job?.status || 'novo';
    meta.textContent = `Enviado em ${created} • Status ${status}`;

    if (url) {
        img.src = url;
        link.href = url;
        link.classList.remove('hidden');
    } else {
        img.removeAttribute('src');
        link.classList.add('hidden');
    }

    container.classList.remove('hidden');
    if (clearBtn) {
        clearBtn.onclick = () => {
            clearScanPreview();
            const params = new URLSearchParams(window.location.search);
            params.delete('scanId');
            const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}`;
            window.history.replaceState({}, document.title, next);
        };
    }
}

function clearScanPreview() {
    state.scanJob = null;
    state.scanUrl = '';
    const container = document.getElementById('scan-preview');
    const img = document.getElementById('scan-image');
    const link = document.getElementById('scan-open-link');
    const meta = document.getElementById('scan-meta');
    if (container) container.classList.add('hidden');
    if (img) img.removeAttribute('src');
    if (link) link.classList.add('hidden');
    if (meta) meta.textContent = '-';
}

async function linkScanJob(encaminhamentoId) {
    if (!state.scanJob?.id || !encaminhamentoId) return;
    try {
        await safeQuery(
            db.from('enc_scan_jobs')
                .update({ status: 'vinculado', encaminhamento_id: encaminhamentoId })
                .eq('id', state.scanJob.id)
        );
    } catch (err) {
        console.warn('Falha ao vincular scan:', err?.message || err);
    }
}

function getFormData() {
    const isEditing = !!document.getElementById('editId')?.value;
    const alunoSelect = document.getElementById('estudante');
    const professorSelect = document.getElementById('professor');
    const alunoId = Number(alunoSelect.value || 0) || null;
    const professorUid = professorSelect.value || null;
    const aluno = alunoId ? state.alunosById.get(alunoId) : null;
    const alunoNomeSelecionado = alunoSelect.options[alunoSelect.selectedIndex]?.text || '';
    const professor = professorUid ? state.professoresById.get(professorUid) : null;
    const professorNomeSelecionado = professorSelect.options[professorSelect.selectedIndex]?.text || '';
    const turma = aluno ? state.turmasById.get(Number(aluno.turma_id)) : null;

    return {
        codigo: isEditing ? (document.getElementById('codigoEncaminhamento')?.value || state.currentCodigo || null)?.toString().replace(/\s+/g, '') || null : null,
        data_encaminhamento: document.getElementById('dataEncaminhamento').value,
        aluno_id: alunoId,
        aluno_nome: aluno?.nome_completo || alunoNomeSelecionado,
        professor_uid: professorUid,
        professor_nome: professor?.nome || professorNomeSelecionado,
        turma_id: aluno?.turma_id || null,
        turma_nome: turma?.nome_turma || '',
        motivos: getCheckboxValues('motivo'),
        detalhes_motivo: document.getElementById('detalhesMotivo').value,
        acoes_tomadas: getCheckboxValues('acao'),
        detalhes_acao: document.getElementById('detalhesAcao').value,
        responsavel_nome: document.getElementById('responsavelNome').value,
        numero_telefone: document.getElementById('numeroTelefone').value,
        horario_ligacao: document.getElementById('horarioLigacao').value || null,
        status_ligacao: getLigacaoStatus(),
        whatsapp_enviado: document.getElementById('whatsapp-enviado')?.checked || false,
        whatsapp_status: document.querySelector('input[name="whatsapp-status"]:checked')?.value || null,
        recado_com: document.getElementById('recadoCom').value,
        providencias: getCheckboxValues('providencia'),
        solicitacao_comparecimento: buildSolicitacaoComparecimento(),
        status: document.getElementById('status').value,
        outras_informacoes: document.getElementById('outrasInformacoes').value,
        registrado_por_uid: state.currentUser?.id || null,
        registrado_por_nome: state.profile?.nome || state.currentUser?.email || '',
        foto_storage_path: state.scanJob?.storage_path || null
    };
}

function populateForm(data) {
    state.currentCodigo = (data.codigo || '').toString().replace(/\s+/g, '');
    const codigoInput = document.getElementById('codigoEncaminhamento');
    if (codigoInput) codigoInput.value = state.currentCodigo;
    document.getElementById('dataEncaminhamento').value = data.data_encaminhamento || '';
    ensureSelectOption('professor', data.professor_uid, data.professor_nome || data.professor_uid);
    ensureSelectOption('estudante', data.aluno_id, data.aluno_nome || `Aluno ${data.aluno_id}`);
    document.getElementById('professor').value = data.professor_uid || '';
    document.getElementById('estudante').value = data.aluno_id || '';
    setCheckboxValues('motivo', data.motivos);
    document.getElementById('detalhesMotivo').value = data.detalhes_motivo || '';
    setCheckboxValues('acao', data.acoes_tomadas);
    document.getElementById('detalhesAcao').value = data.detalhes_acao || '';
    document.getElementById('responsavelNome').value = data.responsavel_nome || '';
    document.getElementById('numeroTelefone').value = data.numero_telefone || '';
    document.getElementById('horarioLigacao').value = data.horario_ligacao || '';
    setLigacaoStatus(data.status_ligacao || '');
    if (document.getElementById('whatsapp-enviado')) {
        document.getElementById('whatsapp-enviado').checked = !!data.whatsapp_enviado;
        document.querySelectorAll('input[name="whatsapp-status"]').forEach(radio => {
            radio.disabled = !data.whatsapp_enviado;
            radio.checked = radio.value === data.whatsapp_status;
        });
    }
    document.getElementById('recadoCom').value = data.recado_com || '';
    setSolicitacaoComparecimentoFields(data.solicitacao_comparecimento || '');
    updateContatoResumo();
    setCheckboxValues('providencia', data.providencias);
    document.getElementById('status').value = data.status || '';
    document.getElementById('outrasInformacoes').value = data.outras_informacoes || '';
    document.getElementById('registradoPor').value = data.registrado_por_nome || '';
}

async function loadCodigoPreview(force = false) {
    const codigoInput = document.getElementById('codigoEncaminhamento');
    if (!codigoInput) return;
    const isEditing = !!document.getElementById('editId')?.value;
    if (isEditing && state.currentCodigo) {
        codigoInput.value = state.currentCodigo;
        return;
    }
    const dataEnc = document.getElementById('dataEncaminhamento')?.value;
    const year = getYearFromDateString(dataEnc);
    if (!force && state.currentCodigo && state.encYear === year) {
        codigoInput.value = state.currentCodigo;
        return;
    }
    try {
        const { data } = await safeQuery(db.rpc('next_enc_codigo_preview', { p_data: dataEnc }));
        const codigo = typeof data === 'string' ? data : (Array.isArray(data) ? data[0] : data);
        state.currentCodigo = (codigo || '').toString().replace(/\s+/g, '');
        state.encYear = year;
        codigoInput.value = state.currentCodigo;
    } catch (err) {
        console.warn('Falha ao gerar codigo:', err?.message || err);
    }
}

function ensureSelectOption(selectId, value, label) {
    if (!value) return;
    const select = document.getElementById(selectId);
    if (!Array.from(select.options).some(opt => String(opt.value) === String(value))) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label || String(value);
        select.appendChild(option);
    }
}

function resetForm() {
    document.getElementById('encaminhamentoForm').reset();
    document.getElementById('form-title').textContent = 'Registrar Encaminhamento';
    document.getElementById('dataEncaminhamento').value = getLocalDateString();
    document.getElementById('registradoPor').value = state.profile?.nome || state.currentUser?.email || '';
    const registradoLabel = document.getElementById('registradoPorLabel');
    if (registradoLabel) registradoLabel.textContent = state.profile?.nome || state.currentUser?.email || '';
    if (document.getElementById('whatsapp-enviado')) {
        document.getElementById('whatsapp-enviado').checked = false;
        document.querySelectorAll('input[name="whatsapp-status"]').forEach(radio => {
            radio.checked = false;
            radio.disabled = true;
        });
    }
    if (document.getElementById('ligacao-realizada')) {
        document.getElementById('ligacao-realizada').checked = false;
        document.querySelectorAll('input[name="ligacao-status"]').forEach(radio => {
            radio.checked = false;
            radio.disabled = true;
        });
    }
    document.getElementById('responsavelNome').value = '';
    document.getElementById('solicitacaoComparecimentoData').value = '';
    document.getElementById('solicitacaoComparecimentoHora').value = '';
    updateContatoResumo();
    state.currentCodigo = '';
    clearScanPreview();
    loadCodigoPreview(true);
    switchToEditMode(false);
    window.history.pushState({}, document.title, window.location.pathname);
}

function switchToEditMode(isEditing) {
    const btnRegistrar = document.getElementById('btnRegistrar');
    const btnSalvar = document.getElementById('btnSalvarEdicao');

    btnRegistrar.disabled = isEditing;
    btnSalvar.disabled = !isEditing;

    btnRegistrar.classList.toggle('opacity-50', isEditing);
    btnRegistrar.classList.toggle('cursor-not-allowed', isEditing);
    btnSalvar.classList.toggle('opacity-50', !isEditing);
    btnSalvar.classList.toggle('cursor-not-allowed', !isEditing);
}

function showStatusMessage(message, isSuccess) {
    const statusMessage = document.getElementById('status-message');
    statusMessage.textContent = message;
    statusMessage.className = isSuccess ? 'success' : 'error';
    statusMessage.style.display = 'block';
    setTimeout(() => {
        statusMessage.style.display = 'none';
    }, 4000);
}

function handleSupabaseError(error) {
    console.error("Erro no Supabase: ", error);
    showStatusMessage(`❌ Erro de comunicação com o banco de dados: ${error.message || error}`, false);
}

function setLoadingState(isLoading, text, isEditing = false) {
    const button = isEditing ? document.getElementById('btnSalvarEdicao') : document.getElementById('btnRegistrar');
    button.disabled = isLoading;
    button.textContent = text;
}

function getCheckboxValues(name) {
    const selected = [];
    document.querySelectorAll(`input[name="${name}"]:checked`).forEach(checkbox => {
        if (checkbox.value === "Outros") {
            const outrosTexto = document.getElementById(`${name}-outros-text`);
            if (outrosTexto && outrosTexto.value) {
                selected.push("Outros: " + outrosTexto.value);
            }
        } else {
            selected.push(checkbox.value);
        }
    });
    return selected.join(', ');
}

function setCheckboxValues(name, valuesString) {
    if (!valuesString) return;
    const values = valuesString.split(', ');
    document.querySelectorAll(`input[name="${name}"]`).forEach(checkbox => {
        checkbox.checked = values.includes(checkbox.value);
        if (checkbox.value === "Outros") {
            const outrosValue = values.find(v => v.startsWith("Outros: "));
            if (outrosValue) {
                checkbox.checked = true;
                const textInput = document.getElementById(`${name}-outros-text`);
                if (textInput) {
                    textInput.value = outrosValue.replace("Outros: ", "");
                    textInput.disabled = false;
                }
            }
        }
    });
}

function updateContatoResumo() {
    const telefone = document.getElementById('numeroTelefone').value.trim();
    const horario = document.getElementById('horarioLigacao').value.trim();
    const ligacaoRealizada = document.getElementById('ligacao-realizada')?.checked;
    const statusLigacao = document.querySelector('input[name="ligacao-status"]:checked')?.value || '';
    const whatsappEnviado = document.getElementById('whatsapp-enviado')?.checked;
    const whatsappStatus = document.querySelector('input[name="whatsapp-status"]:checked')?.value || '';
    const recadoCom = document.getElementById('recadoCom').value.trim();
    const responsavel = document.getElementById('responsavelNome').value.trim();

    const partes = [];
    if (responsavel) partes.push(`Responsável: ${responsavel}`);
    if (telefone) partes.push(`Telefone: ${telefone}`);
    if (ligacaoRealizada) {
        const horarioLabel = horario ? ` às ${horario}` : '';
        if (statusLigacao) {
            partes.push(`Ligação: ${statusLigacao}${horarioLabel}`);
        } else {
            partes.push(`Ligação: realizada${horarioLabel}`);
        }
    } else if (horario) {
        partes.push(`Contato: ${horario}`);
    }
    if (recadoCom) partes.push(`Recado com ${recadoCom}`);

    if (whatsappEnviado) {
        if (whatsappStatus) {
            partes.push(`WhatsApp: ${whatsappStatus}`);
        } else {
            partes.push('WhatsApp: enviado');
        }
    }

    const resumoEl = document.getElementById('contatoResumo');
    if (resumoEl) resumoEl.value = partes.join(' | ');
}

function getLigacaoStatus() {
    const ligou = document.getElementById('ligacao-realizada')?.checked;
    if (!ligou) return null;
    const status = document.querySelector('input[name="ligacao-status"]:checked')?.value || '';
    return status || 'Ligou';
}

function setLigacaoStatus(value) {
    const ligacaoCheckbox = document.getElementById('ligacao-realizada');
    if (!ligacaoCheckbox) return;
    const status = (value || '').trim();
    if (status) {
        ligacaoCheckbox.checked = true;
        document.querySelectorAll('input[name="ligacao-status"]').forEach(radio => {
            radio.disabled = false;
            radio.checked = radio.value === status;
        });
    } else {
        ligacaoCheckbox.checked = false;
        document.querySelectorAll('input[name="ligacao-status"]').forEach(radio => {
            radio.disabled = true;
            radio.checked = false;
        });
    }
}

function buildSolicitacaoComparecimento() {
    const data = document.getElementById('solicitacaoComparecimentoData')?.value || '';
    const hora = document.getElementById('solicitacaoComparecimentoHora')?.value || '';
    if (!data && !hora) return '';
    if (data) {
        const [yyyy, mm, dd] = data.split('-');
        const dataBR = dd && mm && yyyy ? `${dd}/${mm}/${yyyy}` : data;
        return hora ? `${dataBR} às ${hora}` : dataBR;
    }
    return hora;
}

function setSolicitacaoComparecimentoFields(value) {
    if (!value) return;
    const dataEl = document.getElementById('solicitacaoComparecimentoData');
    const horaEl = document.getElementById('solicitacaoComparecimentoHora');
    if (!dataEl || !horaEl) return;

    const text = value.trim();
    const brMatch = text.match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s*(?:às|as)\s*(\d{2}:\d{2}))?/i);
    if (brMatch) {
        const [, dd, mm, yyyy, hhmm] = brMatch;
        dataEl.value = `${yyyy}-${mm}-${dd}`;
        horaEl.value = hhmm || '';
        return;
    }

    const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}))?/);
    if (isoMatch) {
        const [, yyyy, mm, dd, hhmm] = isoMatch;
        dataEl.value = `${yyyy}-${mm}-${dd}`;
        horaEl.value = hhmm || '';
    }
}

function updateSolicitacaoComparecimento() {
    buildSolicitacaoComparecimento();
}

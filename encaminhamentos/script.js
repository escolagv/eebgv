import { db, safeQuery, getLocalDateString, formatDateTimeSP } from './js/core.js';
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
    syncTimer: null
};

// ===================================================================
// INICIALIZAÇÃO
// ===================================================================
document.addEventListener('DOMContentLoaded', async () => {
    const encaminhamentoForm = document.getElementById('encaminhamentoForm');
    const salvarEdicaoButton = document.getElementById('btnSalvarEdicao');
    const cancelarEdicaoButton = document.getElementById('btnCancelarEdicao');
    const logoutBtn = document.getElementById('logout-btn');
    const syncNowBtn = document.getElementById('sync-now-btn');

    createCheckboxes('motivos-container', motivosOptions, 'motivo');
    createCheckboxes('acoes-container', acoesOptions, 'acao');
    createCheckboxes('providencias-container', providenciasOptions, 'providencia');

    encaminhamentoForm.addEventListener('submit', saveRecord);
    salvarEdicaoButton.addEventListener('click', updateRecord);
    cancelarEdicaoButton.addEventListener('click', resetForm);
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

    const whatsappCheckbox = document.getElementById('whatsapp-enviado');
    if (whatsappCheckbox) {
        const toggleWhatsapp = () => {
            const enabled = whatsappCheckbox.checked;
            document.querySelectorAll('input[name="whatsapp-status"]').forEach(radio => {
                radio.disabled = !enabled;
                if (!enabled) radio.checked = false;
            });
        };
        whatsappCheckbox.addEventListener('change', toggleWhatsapp);
        toggleWhatsapp();
    }

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

    await syncEncCache();
    await loadCaches();
    checkEditMode();
    startSyncTimer();
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
        safeQuery(db.from('enc_alunos').select('id, nome_completo, matricula, turma_id, status').order('nome_completo')),
        safeQuery(db.from('enc_professores').select('user_uid, nome, status').order('nome')),
        safeQuery(db.from('turmas').select('id, nome_turma, ano_letivo'))
    ]);

    state.alunos = alunosRes.data || [];
    state.professores = professoresRes.data || [];
    state.turmas = turmasRes.data || [];
    state.alunosById = new Map(state.alunos.map(a => [Number(a.id), a]));
    state.professoresById = new Map(state.professores.map(p => [p.user_uid, p]));
    state.turmasById = new Map(state.turmas.map(t => [Number(t.id), t]));

    populateSelects();
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
        .forEach(a => {
            const option = document.createElement('option');
            option.value = a.id;
            option.textContent = a.nome_completo || `Aluno ${a.id}`;
            alunoSelect.appendChild(option);
        });
}

function handleAlunoChange() {
    const alunoId = Number(document.getElementById('estudante').value);
    const turmaInput = document.getElementById('turma');
    const aluno = state.alunosById.get(alunoId);
    const turma = aluno ? state.turmasById.get(Number(aluno.turma_id)) : null;
    turmaInput.value = turma ? turma.nome_turma : '';
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
        await safeQuery(
            db.from('enc_encaminhamentos').insert(newRecord).select().single()
        );
        showStatusMessage('✅ Encaminhamento registrado com sucesso!', true);
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
        await safeQuery(
            db.from('enc_encaminhamentos')
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
        const formTitle = document.getElementById('form-title');
        formTitle.textContent = "Editando Encaminhamento";
        showStatusMessage('Carregando dados...', false);
        document.getElementById('editId').value = recordId;
        try {
            const { data } = await safeQuery(
                db.from('enc_encaminhamentos').select('*').eq('id', recordId).single()
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
    }
}

function getFormData() {
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
        numero_telefone: document.getElementById('numeroTelefone').value,
        horario_ligacao: document.getElementById('horarioLigacao').value || null,
        status_ligacao: document.getElementById('statusLigacao').value,
        whatsapp_enviado: document.getElementById('whatsapp-enviado')?.checked || false,
        whatsapp_status: document.querySelector('input[name="whatsapp-status"]:checked')?.value || null,
        recado_com: document.getElementById('recadoCom').value,
        providencias: getCheckboxValues('providencia'),
        solicitacao_comparecimento: document.getElementById('solicitacaoComparecimento').value,
        status: document.getElementById('status').value,
        outras_informacoes: document.getElementById('outrasInformacoes').value,
        registrado_por_uid: state.currentUser?.id || null,
        registrado_por_nome: state.profile?.nome || state.currentUser?.email || ''
    };
}

function populateForm(data) {
    document.getElementById('dataEncaminhamento').value = data.data_encaminhamento || '';
    ensureSelectOption('professor', data.professor_uid, data.professor_nome || data.professor_uid);
    ensureSelectOption('estudante', data.aluno_id, data.aluno_nome || `Aluno ${data.aluno_id}`);
    document.getElementById('professor').value = data.professor_uid || '';
    document.getElementById('estudante').value = data.aluno_id || '';
    document.getElementById('turma').value = data.turma_nome || '';
    setCheckboxValues('motivo', data.motivos);
    document.getElementById('detalhesMotivo').value = data.detalhes_motivo || '';
    setCheckboxValues('acao', data.acoes_tomadas);
    document.getElementById('detalhesAcao').value = data.detalhes_acao || '';
    document.getElementById('numeroTelefone').value = data.numero_telefone || '';
    document.getElementById('horarioLigacao').value = data.horario_ligacao || '';
    document.getElementById('statusLigacao').value = data.status_ligacao || '';
    if (document.getElementById('whatsapp-enviado')) {
        document.getElementById('whatsapp-enviado').checked = !!data.whatsapp_enviado;
        document.querySelectorAll('input[name="whatsapp-status"]').forEach(radio => {
            radio.disabled = !data.whatsapp_enviado;
            radio.checked = radio.value === data.whatsapp_status;
        });
    }
    document.getElementById('recadoCom').value = data.recado_com || '';
    setCheckboxValues('providencia', data.providencias);
    document.getElementById('solicitacaoComparecimento').value = data.solicitacao_comparecimento || '';
    document.getElementById('status').value = data.status || '';
    document.getElementById('outrasInformacoes').value = data.outras_informacoes || '';
    document.getElementById('registradoPor').value = data.registrado_por_nome || '';
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
    document.getElementById('turma').value = '';
    switchToEditMode(false);
    window.history.pushState({}, document.title, window.location.pathname);
}

function switchToEditMode(isEditing) {
    document.getElementById('btnRegistrar').style.display = isEditing ? 'none' : 'block';
    document.getElementById('editButtons').style.display = isEditing ? 'grid' : 'none';
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

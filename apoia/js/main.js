import {
    db,
    state,
    getLocalDateString,
    getAuthRedirectUrl,
    resetInactivityTimer,
    resetLoginFormState,
    showToast,
    closeAllModals,
    closeModal,
    safeQuery,
    logAudit
} from './core.js';
import { initAuthHandlers, handleAuthChange, signOutUser } from './auth.js';
import { loadChamada, saveChamada, loadCorrecaoChamada, setChamadaRowStatus, updateChamadaSummary, applyChamadaFaltasFilter, marcarTodosPresentes } from './professor.js';
import {
    renderDashboardPanel,
    renderAlunosPanel,
    renderProfessoresPanel,
    renderTurmasPanel,
    renderApoiaPanel,
    renderCalendarioPanel,
    renderAnoLetivoPanel,
    renderChamadasPanel,
    renderRelatoriosPanel,
    renderConfigPanel,
    renderConsistenciaPanel,
    handleConsistenciaAnoFilterChange,
    openChamadaLogModal,
    handleGerarRelatorio,
    handleImprimirRelatorio,
    handleGerarApoiaRelatorio,
    openAlunoModal,
    openProfessorModal,
    openProfessorConsultaModal,
    openTurmaModal,
    openAcompanhamentoModal,
    openEventoModal,
    openAlunoHistoricoModal,
    openDeleteConfirmModal,
    handleConfirmDelete,
    handleResetPassword,
    handleResendProfessorConfirmation,
    handlePrintProfessorConsultaActiveTab,
    openAssiduidadeModal,
    handleChamadasCalendarSelect,
    handleChamadasCalendarNav,
    handleChamadasQuickDate,
    handleChamadasClearDates,
    handleChamadasToggleCalendar,
    handleChamadasCloseCalendar,
    handleChamadasProfessorFilterChange,
    handleChamadasTurmaFilterChange,
    handleChamadasRegistroFilterChange,
    handleChamadasAnoFilterChange,
    toggleChamadasExtraFilter,
    closeChamadasFilterPopovers,
    handleChamadasPageChange,
    generateAssiduidadeReport,
    openPromoverTurmasModal,
    handlePromoverTurmas,
    handleConfirmPromocaoTurmas,
    renderDashboardCalendar,
    setDashboardSelectedDate,
    loadDailySummary,
    renderPromocaoTurmasLista,
    handleLimparRelatorio,
    markAllNotificationsAsRead,
    markNotificationAsRead,
    handleAlunoFormSubmit,
    handleProfessorFormSubmit,
    handleTurmaFormSubmit,
    handleEventoFormSubmit,
    handleAcompanhamentoFormSubmit,
    handleConfigFormSubmit
} from './admin.js';

// ===============================================================
// INICIALIZACAO E EVENT LISTENERS
// ===============================================================

let professoresAutoRefreshId = null;
const PROFESSORES_AUTO_REFRESH_MS = 60000;

function stopProfessoresAutoRefresh() {
    if (professoresAutoRefreshId) {
        clearInterval(professoresAutoRefreshId);
        professoresAutoRefreshId = null;
    }
}

function startProfessoresAutoRefresh() {
    stopProfessoresAutoRefresh();
    professoresAutoRefreshId = setInterval(() => {
        const panel = document.getElementById('admin-professores-panel');
        if (!panel || panel.classList.contains('hidden')) {
            stopProfessoresAutoRefresh();
            return;
        }
        renderProfessoresPanel({ silent: true });
    }, PROFESSORES_AUTO_REFRESH_MS);
}

document.addEventListener('DOMContentLoaded', () => {
    const passwordInput = document.getElementById('password');
    const togglePasswordBtn = document.getElementById('toggle-password-btn');
    const eyeIcon = document.getElementById('eye-icon');
    const eyeOffIcon = document.getElementById('eye-off-icon');
    const professorPasswordInput = document.getElementById('professor-password');
    const professorPasswordToggle = document.getElementById('professor-password-show');
    const professorPhoneInput = document.getElementById('professor-telefone');
    const professorAccountPhoneInput = document.getElementById('professor-account-phone');
    const turmaSelect = document.getElementById('professor-turma-select');
    const salvarChamadaBtn = document.getElementById('salvar-chamada-btn');
    const notificationBell = document.getElementById('notification-bell');
    const notificationPanel = document.getElementById('notification-panel');
    const correcaoTurmaSelect = document.getElementById('correcao-turma-select');
    const correcaoDataSelect = document.getElementById('correcao-data-select');
    const professorDataText = document.getElementById('professor-data-text');
    const assiduidadeAlunoLookup = new Map();
    const assiduidadeTurmaLookup = new Map();
    const assiduidadeProfessorLookup = new Map();

    const normalizeSearchText = (value) => (value || '').trim().toLowerCase();
    const setAssiduidadeClearVisibility = (inputId, clearId) => {
        const input = document.getElementById(inputId);
        const clearBtn = document.getElementById(clearId);
        if (!input || !clearBtn) return;
        clearBtn.classList.toggle('hidden', !input.value.trim());
    };
    const rebuildAssiduidadeDatalist = ({ selectId, inputId, datalistId, lookup, clearId }) => {
        const select = document.getElementById(selectId);
        const input = document.getElementById(inputId);
        const datalist = document.getElementById(datalistId);
        if (!select || !input || !datalist) return;

        const selectedValue = select.value || '';
        lookup.clear();
        datalist.innerHTML = '';
        Array.from(select.options).forEach((opt) => {
            const label = String(opt.textContent || '').trim();
            const value = String(opt.value || '').trim();
            if (!label || !value) return;
            const optionEl = document.createElement('option');
            optionEl.value = label;
            datalist.appendChild(optionEl);
            lookup.set(normalizeSearchText(label), value);
        });

        const selectedOption = Array.from(select.options).find(opt => String(opt.value) === selectedValue);
        input.value = selectedOption && selectedOption.value ? String(selectedOption.textContent || '').trim() : '';
        setAssiduidadeClearVisibility(inputId, clearId);
    };
    const applyAssiduidadeSearchToSelect = ({ rawValue, selectId, inputId, lookup, clearId }) => {
        const select = document.getElementById(selectId);
        const input = document.getElementById(inputId);
        if (!select || !input) return;
        const normalized = normalizeSearchText(rawValue);
        const selected = lookup.get(normalized) || '';
        select.value = selected;
        setAssiduidadeClearVisibility(inputId, clearId);
    };
    const sortTurmaNome = (a, b) => String(a || '').localeCompare(String(b || ''), 'pt-BR', { numeric: true, sensitivity: 'base' });
    const renderAssiduidadeAlunoOptions = (anoLetivo) => {
        const alunoSel = document.getElementById('assiduidade-aluno-aluno');
        if (!alunoSel) return;
        const previousValue = String(alunoSel.value || '');
        alunoSel.innerHTML = '<option value="">Todos os Alunos</option>';
        if (anoLetivo) {
            const turmasDoAnoIds = state.turmasCache.filter(t => String(t.ano_letivo) === String(anoLetivo)).map(t => t.id);
            state.alunosCache
                .filter(a => turmasDoAnoIds.includes(a.turma_id))
                .sort((a, b) => String(a.nome_completo || '').localeCompare(String(b.nome_completo || ''), 'pt-BR', { sensitivity: 'base' }))
                .forEach((a) => {
                    const option = document.createElement('option');
                    option.value = a.id;
                    option.textContent = a.nome_completo || '';
                    alunoSel.appendChild(option);
                });
        }
        if (previousValue && Array.from(alunoSel.options).some(opt => String(opt.value) === previousValue)) {
            alunoSel.value = previousValue;
        }
        rebuildAssiduidadeDatalist({
            selectId: 'assiduidade-aluno-aluno',
            inputId: 'assiduidade-aluno-aluno-search',
            datalistId: 'assiduidade-aluno-aluno-options',
            lookup: assiduidadeAlunoLookup,
            clearId: 'assiduidade-aluno-aluno-clear'
        });
    };
    const renderAssiduidadeTurmaOptions = (anoLetivo) => {
        const turmaSel = document.getElementById('assiduidade-turma-turma');
        if (!turmaSel) return;
        const previousValue = String(turmaSel.value || '');
        turmaSel.innerHTML = '<option value="">Todas as Turmas</option>';
        if (anoLetivo) {
            state.turmasCache
                .filter(t => String(t.ano_letivo) === String(anoLetivo))
                .sort((a, b) => sortTurmaNome(a.nome_turma, b.nome_turma))
                .forEach((t) => {
                    const option = document.createElement('option');
                    option.value = t.id;
                    option.textContent = t.nome_turma || '';
                    turmaSel.appendChild(option);
                });
        }
        if (previousValue && Array.from(turmaSel.options).some(opt => String(opt.value) === previousValue)) {
            turmaSel.value = previousValue;
        }
        rebuildAssiduidadeDatalist({
            selectId: 'assiduidade-turma-turma',
            inputId: 'assiduidade-turma-turma-search',
            datalistId: 'assiduidade-turma-turma-options',
            lookup: assiduidadeTurmaLookup,
            clearId: 'assiduidade-turma-turma-clear'
        });
    };
    const renderAssiduidadeProfessorOptions = async (anoLetivo) => {
        const profSel = document.getElementById('assiduidade-prof-professor');
        if (!profSel) return;
        const previousValue = String(profSel.value || '');
        profSel.innerHTML = '<option value="">Todos os Professores</option>';

        if (anoLetivo) {
            const turmasIds = state.turmasCache.filter(t => String(t.ano_letivo) === String(anoLetivo)).map(t => t.id);
            if (turmasIds.length > 0) {
                const { data } = await db.from('professores_turmas').select('professor_id, usuarios(nome)').in('turma_id', turmasIds);
                const uniqueProfs = [];
                const seen = new Set();
                data?.forEach((d) => {
                    if (d.usuarios && !seen.has(d.professor_id)) {
                        seen.add(d.professor_id);
                        uniqueProfs.push({ id: d.professor_id, nome: d.usuarios.nome });
                    }
                });
                uniqueProfs
                    .sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR', { sensitivity: 'base' }))
                    .forEach((p) => {
                        const option = document.createElement('option');
                        option.value = p.id;
                        option.textContent = p.nome || '';
                        profSel.appendChild(option);
                    });
            }
        } else {
            state.usuariosCache
                .filter(u => u.papel === 'professor')
                .sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR', { sensitivity: 'base' }))
                .forEach((p) => {
                    const option = document.createElement('option');
                    option.value = p.user_uid;
                    option.textContent = p.nome || '';
                    profSel.appendChild(option);
                });
        }

        if (previousValue && Array.from(profSel.options).some(opt => String(opt.value) === previousValue)) {
            profSel.value = previousValue;
        }
        rebuildAssiduidadeDatalist({
            selectId: 'assiduidade-prof-professor',
            inputId: 'assiduidade-prof-professor-search',
            datalistId: 'assiduidade-prof-professor-options',
            lookup: assiduidadeProfessorLookup,
            clearId: 'assiduidade-prof-professor-clear'
        });
    };

    state.dashboardSelectedDate = getLocalDateString();
    if (professorDataText) {
        const [year, month, day] = getLocalDateString().split('-');
        professorDataText.textContent = `Hoje: ${day}/${month}/${year}`;
    }

    initAuthHandlers();
    ['click', 'mousemove', 'keypress', 'scroll'].forEach(event => document.addEventListener(event, resetInactivityTimer));
    db.auth.onAuthStateChange((event, session) => { handleAuthChange(event, session); });

    const phoneInput = document.getElementById('aluno-telefone');
    if (phoneInput) {
        phoneInput.addEventListener('input', (e) => {
            let x = e.target.value.replace(/\D/g, '').match(/(\d{0,2})(\d{0,5})(\d{0,4})/);
            e.target.value = !x[2] ? x[1] : '(' + x[1] + ') ' + x[2] + (x[3] ? '-' + x[3] : '');
        });
    }
    if (professorPhoneInput) {
        professorPhoneInput.addEventListener('input', (e) => {
            const digits = e.target.value.replace(/\D/g, '');
            if (!digits) {
                e.target.value = '';
                return;
            }
            const ddd = digits.slice(0, 2);
            const rest = digits.slice(2);
            if (!rest) {
                e.target.value = `(${ddd})`;
                return;
            }
            if (rest.length <= 5) {
                e.target.value = `(${ddd})${rest}`;
                return;
            }
            e.target.value = `(${ddd})${rest.slice(0, 5)}-${rest.slice(5)}`;
        });
    }
    if (professorAccountPhoneInput) {
        professorAccountPhoneInput.addEventListener('input', (e) => {
            const digits = e.target.value.replace(/\D/g, '');
            if (!digits) {
                e.target.value = '';
                return;
            }
            const ddd = digits.slice(0, 2);
            const rest = digits.slice(2);
            if (!rest) {
                e.target.value = `(${ddd})`;
                return;
            }
            if (rest.length <= 5) {
                e.target.value = `(${ddd})${rest}`;
                return;
            }
            e.target.value = `(${ddd})${rest.slice(0, 5)}-${rest.slice(5)}`;
        });
    }

    const setupSupportLinks = () => {
        const numero = '5548991004780';
        const mensagem = 'Olá! Mensagem enviada do Sistema de chamadas da EEB Getúlio Vargas. Preciso de suporte.';
        const url = `https://wa.me/${numero}?text=${encodeURIComponent(mensagem)}`;
        const linkProf = document.getElementById('support-link-prof');
        const linkAdmin = document.getElementById('support-link-admin');
        if (linkProf) { linkProf.href = url; linkProf.target = '_blank'; }
        if (linkAdmin) { linkAdmin.href = url; linkAdmin.target = '_blank'; }
    };
    setupSupportLinks();

    const noticeEl = document.getElementById('professor-password-notice');
    const dismissNoticeBtn = document.getElementById('dismiss-password-notice');
    if (noticeEl) noticeEl.classList.add('hidden');
    if (dismissNoticeBtn) {
        dismissNoticeBtn.addEventListener('click', () => {
            if (noticeEl) noticeEl.classList.add('hidden');
        });
    }

    const helpButtons = document.querySelectorAll('[data-open-help]');
    helpButtons.forEach(el => el.addEventListener('click', () => {
        const role = document.body.dataset.userRole || '';
        const url = role === 'professor'
            ? 'help.html?role=professor#professor-manual'
            : 'help.html#admin-manual';
        window.open(url, '_blank');
    }));

    if (togglePasswordBtn) {
        togglePasswordBtn.addEventListener('click', () => {
            const isPassword = passwordInput.type === 'password';
            passwordInput.type = isPassword ? 'text' : 'password';
            eyeIcon.classList.toggle('hidden', isPassword);
            eyeOffIcon.classList.toggle('hidden', !isPassword);
        });
    }
    if (professorPasswordToggle && professorPasswordInput) {
        professorPasswordToggle.addEventListener('change', () => {
            professorPasswordInput.type = professorPasswordToggle.checked ? 'text' : 'password';
        });
    }
    if (turmaSelect) turmaSelect.addEventListener('change', loadChamada);
    if (salvarChamadaBtn) salvarChamadaBtn.addEventListener('click', saveChamada);
    if (correcaoTurmaSelect) correcaoTurmaSelect.addEventListener('change', loadCorrecaoChamada);
    if (correcaoDataSelect) correcaoDataSelect.addEventListener('change', loadCorrecaoChamada);

    document.body.addEventListener('submit', async (e) => {
        e.preventDefault();
        const formId = e.target.id;

        if (formId === 'login-form') {
            const loginButton = e.target.querySelector('button[type="submit"]');
            const loginError = document.getElementById('login-error');
            const passwordValue = document.getElementById('password').value;
            state.lastLoginPassword = passwordValue;
            loginButton.disabled = true;
            loginButton.innerHTML = '<div class="loader mx-auto"></div>';
            loginError.textContent = '';

            try {
                const { error } = await db.auth.signInWithPassword({
                    email: document.getElementById('email').value,
                    password: passwordValue
                });
                if (error) {
                    loginError.textContent = 'E-mail ou senha incorretos. Verifique os dados e tente novamente.';
                    state.lastLoginPassword = null;
                    resetLoginFormState();
                }
            } catch (err) {
                loginError.textContent = 'Ocorreu um erro de conexão inesperado.';
                state.lastLoginPassword = null;
                resetLoginFormState();
            }
        }
        if (formId === 'forgot-password-form') {
            const email = document.getElementById('recovery-email').value;
            // Garante fluxo limpo de recuperação (sem sessão antiga ativa no mesmo navegador).
            try {
                const { data: sessionData } = await db.auth.getSession();
                if (sessionData?.session) {
                    await db.auth.signOut();
                }
            } catch (err) {
                console.warn('Falha ao limpar sessão antes da recuperação:', err?.message || err);
            }
            const { error } = await db.auth.resetPasswordForEmail(email, {
                redirectTo: getAuthRedirectUrl()
            });
            if (error) {
                showToast(`Erro: ${error.message}`, true);
            } else {
                showToast('Se o e-mail estiver correto, um link de recuperação foi enviado.');
                closeAllModals();
                const resetModal = document.getElementById('reset-password-modal');
                if (resetModal) resetModal.classList.add('hidden');
            }
        }
        if (formId === 'aluno-form') await handleAlunoFormSubmit(e);
        if (formId === 'professor-form') await handleProfessorFormSubmit(e);
        if (formId === 'turma-form') await handleTurmaFormSubmit(e);
        if (formId === 'evento-form') await handleEventoFormSubmit(e);
        if (formId === 'acompanhamento-form') await handleAcompanhamentoFormSubmit(e);
        if (formId === 'config-form') await handleConfigFormSubmit(e);
        if (formId === 'correcao-chamada-form') {
            const form = e.target;
            const turmaId = form.querySelector('#correcao-turma-select').value;
            const data = form.querySelector('#correcao-data-select').value;
            const alunoRows = form.querySelectorAll('[data-aluno-id]');
            const { data: existentes } = await safeQuery(
                db.from('presencas').select('aluno_id, registrado_em').eq('turma_id', turmaId).eq('data', data)
            );
            const existentesMap = new Map((existentes || []).map(p => [p.aluno_id, p.registrado_em]));
            const registroAgora = new Date().toISOString();
            const registros = Array.from(alunoRows).map(row => {
                const status = row.querySelector('.status-radio:checked').value;
                let justificativa = null;
                if (status === 'falta') {
                    const justRadio = row.querySelector(`input[name="corr-just-${row.dataset.alunoId}"]:checked`);
                    if (justRadio) {
                        if (justRadio.value === 'outros') {
                            justificativa = row.querySelector('.justificativa-outros-input').value.trim() || 'Outros';
                        } else {
                            justificativa = justRadio.value;
                        }
                    } else {
                        justificativa = 'Falta injustificada';
                    }
                }
                return {
                    aluno_id: parseInt(row.dataset.alunoId),
                    turma_id: parseInt(turmaId),
                    data: data,
                    status: status,
                    justificativa: justificativa,
                    registrado_por_uid: state.currentUser.id,
                    registrado_em: existentesMap.get(parseInt(row.dataset.alunoId)) || registroAgora
                };
            });
            const { error } = await safeQuery(db.from('presencas').upsert(registros, { onConflict: 'aluno_id, data' }));
            if (error) showToast('Erro ao salvar correcao: ' + error.message, true);
            else {
                await logAudit('chamada_correcao', 'presencas', null, { turma_id: parseInt(turmaId), data, total: registros.length });
                showToast('Chamada corrigida com sucesso!');
                closeModal(document.getElementById('correcao-chamada-modal'));
            }
        }
        if (formId === 'reset-password-form') {
            const newPassword = document.getElementById('new-password').value;
            const confirmPassword = document.getElementById('confirm-password').value;
            const errorEl = document.getElementById('reset-password-error');
            errorEl.textContent = '';
            if (newPassword.length < 6) { errorEl.textContent = 'A senha deve ter no mínimo 6 caracteres.'; return; }
            if (newPassword !== confirmPassword) { errorEl.textContent = 'As senhas não coincidem.'; return; }
            const { error } = await db.auth.updateUser({ password: newPassword });
            if (error) {
                errorEl.textContent = 'Erro ao atualizar a senha: ' + error.message;
            } else {
                if (state.currentUser?.id) {
                    try {
                        await safeQuery(
                            db.from('usuarios')
                                .update({ precisa_trocar_senha: false, senha_aviso_count: 0 })
                                .eq('user_uid', state.currentUser.id)
                        );
                        state.mustChangePassword = false;
                        state.senhaAvisoCount = 0;
                        const gate = document.getElementById('professor-force-password-modal');
                        if (gate) gate.classList.add('hidden');
                    } catch (err) {
                        console.warn('Falha ao atualizar flag de senha:', err?.message || err);
                    }
                }
                showToast('Senha atualizada com sucesso! Por favor, faça o login com sua nova senha.');
                closeAllModals();
                await signOutUser();
            }
        }
    });

    document.body.addEventListener('click', (e) => {
        const target = e.target;
        const closest = (selector) => target.closest(selector);

        if (target.id === 'appprof-modal') {
            target.classList.add('hidden');
        }

        if (closest('.date-clear-btn')) {
            const targetId = closest('.date-clear-btn').dataset.target;
            const input = document.getElementById(targetId);
            if (input) {
                input.value = '';
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }

        if (closest('#chamadas-periodo-clear')) {
            handleChamadasClearDates();
        }
        if (closest('#chamadas-calendar-toggle')) {
            e.stopPropagation();
            handleChamadasToggleCalendar();
        }
        if (closest('#chamadas-professor-clear')) {
            const input = document.getElementById('chamadas-professor-filter');
            if (input) {
                input.value = '';
                handleChamadasProfessorFilterChange('');
                input.focus();
            }
        }
        if (closest('#chamadas-turma-clear')) {
            const input = document.getElementById('chamadas-turma-filter');
            if (input) {
                input.value = '';
                handleChamadasTurmaFilterChange('');
                input.focus();
            }
        }
        if (closest('#chamadas-registro-clear')) {
            const input = document.getElementById('chamadas-registro-filter');
            if (input) {
                input.value = '';
                handleChamadasRegistroFilterChange('');
                input.focus();
            }
        }
        if (closest('#chamadas-ano-clear')) {
            const input = document.getElementById('chamadas-ano-filter');
            if (input) {
                input.value = '';
                handleChamadasAnoFilterChange('');
                input.focus();
            }
        }
        if (closest('#assiduidade-aluno-aluno-clear')) {
            const input = document.getElementById('assiduidade-aluno-aluno-search');
            const select = document.getElementById('assiduidade-aluno-aluno');
            if (input && select) {
                input.value = '';
                select.value = '';
                setAssiduidadeClearVisibility('assiduidade-aluno-aluno-search', 'assiduidade-aluno-aluno-clear');
                input.focus();
            }
        }
        if (closest('#assiduidade-turma-turma-clear')) {
            const input = document.getElementById('assiduidade-turma-turma-search');
            const select = document.getElementById('assiduidade-turma-turma');
            if (input && select) {
                input.value = '';
                select.value = '';
                setAssiduidadeClearVisibility('assiduidade-turma-turma-search', 'assiduidade-turma-turma-clear');
                input.focus();
            }
        }
        if (closest('#assiduidade-prof-professor-clear')) {
            const input = document.getElementById('assiduidade-prof-professor-search');
            const select = document.getElementById('assiduidade-prof-professor');
            if (input && select) {
                input.value = '';
                select.value = '';
                setAssiduidadeClearVisibility('assiduidade-prof-professor-search', 'assiduidade-prof-professor-clear');
                input.focus();
            }
        }
        if (closest('#chamadas-prev-month')) {
            e.stopPropagation();
            handleChamadasCalendarNav(-1);
        }
        if (closest('#chamadas-next-month')) {
            e.stopPropagation();
            handleChamadasCalendarNav(1);
        }
        if (closest('#chamadas-quick-today')) {
            e.stopPropagation();
            handleChamadasQuickDate('today');
        }
        if (closest('#chamadas-quick-yesterday')) {
            e.stopPropagation();
            handleChamadasQuickDate('yesterday');
        }
        if (closest('.chamadas-calendar-day')) {
            e.stopPropagation();
            const date = closest('.chamadas-calendar-day').dataset.date;
            handleChamadasCalendarSelect(date);
        }
        if (closest('[data-chamadas-page]')) {
            const page = parseInt(closest('[data-chamadas-page]').dataset.chamadasPage, 10);
            handleChamadasPageChange(page);
        }

        if (closest('#forgot-password-link')) {
            e.preventDefault();
            document.getElementById('forgot-password-modal').classList.remove('hidden');
        }

        const navLink = closest('.admin-nav-link');
        if (navLink) {
            e.preventDefault();
            document.querySelectorAll('.admin-nav-link').forEach(l => l.classList.remove('bg-gray-700'));
            navLink.classList.add('bg-gray-700');
            const targetPanelId = navLink.dataset.target;
            if (targetPanelId !== 'admin-professores-panel') {
                stopProfessoresAutoRefresh();
            }
            document.querySelectorAll('.admin-panel').forEach(p => p.classList.add('hidden'));
            const panel = document.getElementById(targetPanelId);
            if (panel) {
                panel.classList.remove('hidden');
                if (targetPanelId === 'admin-dashboard-panel') renderDashboardPanel();
                else if (targetPanelId === 'admin-alunos-panel') renderAlunosPanel({ defaultToLatestYear: true });
                else if (targetPanelId === 'admin-professores-panel') {
                    renderProfessoresPanel();
                    startProfessoresAutoRefresh();
                }
                else if (targetPanelId === 'admin-turmas-panel') renderTurmasPanel({ defaultToLatestYear: true });
                else if (targetPanelId === 'admin-apoia-panel') renderApoiaPanel();
                else if (targetPanelId === 'admin-calendario-panel') renderCalendarioPanel();
                else if (targetPanelId === 'admin-ano-letivo-panel') renderAnoLetivoPanel();
                else if (targetPanelId === 'admin-relatorios-panel') {
                    renderRelatoriosPanel();
                    document.getElementById('relatorio-data-inicio').value = '';
                    document.getElementById('relatorio-data-fim').value = '';
                }
                else if (targetPanelId === 'admin-chamadas-panel') renderChamadasPanel({ defaultToLatestYear: true });
                else if (targetPanelId === 'admin-consistencia-panel') renderConsistenciaPanel();
                else if (targetPanelId === 'admin-config-panel') renderConfigPanel();
            }
            document.querySelector('aside').classList.add('-translate-x-full');
            document.getElementById('sidebar-overlay').classList.add('hidden');
        }

        const card = closest('.clickable-card');
        if (card) {
            const type = card.dataset.type;
            if (type === 'presencas' || type === 'faltas') {
                const date = state.dashboardSelectedDate;
                document.querySelector('.admin-nav-link[data-target="admin-relatorios-panel"]').click();
                setTimeout(() => {
                    document.getElementById('relatorio-data-inicio').value = date;
                    document.getElementById('relatorio-data-fim').value = date;
                    if (type === 'faltas') document.getElementById('relatorio-status-select').value = 'falta';
                    if (type === 'presencas') document.getElementById('relatorio-status-select').value = 'presente';
                    handleGerarRelatorio();
                }, 100);
            } else if (type === 'assiduidade') {
                openAssiduidadeModal();
            } else if (type === 'acompanhamento') {
                document.querySelector('.admin-nav-link[data-target="admin-apoia-panel"]').click();
            }
        }

        if (closest('#add-aluno-btn')) openAlunoModal();
        if (closest('.edit-aluno-btn')) openAlunoModal(closest('.edit-aluno-btn').dataset.id);
        if (closest('.historico-aluno-btn')) openAlunoHistoricoModal(closest('.historico-aluno-btn').dataset.id);
        if (closest('#add-professor-btn')) openProfessorModal();
        if (closest('#professor-consulta-btn')) openProfessorConsultaModal();
        if (closest('#professor-consulta-print-btn')) handlePrintProfessorConsultaActiveTab();
        if (closest('.edit-professor-btn')) openProfessorModal(closest('.edit-professor-btn').dataset.id);
        if (closest('.resend-confirmation-btn')) {
            const btn = closest('.resend-confirmation-btn');
            handleResendProfessorConfirmation(
                btn.dataset.email,
                btn.dataset.phone || '',
                btn.dataset.name || ''
            );
        }
        if (closest('#open-appprof-modal-btn')) {
            const modal = document.getElementById('appprof-modal');
            const iframe = document.getElementById('appprof-iframe');
            if (iframe && !iframe.src) {
                iframe.src = iframe.dataset.src || '../appprof/';
            }
            if (modal) modal.classList.remove('hidden');
        }
        if (closest('#add-turma-btn')) openTurmaModal();
        if (closest('.edit-turma-btn')) openTurmaModal(closest('.edit-turma-btn').dataset.id);
        if (closest('.delete-turma-btn')) openDeleteConfirmModal('turma', closest('.delete-turma-btn').dataset.id);
        if (closest('#add-evento-btn')) openEventoModal();
        if (closest('.edit-evento-btn')) openEventoModal(closest('.edit-evento-btn').dataset.id);

        if (closest('#add-acompanhamento-btn')) {
            openAcompanhamentoModal();
        }

        if (closest('.edit-acompanhamento-btn')) openAcompanhamentoModal(closest('.edit-acompanhamento-btn').dataset.id);
        if (closest('.status-toggle')) {
            const row = closest('.status-toggle').closest('[data-aluno-id]');
            if (row && row.dataset.editable !== 'false') {
                const newStatus = row.dataset.status === 'falta' ? 'presente' : 'falta';
                setChamadaRowStatus(row, newStatus);
                updateChamadaSummary();
                applyChamadaFaltasFilter();
            }
        }
        if (closest('#chamada-marcar-todos-presentes-btn')) {
            const btn = closest('#chamada-marcar-todos-presentes-btn');
            if (!btn.disabled) marcarTodosPresentes();
        }
        if (closest('.cancel-modal-btn')) closeAllModals();
        if (closest('.delete-btn')) {
            let id;
            const type = closest('.delete-btn').dataset.type;
            id = closest('.delete-btn').dataset.id;
            if (!id) {
                if (type === 'aluno') id = document.getElementById('aluno-id').value;
                else if (type === 'professor') id = document.getElementById('professor-id').value;
                else if (type === 'turma') id = document.getElementById('turma-id').value;
                else if (type === 'evento') id = document.getElementById('evento-id').value;
                else if (type === 'acompanhamento') id = document.getElementById('acompanhamento-id').value;
            }
            if (id) openDeleteConfirmModal(type, id);
        }
        if (closest('.reset-password-btn')) handleResetPassword(closest('.reset-password-btn').dataset.email);
        if (closest('#confirm-delete-btn')) handleConfirmDelete();
        if (closest('#admin-logout-btn') || closest('#professor-logout-btn')) signOutUser();
        if (closest('#gerar-relatorio-btn')) handleGerarRelatorio();
        if (closest('#limpar-relatorio-btn')) handleLimparRelatorio();
        if (closest('#imprimir-relatorio-btn')) handleImprimirRelatorio('faltas');
        if (closest('#gerar-apoia-relatorio-btn')) handleGerarApoiaRelatorio();
        if (closest('#imprimir-apoia-relatorio-btn')) handleImprimirRelatorio('apoia');
        if (closest('#imprimir-historico-btn')) handleImprimirRelatorio('historico');
        if (closest('#imprimir-chamada-log-btn')) handleImprimirRelatorio('chamada');
        if (closest('#chamadas-filter-turma-btn')) toggleChamadasExtraFilter('turma');
        if (closest('#chamadas-filter-registro-btn')) toggleChamadasExtraFilter('registro');
        if (closest('#chamadas-filter-ano-btn')) toggleChamadasExtraFilter('ano');
        if (!closest('.filter-popover-wrap')) {
            closeChamadasFilterPopovers();
        }
        if (closest('#refresh-consistencia-btn')) renderConsistenciaPanel();
        if (closest('.chamadas-log-row')) {
            const row = closest('.chamadas-log-row');
            openChamadaLogModal({
                date: row.dataset.chamadaDate,
                turmaId: row.dataset.chamadaTurmaId,
                turmaName: row.dataset.chamadaTurma,
                professorId: row.dataset.chamadaProfId,
                professorName: row.dataset.chamadaProfessor,
                adjusted: row.dataset.chamadaAjustada === '1'
            });
        }
        if (closest('#correcao-chamada-btn') || closest('#chamadas-correcao-btn')) {
            document.getElementById('correcao-chamada-modal').classList.remove('hidden');
            const sel = document.getElementById('correcao-turma-select');
            sel.innerHTML = '<option value="">Selecione uma turma...</option>';
            state.turmasCache.forEach(t => sel.innerHTML += `<option value="${t.id}">${t.nome_turma}</option>`);
            const dataInput = document.getElementById('correcao-data-select');
            if (dataInput) {
                dataInput.value = getLocalDateString();
            }
            if (sel.value && dataInput && dataInput.value) {
                loadCorrecaoChamada();
            }
        }
        if (closest('#prev-month-btn')) { state.dashboardCalendar.month--; if (state.dashboardCalendar.month < 0) { state.dashboardCalendar.month = 11; state.dashboardCalendar.year--; } renderDashboardCalendar(); }
        if (closest('#next-month-btn')) { state.dashboardCalendar.month++; if (state.dashboardCalendar.month > 11) { state.dashboardCalendar.month = 0; state.dashboardCalendar.year++; } renderDashboardCalendar(); }
        if (closest('.dashboard-aluno-link')) {
            e.preventDefault();
            openAlunoHistoricoModal(closest('.dashboard-aluno-link').dataset.alunoId);
        }
        if (closest('[data-date]')) {
            const newDate = closest('[data-date]').dataset.date;
            if (newDate) {
                setDashboardSelectedDate(newDate);
                loadDailySummary(state.dashboardSelectedDate);
            }
        }
        if (closest('#open-promover-turmas-modal-btn')) openPromoverTurmasModal();
        if (closest('#promover-turmas-btn')) handlePromoverTurmas();
        if (closest('#confirm-promocao-turmas-btn')) handleConfirmPromocaoTurmas();
        if (closest('#gerar-assiduidade-btn')) generateAssiduidadeReport();

        if (closest('#promover-turmas-toggle-all')) {
            const btn = closest('#promover-turmas-toggle-all');
            const checkboxes = document.querySelectorAll('#promover-turmas-lista .promocao-turma-checkbox');
            const shouldCheckAll = !Array.from(checkboxes).every(cb => cb.checked);
            checkboxes.forEach(cb => cb.checked = shouldCheckAll);
            btn.textContent = shouldCheckAll ? 'Desmarcar Todas' : 'Marcar Todas';
        }

        if (closest('#mobile-menu-btn')) {
            document.querySelector('aside').classList.remove('-translate-x-full');
            document.getElementById('sidebar-overlay').classList.remove('hidden');
        }
        if (closest('#sidebar-overlay')) {
            document.querySelector('aside').classList.add('-translate-x-full');
            document.getElementById('sidebar-overlay').classList.add('hidden');
        }
    });

    if (notificationBell) {
        notificationBell.addEventListener('click', (e) => {
            e.stopPropagation();
            notificationPanel.classList.toggle('hidden');
        });
    }

    document.addEventListener('click', (e) => {
        const notificationPanelLocal = document.getElementById('notification-panel');
        if (notificationPanelLocal && !notificationPanelLocal.classList.contains('hidden') && !e.target.closest('#notification-panel') && !e.target.closest('#notification-bell')) {
            notificationPanelLocal.classList.add('hidden');
        }
        const chamadasPanel = document.getElementById('chamadas-calendar-panel');
        if (chamadasPanel && !chamadasPanel.classList.contains('hidden')) {
            if (!e.target.closest('#chamadas-calendar-panel')
                && !e.target.closest('#chamadas-calendar-toggle')
                && !e.target.closest('.chamadas-calendar-day')
                && !e.target.closest('#chamadas-quick-today')
                && !e.target.closest('#chamadas-quick-yesterday')
                && !e.target.closest('#chamadas-prev-month')
                && !e.target.closest('#chamadas-next-month')) {
                handleChamadasCloseCalendar();
            }
        }
    });

    const clearNotificationsBtn = document.getElementById('clear-notifications-btn');
    if (clearNotificationsBtn) clearNotificationsBtn.addEventListener('click', markAllNotificationsAsRead);

    const notificationList = document.getElementById('notification-list');
    if (notificationList) {
        notificationList.addEventListener('click', (e) => {
            const item = e.target.closest('.notification-item');
            if (item) markNotificationAsRead(item.dataset.id);
        });
    }

    ['#chamada-lista-alunos', '#correcao-chamada-lista-alunos'].forEach(selector => {
        const container = document.querySelector(selector);
        if (container) {
            container.addEventListener('change', e => {
                if (e.target.classList.contains('falta-checkbox')) {
                    const row = e.target.closest('[data-aluno-id]');
                    if (row && row.dataset.editable !== 'false') {
                        setChamadaRowStatus(row, e.target.checked ? 'falta' : 'presente');
                        updateChamadaSummary();
                        applyChamadaFaltasFilter();
                    } else if (row) {
                        e.target.checked = row.dataset.status === 'falta';
                    }
                    return;
                }
                if (e.target.classList.contains('status-radio')) {
                    const row = e.target.closest('[data-aluno-id]');
                    const justDiv = row.querySelector('.justificativa-container');
                    const isFalta = e.target.value === 'falta';
                    if (justDiv) {
                        justDiv.classList.toggle('hidden', !isFalta);
                        if (isFalta) {
                            const radiosJust = Array.from(row.querySelectorAll('input[name^="just-"], input[name^="corr-just-"]'));
                            const hasChecked = radiosJust.some(r => r.checked);
                            if (!hasChecked) {
                                const injustificadaRadio = radiosJust.find(r => r.value === 'Falta injustificada');
                                if (injustificadaRadio) injustificadaRadio.checked = true;
                            }
                        }
                    }
                }
            });
            container.addEventListener('click', e => {
                const radio = e.target.closest('input.status-radio');
                if (!radio) return;
                const row = radio.closest('[data-aluno-id]');
                if (!row) return;
                const justDiv = row.querySelector('.justificativa-container');
                const isFalta = radio.value === 'falta';
                if (justDiv) {
                    justDiv.classList.toggle('hidden', !isFalta);
                    if (isFalta) {
                        const radiosJust = Array.from(row.querySelectorAll('input[name^="just-"], input[name^="corr-just-"]'));
                        const hasChecked = radiosJust.some(r => r.checked);
                        if (!hasChecked) {
                            const injustificadaRadio = radiosJust.find(r => r.value === 'Falta injustificada');
                            if (injustificadaRadio) injustificadaRadio.checked = true;
                        }
                    }
                }
            });
        }
    });

    const deleteCheckbox = document.getElementById('delete-confirm-checkbox');
    if (deleteCheckbox) {
        deleteCheckbox.addEventListener('change', (e) => {
            document.getElementById('confirm-delete-btn').disabled = !e.target.checked;
        });
    }

    document.body.addEventListener('change', async (e) => {
        if (e.target.matches('#turma-ano-letivo-filter, #aluno-ano-letivo-filter, #assiduidade-aluno-ano, #assiduidade-turma-ano, #assiduidade-prof-ano')) {
            e.target.dataset.userTouched = 'true';
        }
        if (e.target.matches('#turma-ano-letivo-filter')) renderTurmasPanel();
        else if (e.target.matches('#aluno-ano-letivo-filter')) {
            renderAlunosPanel({ resetTurmaFilter: true });
        } else if (e.target.matches('#aluno-turma-filter')) {
            renderAlunosPanel();
        } else if (e.target.matches('#chamadas-professor-filter')) {
            handleChamadasProfessorFilterChange(e.target.value);
        } else if (e.target.matches('#chamadas-turma-filter')) {
            handleChamadasTurmaFilterChange(e.target.value);
        } else if (e.target.matches('#chamadas-registro-filter')) {
            handleChamadasRegistroFilterChange(e.target.value);
        } else if (e.target.matches('#chamadas-ano-filter')) {
            handleChamadasAnoFilterChange(e.target.value);
        } else if (e.target.matches('#consistencia-ano-filter')) {
            handleConsistenciaAnoFilterChange(e.target.value);
        } else if (e.target.matches('#evento-data-inicio-filter') || e.target.matches('#evento-data-fim-filter')) {
            renderCalendarioPanel();
        } else if (e.target.matches('#promover-turmas-ano-origem')) {
            renderPromocaoTurmasLista();
        } else if (e.target.matches('#promover-turmas-confirm-checkbox')) {
            document.getElementById('confirm-promocao-turmas-btn').disabled = !e.target.checked;
        } else if (e.target.matches('#assiduidade-aluno-ano')) {
            await renderAssiduidadeAlunoOptions(e.target.value);
        } else if (e.target.matches('#assiduidade-turma-ano')) {
            await renderAssiduidadeTurmaOptions(e.target.value);
        }
        else if (e.target.matches('#assiduidade-prof-ano')) {
            await renderAssiduidadeProfessorOptions(e.target.value);
        }
    });

    const alunoSearchInput = document.getElementById('aluno-search-input');
    const alunoSearchClear = document.getElementById('aluno-search-clear');
    const updateAlunoSearchClear = () => {
        if (!alunoSearchInput || !alunoSearchClear) return;
        alunoSearchClear.classList.toggle('hidden', !alunoSearchInput.value);
    };
    if (alunoSearchInput) {
        alunoSearchInput.addEventListener('input', updateAlunoSearchClear);
        updateAlunoSearchClear();
    }
    if (alunoSearchClear && alunoSearchInput) {
        alunoSearchClear.addEventListener('click', () => {
            alunoSearchInput.value = '';
            updateAlunoSearchClear();
            renderAlunosPanel();
            alunoSearchInput.focus();
        });
    }

    document.body.addEventListener('input', (e) => {
        if (e.target.matches('#aluno-search-input')) {
            renderAlunosPanel();
        } else if (e.target.matches('#professor-search-input')) {
            renderProfessoresPanel();
        } else if (e.target.matches('#assiduidade-aluno-aluno-search')) {
            applyAssiduidadeSearchToSelect({
                rawValue: e.target.value,
                selectId: 'assiduidade-aluno-aluno',
                inputId: 'assiduidade-aluno-aluno-search',
                lookup: assiduidadeAlunoLookup,
                clearId: 'assiduidade-aluno-aluno-clear'
            });
        } else if (e.target.matches('#assiduidade-turma-turma-search')) {
            applyAssiduidadeSearchToSelect({
                rawValue: e.target.value,
                selectId: 'assiduidade-turma-turma',
                inputId: 'assiduidade-turma-turma-search',
                lookup: assiduidadeTurmaLookup,
                clearId: 'assiduidade-turma-turma-clear'
            });
        } else if (e.target.matches('#assiduidade-prof-professor-search')) {
            applyAssiduidadeSearchToSelect({
                rawValue: e.target.value,
                selectId: 'assiduidade-prof-professor',
                inputId: 'assiduidade-prof-professor-search',
                lookup: assiduidadeProfessorLookup,
                clearId: 'assiduidade-prof-professor-clear'
            });
        } else if (e.target.matches('#chamadas-professor-filter')) {
            handleChamadasProfessorFilterChange(e.target.value);
        } else if (e.target.matches('#chamadas-turma-filter')) {
            handleChamadasTurmaFilterChange(e.target.value);
        } else if (e.target.matches('#chamadas-registro-filter')) {
            handleChamadasRegistroFilterChange(e.target.value);
        } else if (e.target.matches('#chamadas-ano-filter')) {
            handleChamadasAnoFilterChange(e.target.value);
        }
    });
    document.body.addEventListener('change', (e) => {
        if (e.target.matches('#professor-status-filter')) {
            renderProfessoresPanel();
        } else if (e.target.matches('#professor-vinculo-filter')) {
            renderProfessoresPanel();
        }
    });

    const assiduidadeTabs = document.getElementById('assiduidade-tabs');
    if (assiduidadeTabs) {
        assiduidadeTabs.addEventListener('click', (e) => {
            e.preventDefault();
            const link = e.target.closest('a');
            if (!link || link.getAttribute('aria-current') === 'page') return;
            document.querySelectorAll('#assiduidade-tabs a').forEach(a => {
                a.removeAttribute('aria-current');
                a.classList.remove('text-indigo-600', 'border-indigo-500');
                a.classList.add('text-gray-500', 'hover:text-gray-700', 'hover:border-gray-300', 'border-transparent');
            });
            link.setAttribute('aria-current', 'page');
            link.classList.add('text-indigo-600', 'border-indigo-500');
            link.classList.remove('text-gray-500', 'hover:text-gray-700', 'hover:border-gray-300', 'border-transparent');
            document.querySelectorAll('.assiduidade-panel').forEach(p => p.classList.add('hidden'));
            const target = document.getElementById(link.dataset.target);
            if (target) target.classList.remove('hidden');
        });
    }

    // console.log('Sistema de Gestao de Faltas (Supabase) inicializado com todas as funcionalidades.');
});

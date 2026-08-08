// Nivel 1 — Reading (v2, 05/08/2026: 6 textos, 28 preguntas, todas multiple_choice,
// 5 bandas CEFR completas A1-C1). Reemplaza el v1 (3 textos, 12 preguntas, sin A1 ni
// B1) -- diseño final aprobado por Diana, ver
// claude/estado-sesion-5-agosto-reading-v2-cerrado.md. Las bandas B2 y C1 tienen DOS
// textos cada una (uno general + uno estilo OET Reading Part B); cada texto es un
// "grupo" propio en data/nivel1-reading.json, así que el módulo avanza por 7 grupos
// en total, no por 5 bandas -- el ceiling en sí sigue calculándose por banda
// (cefr_level de cada pregunta), no por grupo/texto.
//
// El estudiante lee el texto y responde sus preguntas antes de pasar al siguiente
// grupo. Cronómetro único de 20 minutos para el módulo completo (mismo patrón que
// Grammar): si se acaba el tiempo, igual guardamos todo lo pendiente (la pregunta donde
// estaba parado el estudiante y las que nunca llegó a ver, como "sin respuesta") para
// que las 28 preguntas queden registradas -- si faltan filas en student_responses, el
// Edge Function nunca considera terminado el módulo.
//
// Cada respuesta se guarda vía submit-response, que corrige server-side contra
// question_bank.correct_answer -- el navegador nunca lo ve. A pedido explícito de
// Diana, esta pantalla NO muestra ningún acierto ni puntaje en vivo, solo confirma que
// se guardó cada módulo.
const SUPABASE_FUNCTIONS_BASE = 'https://qqdxmmvhthwcqhgmvyic.supabase.co/functions/v1';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFxZHhtbXZodGh3Y3FoZ212eWljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MzY3NDQsImV4cCI6MjA5OTAxMjc0NH0.iP5BTeUjw8FnElgQzp9r1-iSR-B9USVMcKGRs-Yh8GA';

// Encadenamiento del Nivel 1: Reading es el cuarto y último módulo (Grammar -> Listening
// -> Writing -> Reading). Al terminar, el router decide si sigue OET, STEPS 2 o el link
// de Speaking directo -- ver siguiente.html y get-unlock-state (tarea 1.5/1.6).
const NEXT_STEP_URL = 'siguiente.html';
const NEXT_STEP_LABEL = 'Continuar';

const DEFAULT_TIME_LIMIT_SECONDS = 20 * 60;

const quizArea = document.getElementById('quizArea');
const resultArea = document.getElementById('resultArea');
const timerLabel = document.getElementById('timerLabel');
const timerBox = document.getElementById('timerBox');
const progressLabel = document.getElementById('progressLabel');
const progressFill = document.getElementById('progressFill');

let readingData = null;
let groups = [];
let currentGroupIndex = 0;
let currentAnswers = {}; // questionId -> opción elegida (todavía no confirmada guardada)
const savedAnswersByGroup = {}; // groupIndex -> { questionId: opción } (última respuesta ya guardada en el server)
let timeRemaining = DEFAULT_TIME_LIMIT_SECONDS;
let timerHandle = null;
let finished = false;
let saving = false;

async function init() {
  const sessionToken = sessionTokenOrRedirect();
  if (!sessionToken) return;
  const dataFile = sessionStorage.getItem('cp360_track') === 'NIVEL1_ONLY'
    ? 'data/nivel1-reading-general.json'
    : 'data/nivel1-reading.json';
  const res = await fetch(dataFile);
  readingData = await res.json();
  groups = readingData.texts;
  timeRemaining = Number(readingData.time_limit_seconds) > 0 ? Number(readingData.time_limit_seconds) : DEFAULT_TIME_LIMIT_SECONDS;

  startTimer();
  renderGroup();
}

function sessionTokenOrRedirect() {
  const token = sessionStorage.getItem('cp360_session_token');
  if (!token) {
    window.location.href = 'index.html';
    return null;
  }
  return token;
}

function startTimer() {
  updateTimerLabel();
  timerHandle = setInterval(() => {
    timeRemaining--;
    updateTimerLabel();
    if (timeRemaining <= 60) timerBox.classList.add('warning');
    if (timeRemaining <= 0) {
      clearInterval(timerHandle);
      finishReading(true);
    }
  }, 1000);
}

function updateTimerLabel() {
  if (!timerLabel) return;
  const m = Math.max(0, Math.floor(timeRemaining / 60));
  const s = Math.max(0, timeRemaining % 60);
  timerLabel.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function renderGroup() {
  const group = groups[currentGroupIndex];
  currentAnswers = { ...(savedAnswersByGroup[currentGroupIndex] || {}) };
  const totalGroups = groups.length;
  progressLabel.textContent = `Texto ${currentGroupIndex + 1} / ${totalGroups}`;
  progressFill.style.width = `${Math.round((currentGroupIndex / totalGroups) * 100)}%`;

  quizArea.innerHTML = `
    <div class="card question-card">
      <div class="q-index">Nivel CEFR: ${group.cefr_level}</div>
      <div class="passage-title">${escapeHtml(group.title)}</div>
      <div class="passage-box">${escapeHtml(group.passage_text)}</div>
      ${renderMultipleChoice(group)}
      <div class="nav-row">
        <button class="secondary" id="prevBtn" type="button" ${currentGroupIndex === 0 ? 'disabled' : ''}>Anterior</button>
        <button class="primary" id="nextBtn" type="button">${currentGroupIndex === totalGroups - 1 ? 'Finalizar' : 'Guardar y continuar'}</button>
      </div>
    </div>
  `;

  group.questions.forEach((q) => {
    const optionsList = document.getElementById(`options_${q.id}`);
    if (!optionsList) return;
    q.options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'option' + (currentAnswers[q.id] === opt ? ' selected' : '');
      btn.textContent = opt;
      btn.addEventListener('click', () => {
        currentAnswers[q.id] = opt;
        optionsList.querySelectorAll('.option').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
      optionsList.appendChild(btn);
    });
  });

  document.getElementById('prevBtn').addEventListener('click', () => {
    if (currentGroupIndex > 0) {
      currentGroupIndex--;
      renderGroup();
    }
  });
  document.getElementById('nextBtn').addEventListener('click', handleNext);
}

function renderMultipleChoice(group) {
  return group.questions.map((q) => `
    <div class="question-card" style="margin-top:20px;">
      <div class="q-text">${escapeHtml(q.question_text)}</div>
      <div id="options_${q.id}"></div>
    </div>
  `).join('');
}

async function handleNext() {
  if (saving) return;
  const sessionToken = sessionTokenOrRedirect();
  if (!sessionToken) return;
  const group = groups[currentGroupIndex];
  const totalGroups = groups.length;
  const nextBtn = document.getElementById('nextBtn');
  const errorEl = ensureErrorEl();
  saving = true;
  nextBtn.disabled = true;
  nextBtn.textContent = 'Guardando...';
  try {
    for (const q of group.questions) {
      const selected = currentAnswers[q.id];
      const result = await saveAnswer(sessionToken, q.id, selected);
      if (result === 'unauthorized') return; // ya redirigido a index.html
      if (result === 'error') {
        errorEl.textContent = 'No pudimos guardar tu respuesta. Intenta de nuevo.';
        errorEl.style.display = 'block';
        return;
      }
    }
    savedAnswersByGroup[currentGroupIndex] = { ...currentAnswers };
    if (currentGroupIndex < totalGroups - 1) {
      currentGroupIndex++;
      renderGroup();
    } else {
      finishReading(false);
    }
  } finally {
    saving = false;
    const btn = document.getElementById('nextBtn');
    if (btn) {
      btn.disabled = false;
      btn.textContent = currentGroupIndex === totalGroups - 1 ? 'Finalizar' : 'Guardar y continuar';
    }
  }
}

function ensureErrorEl() {
  let el = document.getElementById('readingError');
  if (!el) {
    el = document.createElement('p');
    el.id = 'readingError';
    el.className = 'note';
    el.style.color = '#c62828';
    el.style.display = 'none';
    quizArea.appendChild(el);
  }
  return el;
}

// Devuelve 'ok', 'error' (fallo de red o del server) o 'unauthorized' (sesión vencida,
// ya redirige a index.html).
async function saveAnswer(sessionToken, questionId, selected) {
  try {
    const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/submit-response`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        session_token: sessionToken,
        question_id: questionId,
        selected_answer: typeof selected === 'string' && selected.trim() ? selected : null,
      }),
    });
    if (!res.ok) {
      if (res.status === 401) {
        window.location.href = 'index.html';
        return 'unauthorized';
      }
      return 'error';
    }
    return 'ok';
  } catch (err) {
    return 'error';
  }
}

async function finishReading(timedOut) {
  if (finished) return;
  finished = true;
  clearInterval(timerHandle);

  if (timedOut) {
    const sessionToken = sessionStorage.getItem('cp360_session_token');
    if (sessionToken) {
      // Guardamos todo lo pendiente desde el texto donde estaba parado el estudiante
      // (si había elegido algo sin confirmar) hasta el final -- las preguntas que
      // nunca llegó a ver quedan como "sin respuesta", igual que en Grammar.
      for (let g = currentGroupIndex; g < groups.length; g++) {
        const group = groups[g];
        const answersForGroup = g === currentGroupIndex ? currentAnswers : {};
        const alreadySaved = savedAnswersByGroup[g] || {};
        for (const q of group.questions) {
          if (Object.prototype.hasOwnProperty.call(alreadySaved, q.id)) continue;
          const selected = answersForGroup[q.id];
          const result = await saveAnswer(sessionToken, q.id, selected);
          if (result === 'unauthorized') return; // ya redirigido a index.html
        }
      }
    }
  }

  renderDone(timedOut);
}

function renderDone(timedOut) {
  quizArea.style.display = 'none';
  resultArea.style.display = 'block';
  progressFill.style.width = '100%';
  progressLabel.textContent = `Texto ${groups.length} / ${groups.length}`;

  resultArea.innerHTML = `
    <div class="card">
      <h3>${timedOut ? 'Se acabó el tiempo — guardamos lo que respondiste' : 'Nivel 1 — Reading completado'}</h3>
      <p>Guardamos todas tus respuestas. Como en el resto de Nivel 1, no te mostramos aciertos ni puntaje en vivo -- nuestro equipo revisa los resultados completos más adelante.</p>
      <p>Ese era el último módulo del Nivel 1. Ahora te llevamos al siguiente paso.</p>
      <button class="primary" id="nextModuleBtn" type="button">${NEXT_STEP_LABEL}</button>
    </div>
  `;

  const nextBtn = document.getElementById('nextModuleBtn');
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      window.location.href = NEXT_STEP_URL;
    });
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

init();

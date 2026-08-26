// STEP 2 CK — Clinical Knowledge Assessment (module 'steps2' en question_bank).
//
// v2 (24/08/2026): el banco se rediseñó por completo -- ya no son 8 viñetas clínicas
// calificadas por conocimiento médico (formato USMLE), sino 16 preguntas de
// comprensión lectora en inglés (gist + vocabulario en contexto C1-C2) sobre el mismo
// texto de cada viñeta. Cada pregunta en data/steps2.json ya trae el texto completo
// embebido en question_text -- no hay un "passage" separado por grupo como en Nivel 1 /
// OET Reading, así que el módulo avanza pregunta por pregunta (16 pasos), no por
// texto/grupo.
//
// Cronómetro único para todo el módulo (time_limit_seconds en data/steps2.json, 30
// min) -- mismo patrón que Nivel 1 Reading/Grammar: si se acaba el tiempo, guardamos
// todo lo pendiente (la pregunta donde estaba parado el estudiante y las que nunca
// llegó a ver, como "sin respuesta") para que las 16 preguntas queden registradas.
//
// Puntaje: pass/fail puro contra STEPS2_PASS_THRESHOLD (75%), calculado server-side en
// submit-response (rama 'steps2') a partir de question_bank.correct_answer -- el
// navegador nunca lo ve. A pedido explícito de Diana (mismo criterio que el resto del
// Assessment), esta pantalla NO muestra ningún acierto ni puntaje en vivo, solo
// confirma que se guardó cada respuesta.
//
// Sin botón "Previous" (mismo criterio que OET Listening/Reading): una vez confirmado
// "Save and continue" en una pregunta, esa respuesta queda cerrada y no se vuelve a
// mostrar.
const SUPABASE_FUNCTIONS_BASE = 'https://qqdxmmvhthwcqhgmvyic.supabase.co/functions/v1';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFxZHhtbXZodGh3Y3FoZ212eWljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MzY3NDQsImV4cCI6MjA5OTAxMjc0NH0.iP5BTeUjw8FnElgQzp9r1-iSR-B9USVMcKGRs-Yh8GA';

// Después de STEP 2 CK vuelve al router (siguiente.html / get-unlock-state), que manda
// a speaking.html una vez que existe el sub_score steps2_reading.
const NEXT_MODULE_URL = 'siguiente.html';
const NEXT_MODULE_LABEL = 'Continue';
const DEFAULT_TIME_LIMIT_SECONDS = 30 * 60;

const quizArea = document.getElementById('quizArea');
const resultArea = document.getElementById('resultArea');
const timerLabel = document.getElementById('timerLabel');
const timerBox = document.getElementById('timerBox');
const progressLabel = document.getElementById('progressLabel');
const progressFill = document.getElementById('progressFill');

let steps2Data = null;
let questions = [];
let currentIndex = 0;
let currentAnswers = {}; // questionId -> opción elegida (todavía no confirmada guardada)
const savedAnswers = {}; // questionId -> opción ya guardada en el server
let timeRemaining = DEFAULT_TIME_LIMIT_SECONDS;
let timerHandle = null;
let finished = false;
let saving = false;

async function init() {
  const sessionToken = sessionTokenOrRedirect();
  if (!sessionToken) return;
  const res = await fetch('data/steps2.json');
  steps2Data = await res.json();
  questions = steps2Data.questions || [];
  timeRemaining = Number(steps2Data.time_limit_seconds) > 0 ? Number(steps2Data.time_limit_seconds) : DEFAULT_TIME_LIMIT_SECONDS;

  // Si el estudiante ya había respondido preguntas de este módulo (recargó la página o
  // entró de nuevo con el mismo código antes de terminar el attempt), retomamos en la
  // primera pregunta sin responder en vez de reiniciar desde la 1.
  const alreadyComplete = await restoreProgress(sessionToken);
  if (alreadyComplete) {
    finished = true;
    renderDone(false);
    return;
  }

  startTimer();
  renderQuestion();
}

// Pide a get-module-progress las respuestas ya guardadas de steps2 y posiciona
// currentIndex en la primera pregunta sin responder, precargando savedAnswers para las
// que ya están completas. Si falla (sin conexión), no bloquea: el módulo arranca desde
// la pregunta 1. Devuelve true si las 16 preguntas ya estaban respondidas.
async function restoreProgress(sessionToken) {
  try {
    const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/get-module-progress`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ session_token: sessionToken, module: 'steps2' }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    const savedByQuestionId = data.answers || {};

    let firstIncomplete = questions.length;
    questions.forEach((q, idx) => {
      if (Object.prototype.hasOwnProperty.call(savedByQuestionId, q.id)) {
        savedAnswers[q.id] = savedByQuestionId[q.id] === null ? '' : savedByQuestionId[q.id];
      } else if (firstIncomplete === questions.length) {
        firstIncomplete = idx;
      }
    });
    if (firstIncomplete === questions.length) return true; // todas respondidas
    currentIndex = firstIncomplete;
    return false;
  } catch (err) {
    return false;
  }
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
    if (timeRemaining <= 60 && timerBox) timerBox.classList.add('warning');
    if (timeRemaining <= 0) {
      clearInterval(timerHandle);
      finishModule(true);
    }
  }, 1000);
}

function updateTimerLabel() {
  if (!timerLabel) return;
  const m = Math.max(0, Math.floor(timeRemaining / 60));
  const s = Math.max(0, timeRemaining % 60);
  timerLabel.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function renderQuestion() {
  const q = questions[currentIndex];
  currentAnswers = {};
  if (Object.prototype.hasOwnProperty.call(savedAnswers, q.id)) {
    currentAnswers[q.id] = savedAnswers[q.id];
  }
  const total = questions.length;
  progressLabel.textContent = `Question ${currentIndex + 1} / ${total}`;
  progressFill.style.width = `${Math.round((currentIndex / total) * 100)}%`;

  quizArea.innerHTML = `
    <div class="card question-card">
      <div class="q-text" style="white-space:pre-wrap;">${escapeHtml(q.question_text)}</div>
      <div id="options_${q.id}"></div>
      <div class="nav-row">
        <button class="primary" id="nextBtn" type="button">${currentIndex === total - 1 ? 'Finish' : 'Save and continue'}</button>
      </div>
      <p class="note" id="steps2Error" style="color:#c62828; display:none;"></p>
    </div>
  `;

  const optionsList = document.getElementById(`options_${q.id}`);
  (q.options || []).forEach((opt) => {
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

  document.getElementById('nextBtn').addEventListener('click', handleNext);
}

async function handleNext() {
  if (saving || finished) return;
  const sessionToken = sessionTokenOrRedirect();
  if (!sessionToken) return;
  const q = questions[currentIndex];
  const total = questions.length;
  const nextBtn = document.getElementById('nextBtn');
  const errorEl = document.getElementById('steps2Error');
  saving = true;
  nextBtn.disabled = true;
  nextBtn.textContent = 'Saving...';
  try {
    const selected = currentAnswers[q.id];
    const result = await saveAnswer(sessionToken, q.id, selected);
    if (result === 'unauthorized') return; // ya redirigido a index.html
    if (result === 'error') {
      errorEl.textContent = 'We could not save your answer. Please try again.';
      errorEl.style.display = 'block';
      return;
    }
    savedAnswers[q.id] = selected;
    if (currentIndex < total - 1) {
      currentIndex++;
      renderQuestion();
    } else {
      finishModule(false);
    }
  } finally {
    saving = false;
    const btn = document.getElementById('nextBtn');
    if (btn) {
      btn.disabled = false;
      btn.textContent = currentIndex === total - 1 ? 'Finish' : 'Save and continue';
    }
  }
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

async function finishModule(timedOut) {
  if (finished) return;
  finished = true;
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }

  if (timedOut) {
    const sessionToken = sessionStorage.getItem('cp360_session_token');
    if (sessionToken) {
      // Guardamos todo lo pendiente desde la pregunta donde estaba parado el
      // estudiante (si había elegido algo sin confirmar) hasta el final -- las
      // preguntas que nunca llegó a ver quedan como "sin respuesta", igual que en
      // Nivel 1 Reading/Grammar, para que las 16 filas queden registradas.
      for (let i = currentIndex; i < questions.length; i++) {
        const q = questions[i];
        if (Object.prototype.hasOwnProperty.call(savedAnswers, q.id)) continue;
        const selected = i === currentIndex ? currentAnswers[q.id] : undefined;
        const result = await saveAnswer(sessionToken, q.id, selected);
        if (result === 'unauthorized') return; // ya redirigido a index.html
        savedAnswers[q.id] = selected;
      }
    }
  }

  renderDone(timedOut);
}

function renderDone(timedOut) {
  quizArea.style.display = 'none';
  resultArea.style.display = 'block';
  progressFill.style.width = '100%';
  progressLabel.textContent = `Question ${questions.length} / ${questions.length}`;

  resultArea.innerHTML = `
    <div class="card">
      <h3>${timedOut ? 'Time is up — we saved what you answered' : 'STEP 2 CK completed'}</h3>
      <p>All of your answers were saved. Our team reviews the full results afterwards.</p>
      <button class="primary" id="nextModuleBtn" type="button">${NEXT_MODULE_LABEL}</button>
    </div>
  `;

  const nextBtn = document.getElementById('nextModuleBtn');
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      window.location.href = NEXT_MODULE_URL;
    });
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

init();

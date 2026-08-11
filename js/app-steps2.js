// STEP 2 CK — Clinical Knowledge Assessment.
//
// Modulo aparte de Nivel 1: solo lo rinden los estudiantes ruteados a STEPS2 (reading
// >= B2 pero no los 4 skills >= B2 -- ver claude/flujo-objetivo.md y submit-response).
// 8 preguntas originales en formato USMLE/Step 2 CK (caso clinico + pregunta de opcion
// unica, 5 opciones), banco 100% propio -- ver claude/... (decision de copyright del
// 05/08/2026: el contenido original que subio Diana era de UWorld, no se cargo tal
// cual, se reescribio desde cero).
//
// A diferencia del resto de Nivel 1, STEP CK 2 es pass/fail puro (>=75% para aprobar,
// sin bandas CEFR -- cefr_level de estas preguntas es null en la base). El calculo lo
// hace submit-response server-side (rama nueva para module === 'steps2'); esta pantalla
// nunca muestra aciertos, puntaje ni si aprobo o no.
//
// Interfaz en ingles (a diferencia de Grammar/Listening/Writing/Reading, que tienen
// chrome en espanol): esto es literalmente el examen Step 2 CK real, no un modulo de
// aprendizaje de ingles.

const SUPABASE_FUNCTIONS_BASE = 'https://qqdxmmvhthwcqhgmvyic.supabase.co/functions/v1';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFxZHhtbXZodGh3Y3FoZ212eWljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MzY3NDQsImV4cCI6MjA5OTAxMjc0NH0.iP5BTeUjw8FnElgQzp9r1-iSR-B9USVMcKGRs-Yh8GA';

// Despues de STEP CK 2 vuelve al router (siguiente.html / get-unlock-state), igual que
// el resto de Nivel 1 -- una vez que existe el sub_score steps2_reading, el router manda
// a speaking.html.
const NEXT_STEP_URL = 'siguiente.html';
const NEXT_STEP_LABEL = 'Continue';

const DEFAULT_TIME_LIMIT_SECONDS = 15 * 60;

const quizArea = document.getElementById('quizArea');
const resultArea = document.getElementById('resultArea');
const timerLabel = document.getElementById('timerLabel');
const timerBox = document.getElementById('timerBox');
const progressLabel = document.getElementById('progressLabel');
const progressFill = document.getElementById('progressFill');

let stepsData = null;
let questions = [];
let currentIndex = 0;
const answers = new Map(); // questionId -> opcion elegida (todavia no confirmada guardada)
const savedAnswers = new Map(); // questionId -> ultima respuesta ya guardada en el server
let timeRemaining = DEFAULT_TIME_LIMIT_SECONDS;
let timerHandle = null;
let finished = false;
let saving = false;

async function init() {
  const sessionToken = sessionTokenOrRedirect();
  if (!sessionToken) return;
  try {
    const res = await fetch('data/steps2.json');
    stepsData = await res.json();
  } catch (err) {
    quizArea.innerHTML = '<p class="note">We could not load the questions. Please reload the page and try again.</p>';
    return;
  }
  questions = stepsData.questions || [];
  if (questions.length === 0) {
    quizArea.innerHTML = '<p class="note">No questions are configured for this module.</p>';
    return;
  }
  timeRemaining = Number(stepsData.time_limit_seconds) > 0 ? Number(stepsData.time_limit_seconds) : DEFAULT_TIME_LIMIT_SECONDS;

  // Si el estudiante ya había respondido preguntas de este módulo (recargó la página o
  // entró de nuevo con el mismo código antes de terminar el attempt), retomamos justo
  // donde se quedó en vez de reiniciar desde la pregunta 1 (pedido de Diana,
  // 10/08/2026).
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
// currentIndex en la primera pregunta sin responder. Si falla (sin conexión), no
// bloquea. Devuelve true si las preguntas ya estaban todas respondidas.
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

    let firstUnanswered = questions.length;
    questions.forEach((q, i) => {
      if (Object.prototype.hasOwnProperty.call(savedByQuestionId, q.id)) {
        const selected = savedByQuestionId[q.id];
        answers.set(q.id, selected);
        savedAnswers.set(q.id, selected);
      } else if (firstUnanswered === questions.length) {
        firstUnanswered = i;
      }
    });
    if (firstUnanswered === questions.length) return true;
    currentIndex = firstUnanswered;
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
      timerHandle = null;
      finishQuiz(true);
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
  const total = questions.length;
  if (progressLabel) progressLabel.textContent = `Question ${currentIndex + 1} / ${total}`;
  if (progressFill) progressFill.style.width = `${Math.round((currentIndex / total) * 100)}%`;

  const selected = answers.get(q.id);
  const promptHtml = escapeHtml(q.question_text).replace(/\n/g, '<br>');

  quizArea.innerHTML = `
    <div class="card question-card">
      <div class="q-text">${promptHtml}</div>
      <div id="optionsList"></div>
      <p class="note" id="saveError" style="color:#c62828; display:none;"></p>
      <div class="nav-row">
        <button class="secondary" id="prevBtn" type="button" ${currentIndex === 0 ? 'disabled' : ''}>Previous</button>
        <button class="primary" id="nextBtn" type="button" ${selected ? '' : 'disabled'}>
          ${currentIndex === total - 1 ? 'Finish' : 'Next'}
        </button>
      </div>
    </div>
  `;

  const optionsList = document.getElementById('optionsList');
  q.options.forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'option' + (selected === opt ? ' selected' : '');
    btn.textContent = opt;
    btn.addEventListener('click', () => {
      answers.set(q.id, opt);
      renderQuestion();
    });
    optionsList.appendChild(btn);
  });

  document.getElementById('prevBtn').addEventListener('click', () => {
    if (currentIndex > 0) { currentIndex--; renderQuestion(); }
  });
  document.getElementById('nextBtn').addEventListener('click', handleNext);
}

async function handleNext() {
  if (saving) return;
  const sessionToken = sessionTokenOrRedirect();
  if (!sessionToken) return;

  const q = questions[currentIndex];
  const selected = answers.get(q.id);
  const isLast = currentIndex === questions.length - 1;
  const nextBtn = document.getElementById('nextBtn');
  const errorEl = document.getElementById('saveError');

  saving = true;
  nextBtn.disabled = true;
  nextBtn.textContent = 'Saving...';
  errorEl.style.display = 'none';

  try {
    const result = await saveAnswer(sessionToken, q, selected);
    if (result === 'unauthorized') return; // ya redirige a index.html
    if (result === 'error') {
      errorEl.textContent = 'We could not save your answer. Please try again.';
      errorEl.style.display = 'block';
      return;
    }
    savedAnswers.set(q.id, selected);
    if (isLast) {
      finishQuiz(false);
    } else {
      currentIndex++;
      renderQuestion();
    }
  } finally {
    saving = false;
    const btn = document.getElementById('nextBtn');
    if (btn) {
      btn.disabled = false;
      btn.textContent = currentIndex === questions.length - 1 ? 'Finish' : 'Next';
    }
  }
}

// Devuelve 'ok', 'error' (fallo de red o del server) o 'unauthorized' (sesion vencida,
// ya redirige a index.html).
async function saveAnswer(sessionToken, q, selected) {
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
        question_id: q.id,
        selected_answer: typeof selected === 'string' && selected.trim() ? selected : null,
      }),
    });
    if (!res.ok) {
      if (res.status === 401) {
        sessionStorage.removeItem('cp360_session_token');
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

async function finishQuiz(timedOut) {
  if (finished) return;
  finished = true;
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }

  if (timedOut) {
    const sessionToken = sessionStorage.getItem('cp360_session_token');
    if (sessionToken) {
      // Igual que en Grammar/Reading: si se acaba el tiempo, guardamos lo que haya
      // quedado pendiente (la pregunta actual, si tenia algo elegido sin confirmar, y
      // las que nunca llego a ver, como "sin respuesta") para que las 8 preguntas
      // queden registradas y el modulo se marque completo server-side.
      for (let i = currentIndex; i < questions.length; i++) {
        const q = questions[i];
        if (savedAnswers.has(q.id)) continue;
        const selected = answers.get(q.id);
        const result = await saveAnswer(sessionToken, q, selected);
        if (result === 'unauthorized') return; // ya redirige a index.html
        savedAnswers.set(q.id, selected);
      }
    }
  }

  renderDone(timedOut);
}

function renderDone(timedOut) {
  if (timerBox) timerBox.style.display = 'none';
  quizArea.style.display = 'none';
  resultArea.style.display = 'block';
  if (progressFill) progressFill.style.width = '100%';
  if (progressLabel) progressLabel.textContent = `Question ${questions.length} / ${questions.length}`;

  resultArea.innerHTML = `
    <div class="card">
      <h3>${timedOut ? 'Time is up — we saved what you answered' : 'STEP 2 CK completed'}</h3>
      <p>All of your answers were saved. As with the rest of the assessment, we do not show your score or result on this screen.</p>
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

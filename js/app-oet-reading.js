// OET Reading — 3 partes con formatos distintos entre sí (a diferencia de Nivel 1
// Reading, que repite el mismo formato texto+preguntas en cada grupo):
//   Part A: dos textos cortos (Text A / Text B) + 5 preguntas de matching (elegir de
//           qué texto sale la información) + 3 preguntas de respuesta corta.
//   Part B: 4 extractos independientes, cada uno con su propio texto corto y 1
//           pregunta de opción múltiple (3 opciones).
//   Part C: un texto largo + 4 preguntas de opción múltiple (4 opciones), 100%
//           reescrito desde cero (el original que subió Diana era de un banco externo
//           -- confirmado por ella, ver claude/... -- decisión: reescribir, no usar).
//
// Timer visible (decisión de Diana, 06/08/2026), actualizado el mismo día: el límite es
// POR PARTE (A: 6 min, B: 8 min, C: 8 min -- ver time_limit_seconds en cada parte de
// data/oet-reading.json), no un total de 25 min para todo el módulo. Si se acaba el
// tiempo de una parte, se guarda lo que haya quedado pendiente de ESA parte y pasa
// automáticamente a la parte siguiente con un timer nuevo; solo cierra el módulo si la
// parte que se queda sin tiempo es la última (C).
//
// Puntaje: informativo únicamente (raw_score/max_score, sin banda CEFR ni
// aprobar/reprobar) -- ver rama nueva en submit-response para module 'oet_reading'.
//
// Cada parte muestra el/los texto(s) arriba y las preguntas debajo, en la MISMA
// vista (sin pestañas ni colapsables) -- el estudiante puede volver a leer el texto
// mientras elige sus respuestas, desplazándose dentro de la misma parte.
//
// Sin botón "Previous" entre partes (decisión de Diana, 06/08/2026): a diferencia de
// Nivel 1 Reading, en OET nunca se puede volver atrás a cambiar una respuesta después
// de pasar de parte -- una vez confirmado "Save and continue", esa parte queda
// cerrada. Dentro de la parte actual sí se puede cambiar de opción libremente antes
// de confirmar.
const SUPABASE_FUNCTIONS_BASE = 'https://qqdxmmvhthwcqhgmvyic.supabase.co/functions/v1';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFxZHhtbXZodGh3Y3FoZ212eWljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MzY3NDQsImV4cCI6MjA5OTAxMjc0NH0.iP5BTeUjw8FnElgQzp9r1-iSR-B9USVMcKGRs-Yh8GA';

const NEXT_MODULE_URL = 'siguiente.html';
const NEXT_MODULE_LABEL = 'Continue';
const DEFAULT_STEP_TIME_LIMIT_SECONDS = 8 * 60; // fallback si a una parte le falta time_limit_seconds en el JSON

const quizArea = document.getElementById('quizArea');
const resultArea = document.getElementById('resultArea');
const timerLabel = document.getElementById('timerLabel');
const timerBox = document.getElementById('timerBox');
const progressLabel = document.getElementById('progressLabel');
const progressFill = document.getElementById('progressFill');

let readingData = null;
let steps = []; // [{ key, label, questionIds: [...], render(container) }]
let currentStepIndex = 0;
let currentAnswers = {}; // questionId -> string (respuestas de la parte actual, sin confirmar)
const savedAnswersByStep = {}; // stepIndex -> { questionId: string }
let saving = false;
let finished = false;
let timerHandle = null;
let timeRemaining = DEFAULT_STEP_TIME_LIMIT_SECONDS;

async function init() {
  const sessionToken = sessionTokenOrRedirect();
  if (!sessionToken) return;
  const res = await fetch('data/oet-reading.json');
  readingData = await res.json();
  steps = buildSteps(readingData);

  // Si el estudiante ya había respondido preguntas de este módulo (recargó la página o
  // entró de nuevo con el mismo código antes de terminar el attempt), retomamos en la
  // primera parte con preguntas pendientes -- nunca hacia atrás, respetando la regla de
  // que una parte ya confirmada queda cerrada (pedido de Diana, 10/08/2026).
  const alreadyComplete = await restoreProgress(sessionToken);
  if (alreadyComplete) {
    finished = true;
    renderDone(false);
    return;
  }

  renderStep();
}

// Pide a get-module-progress las respuestas ya guardadas de oet_reading y posiciona
// currentStepIndex en la primera parte con alguna pregunta sin responder, precargando
// savedAnswersByStep para las partes ya completas. Si falla (sin conexión), no bloquea.
// Devuelve true si el módulo entero ya estaba completo.
async function restoreProgress(sessionToken) {
  try {
    const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/get-module-progress`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ session_token: sessionToken, module: 'oet_reading' }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    const savedByQuestionId = data.answers || {};

    let firstIncompleteStep = steps.length;
    steps.forEach((step, si) => {
      const allAnswered = step.questionIds.every((qid) =>
        Object.prototype.hasOwnProperty.call(savedByQuestionId, qid)
      );
      if (allAnswered) {
        const stepAnswers = {};
        step.questionIds.forEach((qid) => {
          stepAnswers[qid] = savedByQuestionId[qid] === null ? '' : savedByQuestionId[qid];
        });
        savedAnswersByStep[si] = stepAnswers;
      } else if (firstIncompleteStep === steps.length) {
        firstIncompleteStep = si;
      }
    });
    if (firstIncompleteStep === steps.length) return true;
    currentStepIndex = firstIncompleteStep;
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

function buildSteps(data) {
  const partA = data.partA;
  const partB = data.partB;
  const partC = data.partC;
  return [
    {
      key: 'partA',
      label: partA.part_label,
      timeLimitSeconds: partA.time_limit_seconds,
      questionIds: [...partA.matchingQuestions.map((q) => q.id), ...partA.shortAnswerQuestions.map((q) => q.id)],
      render: renderPartA,
    },
    {
      key: 'partB',
      label: partB.part_label,
      timeLimitSeconds: partB.time_limit_seconds,
      questionIds: partB.items.map((q) => q.id),
      render: renderPartB,
    },
    {
      key: 'partC',
      label: partC.part_label,
      timeLimitSeconds: partC.time_limit_seconds,
      questionIds: partC.questions.map((q) => q.id),
      render: renderPartC,
    },
  ];
}

function startTimerForCurrentStep() {
  const step = steps[currentStepIndex];
  timeRemaining = Number(step.timeLimitSeconds) > 0 ? Number(step.timeLimitSeconds) : DEFAULT_STEP_TIME_LIMIT_SECONDS;
  if (timerBox) timerBox.classList.remove('warning');
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
  updateTimerLabel();
  timerHandle = setInterval(() => {
    timeRemaining--;
    updateTimerLabel();
    if (timeRemaining <= 60 && timerBox) timerBox.classList.add('warning');
    if (timeRemaining <= 0) {
      clearInterval(timerHandle);
      timerHandle = null;
      handleStepTimeout();
    }
  }, 1000);
}

function updateTimerLabel() {
  if (!timerLabel) return;
  const m = Math.max(0, Math.floor(timeRemaining / 60));
  const s = Math.max(0, timeRemaining % 60);
  timerLabel.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function renderStep() {
  const step = steps[currentStepIndex];
  currentAnswers = { ...(savedAnswersByStep[currentStepIndex] || {}) };
  const total = steps.length;
  progressLabel.textContent = `${step.label} (${currentStepIndex + 1} / ${total})`;
  progressFill.style.width = `${Math.round((currentStepIndex / total) * 100)}%`;

  quizArea.innerHTML = `
    <div class="card question-card" id="stepContainer"></div>
    <p class="note">Once you continue, you cannot go back to change your answers for this part.</p>
    <div class="nav-row">
      <button class="primary" id="nextBtn" type="button">${currentStepIndex === total - 1 ? 'Finish' : 'Save and continue'}</button>
    </div>
    <p class="note" id="readingError" style="color:#c62828; display:none;"></p>
  `;
  step.render(document.getElementById('stepContainer'));

  document.getElementById('nextBtn').addEventListener('click', handleNext);
  startTimerForCurrentStep();
}

function renderPartA(container) {
  const part = readingData.partA;
  const textsHtml = part.texts.map((t) => `
    <div class="passage-box" style="margin-bottom:12px;">
      <div class="passage-title">${escapeHtml(t.label)} — ${escapeHtml(t.title)}</div>
      <div style="white-space:pre-wrap;">${escapeHtml(t.passage_text)}</div>
    </div>
  `).join('');

  const matchingHtml = part.matchingQuestions.map((q, idx) => `
    <div class="question-card" style="margin-top:16px;">
      <div class="q-text"><strong>${idx + 1}.</strong> ${escapeHtml(q.question_text)}</div>
      <div id="options_${q.id}"></div>
    </div>
  `).join('');

  const shortAnswerOffset = part.matchingQuestions.length;
  const shortAnswerHtml = part.shortAnswerQuestions.map((q, idx) => `
    <div class="question-card" style="margin-top:16px;">
      <div class="q-text"><strong>${shortAnswerOffset + idx + 1}.</strong> ${escapeHtml(q.question_text)}</div>
      <input type="text" class="blank-input" id="blank_${q.id}" autocomplete="off" style="margin-top:8px;" />
    </div>
  `).join('');

  container.innerHTML = `
    <p class="note">${escapeHtml(part.instructions)}</p>
    ${textsHtml}
    <h4>Questions 1–5 — which text (A or B)?</h4>
    ${matchingHtml}
    <h4 style="margin-top:20px;">Questions 6–8 — short answer</h4>
    ${shortAnswerHtml}
  `;

  part.matchingQuestions.forEach((q) => {
    const optionsList = document.getElementById(`options_${q.id}`);
    ['Text A', 'Text B'].forEach((opt) => {
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
  part.shortAnswerQuestions.forEach((q) => {
    const input = document.getElementById(`blank_${q.id}`);
    input.value = currentAnswers[q.id] || '';
    input.addEventListener('input', () => {
      currentAnswers[q.id] = input.value;
    });
  });
}

function renderPartB(container) {
  const part = readingData.partB;
  const numberOffset = readingData.partA.matchingQuestions.length + readingData.partA.shortAnswerQuestions.length;
  container.innerHTML = `
    <p class="note">${escapeHtml(part.instructions)}</p>
    ${part.items.map((item, idx) => `
      <div class="passage-box" style="margin-bottom:10px;">
        <div class="passage-title">${escapeHtml(item.passage_title)}</div>
        <div style="white-space:pre-wrap;">${escapeHtml(item.passage_text)}</div>
      </div>
      <div class="question-card" style="margin-bottom:24px;">
        <div class="q-text"><strong>${numberOffset + idx + 1}.</strong> ${escapeHtml(item.question_text)}</div>
        <div id="options_${item.id}"></div>
      </div>
    `).join('')}
  `;
  part.items.forEach((item) => {
    const optionsList = document.getElementById(`options_${item.id}`);
    item.options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'option' + (currentAnswers[item.id] === opt ? ' selected' : '');
      btn.textContent = opt;
      btn.addEventListener('click', () => {
        currentAnswers[item.id] = opt;
        optionsList.querySelectorAll('.option').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
      optionsList.appendChild(btn);
    });
  });
}

function renderPartC(container) {
  const part = readingData.partC;
  const numberOffset = readingData.partA.matchingQuestions.length + readingData.partA.shortAnswerQuestions.length + readingData.partB.items.length;
  container.innerHTML = `
    <p class="note">${escapeHtml(part.instructions)}</p>
    <div class="passage-box">
      <div class="passage-title">${escapeHtml(part.title)}</div>
      <div style="white-space:pre-wrap;">${escapeHtml(part.passage_text)}</div>
    </div>
    ${part.questions.map((q, idx) => `
      <div class="question-card" style="margin-top:16px;">
        <div class="q-text"><strong>${numberOffset + idx + 1}.</strong> ${escapeHtml(q.question_text)}</div>
        <div id="options_${q.id}"></div>
      </div>
    `).join('')}
  `;
  part.questions.forEach((q) => {
    const optionsList = document.getElementById(`options_${q.id}`);
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
}

async function handleNext() {
  if (saving || finished) return;
  const sessionToken = sessionTokenOrRedirect();
  if (!sessionToken) return;
  const step = steps[currentStepIndex];
  const nextBtn = document.getElementById('nextBtn');
  const errorEl = document.getElementById('readingError');
  saving = true;
  nextBtn.disabled = true;
  nextBtn.textContent = 'Saving...';
  try {
    for (const qid of step.questionIds) {
      const selected = currentAnswers[qid];
      const result = await saveAnswer(sessionToken, qid, selected);
      if (result === 'unauthorized') return;
      if (result === 'error') {
        errorEl.textContent = 'We could not save your answer. Please try again.';
        errorEl.style.display = 'block';
        return;
      }
    }
    savedAnswersByStep[currentStepIndex] = { ...currentAnswers };
    if (currentStepIndex < steps.length - 1) {
      currentStepIndex++;
      renderStep();
    } else {
      finishReading(false);
    }
  } finally {
    saving = false;
    const btn = document.getElementById('nextBtn');
    if (btn) {
      btn.disabled = false;
      btn.textContent = currentStepIndex === steps.length - 1 ? 'Finish' : 'Save and continue';
    }
  }
}

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

// Se llama cuando el timer de LA PARTE ACTUAL llega a cero (no el módulo entero).
// Guarda lo que haya quedado pendiente de esta parte y pasa a la siguiente con un
// timer nuevo -- solo termina el módulo si la parte que se quedó sin tiempo era la
// última (Part C).
async function handleStepTimeout() {
  if (finished) return;
  const sessionToken = sessionStorage.getItem('cp360_session_token');
  const step = steps[currentStepIndex];
  if (sessionToken) {
    for (const qid of step.questionIds) {
      const selected = currentAnswers[qid];
      const result = await saveAnswer(sessionToken, qid, selected);
      if (result === 'unauthorized') return;
    }
  }
  savedAnswersByStep[currentStepIndex] = { ...currentAnswers };
  if (currentStepIndex < steps.length - 1) {
    currentStepIndex++;
    renderStep();
  } else {
    finishReading(true);
  }
}

function finishReading(timedOut) {
  if (finished) return;
  finished = true;
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
  renderDone(timedOut);
}

function renderDone(timedOut) {
  quizArea.style.display = 'none';
  resultArea.style.display = 'block';
  progressFill.style.width = '100%';
  progressLabel.textContent = 'OET Reading completed';
  resultArea.innerHTML = `
    <div class="card">
      <h3>${timedOut ? 'Time is up — we saved what you answered' : 'OET Reading completed'}</h3>
      <p>All of your answers were saved. This part is not scored pass/fail — our team reviews the results.</p>
      <p>Next: <strong>OET Writing</strong>. You can continue now.</p>
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

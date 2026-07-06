import { computeGrammarCefr, decideUnlocks, CEFR_ORDER } from './scoring.js';

const TIME_LIMIT_SECONDS = 20 * 60; // "This test will take you approximately 20 minutes" (guion original)
const IDK_LABEL = "I don't know the answer.";

const quizArea = document.getElementById('quizArea');
const resultArea = document.getElementById('resultArea');
const timerLabel = document.getElementById('timerLabel');
const timerBox = document.getElementById('timerBox');
const progressLabel = document.getElementById('progressLabel');
const progressFill = document.getElementById('progressFill');

let grammarData = null;
let questions = [];
let currentIndex = 0;
const answers = new Map(); // questionId -> selected option string
let timeRemaining = TIME_LIMIT_SECONDS;
let timerHandle = null;
let finished = false;

async function init() {
  const studentName = sessionStorage.getItem('cp360_student_name');
  if (!studentName) {
    window.location.href = 'index.html';
    return;
  }

  const res = await fetch('data/nivel1-grammar.json');
  grammarData = await res.json();
  questions = grammarData.questions;

  startTimer();
  renderQuestion();
}

function startTimer() {
  updateTimerLabel();
  timerHandle = setInterval(() => {
    timeRemaining--;
    updateTimerLabel();
    if (timeRemaining <= 60) timerBox.classList.add('warning');
    if (timeRemaining <= 0) {
      clearInterval(timerHandle);
      finishQuiz(true);
    }
  }, 1000);
}

function updateTimerLabel() {
  const m = Math.max(0, Math.floor(timeRemaining / 60));
  const s = Math.max(0, timeRemaining % 60);
  timerLabel.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function renderQuestion() {
  const q = questions[currentIndex];
  progressLabel.textContent = `Pregunta ${currentIndex + 1} / ${questions.length}`;
  progressFill.style.width = `${Math.round(((currentIndex) / questions.length) * 100)}%`;

  const selected = answers.get(q.id);
  const allOptions = [...q.options, IDK_LABEL];

  quizArea.innerHTML = `
    <div class="card question-card">
      <div class="q-index">CEFR objetivo: ${q.cefrLevel || bandForId(q.id)}</div>
      <div class="q-text">${escapeHtml(q.text)}</div>
      <div id="optionsList"></div>
      <div class="nav-row">
        <button class="secondary" id="prevBtn" ${currentIndex === 0 ? 'disabled' : ''}>Anterior</button>
        <button class="primary" id="nextBtn" ${selected ? '' : 'disabled'}>
          ${currentIndex === questions.length - 1 ? 'Finalizar' : 'Siguiente'}
        </button>
      </div>
    </div>
  `;

  const optionsList = document.getElementById('optionsList');
  allOptions.forEach((opt) => {
    const btn = document.createElement('button');
    btn.className = 'option' + (opt === IDK_LABEL ? ' idk' : '') + (selected === opt ? ' selected' : '');
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
  document.getElementById('nextBtn').addEventListener('click', () => {
    if (currentIndex < questions.length - 1) {
      currentIndex++;
      renderQuestion();
    } else {
      finishQuiz(false);
    }
  });
}

function bandForId(id) {
  const band = grammarData.cefrRanges.find((b) => id >= b.range[0] && id <= b.range[1]);
  return band ? band.level : '?';
}

function finishQuiz(timedOut) {
  if (finished) return;
  finished = true;
  clearInterval(timerHandle);

  const responses = new Map();
  for (const q of questions) {
    const selected = answers.get(q.id);
    responses.set(q.id, selected !== undefined && selected !== IDK_LABEL && selected === q.correct);
  }

  const result = computeGrammarCefr(questions, responses, grammarData.cefrRanges);

  // Mock de sub-scores: listening y writing todavía no están construidos en la app,
  // así que el gate de OET queda marcado explícitamente como "pendiente" en vez de
  // simular un resultado que no existe.
  const unlockPreview = decideUnlocks({
    grammar: { ceilingLevel: result.ceilingLevel },
    listening: null,
    writing: null,
  });

  renderResults(result, unlockPreview, timedOut);
}

function renderResults(result, unlockPreview, timedOut) {
  quizArea.style.display = 'none';
  resultArea.style.display = 'block';

  const bandsHtml = CEFR_ORDER.map((level) => {
    const b = result.perBand[level];
    if (!b || b.total === 0) return '';
    return `
      <div class="result-band">
        <span>${level} (${b.correct}/${b.total})</span>
        <span class="badge ${b.passed ? 'pass' : 'fail'}">${b.percent}% ${b.passed ? 'OK' : 'insuficiente'}</span>
      </div>`;
  }).join('');

  resultArea.innerHTML = `
    <div class="card">
      <h3>${timedOut ? '⏱ Se acabó el tiempo — resultados con lo respondido' : 'Nivel 1 completado'}</h3>
      <p>Nivel CEFR alcanzado (grammar): <strong>${result.ceilingLevel || 'por debajo de A1'}</strong>
         &nbsp;·&nbsp; Acierto general: <strong>${result.overallPercent}%</strong></p>
      ${bandsHtml}
    </div>

    <div class="card">
      <h3>Próximos módulos</h3>
      <div class="module-row">
        <span class="module-name">STEPS 2 (lectura y diagnóstico médico)</span>
        <span class="module-status unlocked">Desbloqueado — obligatorio para todos</span>
      </div>
      <div class="module-row">
        <span class="module-name">OET Skills</span>
        <span class="module-status pending">Pendiente — falta rendir Listening y Writing del Nivel 1</span>
      </div>
      <div class="module-row">
        <span class="module-name">Roleplay oral (en vivo)</span>
        <span class="module-status locked">Bloqueado — depende del desbloqueo de OET</span>
      </div>
      <p class="note">
        NOTA DE DESARROLLO (para Diana): el gate real de OET necesita los sub-scores de
        listening y writing, que todavía no están construidos en esta versión. Por eso
        arriba figura "Pendiente" en vez de un desbloqueo simulado — no queríamos mostrar
        un resultado que la app todavía no puede calcular de verdad.
      </p>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

init();

// Nivel 1 — Grammar.
//
// Cada respuesta se guarda vía submit-response, que corrige server-side contra
// question_bank.correct_answer -- el navegador nunca lo ve (data/nivel1-grammar.json
// solo trae el id real de question_bank, el texto y las opciones, nunca la respuesta
// correcta). A pedido explícito de Diana, esta pantalla NO muestra ningún acierto ni
// puntaje en vivo, ni nivel CEFR alcanzado -- solo confirma que se guardó cada
// respuesta y, al final, que el módulo quedó completo. El cálculo real del ceiling
// CEFR y el desbloqueo de OET/STEPS2 los hace submit-response server-side (mismo
// patrón que Listening).
//
// Cronómetro: el estudiante tiene 20 minutos en total para las 44 preguntas. Si se
// acaba el tiempo, igual guardamos todo lo que quede pendiente (la pregunta actual, si
// tenía una respuesta elegida sin confirmar, y las que nunca llegó a ver, como "sin
// respuesta") para que las 44 preguntas queden registradas en Supabase -- si faltan
// filas en student_responses, el Edge Function nunca considera terminado el módulo y
// el desbloqueo de OET queda trabado para siempre (este era justamente el bug
// original: el frontend nunca llamaba a submit-response).

const SUPABASE_FUNCTIONS_BASE = 'https://qqdxmmvhthwcqhgmvyic.supabase.co/functions/v1';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFxZHhtbXZodGh3Y3FoZ212eWljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MzY3NDQsImV4cCI6MjA5OTAxMjc0NH0.iP5BTeUjw8FnElgQzp9r1-iSR-B9USVMcKGRs-Yh8GA';

const TIME_LIMIT_SECONDS = 20 * 60; // 20 minutos, número redondo (ajustado por Diana)
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
const answers = new Map(); // questionId (uuid) -> opción elegida, todavía no confirmada guardada
const savedAnswers = new Map(); // questionId (uuid) -> última respuesta ya guardada en el server
let timeRemaining = TIME_LIMIT_SECONDS;
let timerHandle = null;
let finished = false;
let saving = false;

async function init() {
  const sessionToken = sessionTokenOrRedirect();
  if (!sessionToken) return;

  const res = await fetch('data/nivel1-grammar.json');
  grammarData = await res.json();
  questions = grammarData.questions;

  startTimer();
  renderQuestion();
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
      <div class="q-index">CEFR objetivo: ${q.cefr_level}</div>
      <div class="q-text">${escapeHtml(q.question_text)}</div>
      <div id="optionsList"></div>
      <p class="note" id="saveError" style="color:#c62828; display:none;"></p>
      <div class="nav-row">
        <button class="secondary" id="prevBtn" type="button" ${currentIndex === 0 ? 'disabled' : ''}>Anterior</button>
        <button class="primary" id="nextBtn" type="button" ${selected ? '' : 'disabled'}>
          ${currentIndex === questions.length - 1 ? 'Finalizar' : 'Siguiente'}
        </button>
      </div>
    </div>
  `;

  const optionsList = document.getElementById('optionsList');
  allOptions.forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
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
  nextBtn.textContent = 'Guardando...';
  errorEl.style.display = 'none';

  try {
    const result = await saveAnswer(sessionToken, q, selected);
    if (result === 'unauthorized') return; // ya redirigido a index.html
    if (result === 'error') {
      errorEl.textContent = 'No pudimos guardar tu respuesta. Intenta de nuevo.';
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
      btn.textContent = currentIndex === questions.length - 1 ? 'Finalizar' : 'Siguiente';
    }
  }
}

// Devuelve 'ok', 'error' (fallo de red o del server) o 'unauthorized' (sesión vencida,
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
        selected_answer: typeof selected === 'string' && selected !== IDK_LABEL ? selected : null,
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

async function finishQuiz(timedOut) {
  if (finished) return;
  finished = true;
  clearInterval(timerHandle);

  if (timedOut) {
    const sessionToken = sessionStorage.getItem('cp360_session_token');
    if (sessionToken) {
      // Guardamos todo lo que haya quedado pendiente: la pregunta donde estaba parado
      // el estudiante (si había elegido algo sin confirmar) y todas las que nunca
      // llegó a ver (sin respuesta = se cuenta como incorrecta, igual que en un examen
      // real que corta al llegar el tiempo). Necesario para que las 44 preguntas
      // queden guardadas y el módulo se marque completo server-side.
      for (let i = currentIndex; i < questions.length; i++) {
        const q = questions[i];
        if (savedAnswers.has(q.id)) continue;
        const selected = answers.get(q.id);
        const result = await saveAnswer(sessionToken, q, selected);
        if (result === 'unauthorized') return; // ya redirigido a index.html
        savedAnswers.set(q.id, selected);
      }
    }
  }

  renderDone(timedOut);
}

function renderDone(timedOut) {
  quizArea.style.display = 'none';
  resultArea.style.display = 'block';
  progressFill.style.width = '100%';
  progressLabel.textContent = `Pregunta ${questions.length} / ${questions.length}`;

  resultArea.innerHTML = `
    <div class="card">
      <h3>${timedOut ? 'Se acabó el tiempo — guardamos lo que respondiste' : 'Nivel 1 — Grammar completado'}</h3>
      <p>Guardamos todas tus respuestas. Como en el resto de Nivel 1, no te mostramos aciertos ni puntaje en vivo -- Diana revisa los resultados completos más adelante.</p>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

init();

// OET Listening — 3 audios (Part A note completion, Part B y C multiple choice),
// 22 preguntas en total. Adaptación directa de app-nivel1-listening.js (misma
// arquitectura: primero se muestran las preguntas, después se reproduce el audio como
// máximo max_plays veces, controlado server-side por get-audio-url).
//
// Corrección (06/08/2026, pedido de Diana): el audio en sí ya incluye el tiempo de
// lectura antes de que arranque la grabación (formato real de OET) -- el estudiante
// debe apretar "Play audio" enseguida, no esperar a terminar de leer. Se sacó el
// texto que decía "Read the questions before playing it" para no confundir.
//
// A diferencia de Nivel 1 Listening, este módulo SÍ tiene límite de tiempo (decisión de
// Diana, 06/08/2026). Actualización 06/08/2026: el límite ahora es POR PARTE (A/B/C),
// no un total de 30 min para todo el módulo -- cada parte tiene su propio presupuesto,
// calculado a partir de la duración real del track de audio subido más un margen para
// terminar de responder (ver time_limit_seconds en cada audio de
// data/oet-listening.json). Si se acaba el tiempo de una parte, se guarda lo que haya
// quedado pendiente de ESA parte (igual que STEP CK2 / Nivel 1 Reading) y pasa
// automáticamente a la parte siguiente con un timer nuevo, en vez de cerrar todo el
// módulo -- solo cierra el módulo si la parte que se queda sin tiempo es la última (C).
//
// Puntaje: informativo únicamente (raw_score/max_score, sin banda CEFR ni
// aprobar/reprobar) -- estos estudiantes ya calificaron para OET en Nivel 1. Ver rama
// nueva en submit-response para module 'oet_listening'.
//
// Sin botón "Previous" (decisión de Diana, 06/08/2026): a diferencia de Nivel 1
// Listening, en OET nunca se puede volver atrás a cambiar una respuesta después de
// pasar de audio -- una vez que el estudiante confirma "Save and continue" en un
// audio, esas respuestas quedan cerradas y no se vuelven a mostrar.
const SUPABASE_FUNCTIONS_BASE = 'https://qqdxmmvhthwcqhgmvyic.supabase.co/functions/v1';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFxZHhtbXZodGh3Y3FoZ212eWljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MzY3NDQsImV4cCI6MjA5OTAxMjc0NH0.iP5BTeUjw8FnElgQzp9r1-iSR-B9USVMcKGRs-Yh8GA';

// Después de OET Listening vuelve al router (siguiente.html / get-unlock-state), que
// manda a oet-reading.html.
const NEXT_MODULE_URL = 'siguiente.html';
const NEXT_MODULE_LABEL = 'Continue';
const DEFAULT_PART_TIME_LIMIT_SECONDS = 8 * 60; // fallback si a una parte le falta time_limit_seconds en el JSON

const quizArea = document.getElementById('quizArea');
const resultArea = document.getElementById('resultArea');
const timerLabel = document.getElementById('timerLabel');
const timerBox = document.getElementById('timerBox');
const progressLabel = document.getElementById('progressLabel');
const progressFill = document.getElementById('progressFill');

let listeningData = null;
let currentAudioIndex = 0;
let currentAnswers = {}; // questionId -> string (respuestas del audio actual, todavía no confirman guardado)
const savedAnswersByGroup = {}; // audioIndex -> { questionId: string } (última respuesta ya guardada en el server)
const playsUsed = {}; // audio_asset_id -> número de reproducciones ya usadas, según el server
let saving = false;
let finished = false;
let timerHandle = null;
let timeRemaining = DEFAULT_PART_TIME_LIMIT_SECONDS;

async function init() {
  const sessionToken = sessionTokenOrRedirect();
  if (!sessionToken) return;
  const res = await fetch('data/oet-listening.json');
  listeningData = await res.json();
  renderAudioGroup();
}

function sessionTokenOrRedirect() {
  const token = sessionStorage.getItem('cp360_session_token');
  if (!token) {
    window.location.href = 'index.html';
    return null;
  }
  return token;
}

function startTimerForCurrentGroup() {
  const group = listeningData.audios[currentAudioIndex];
  timeRemaining = Number(group.time_limit_seconds) > 0 ? Number(group.time_limit_seconds) : DEFAULT_PART_TIME_LIMIT_SECONDS;
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
      handlePartTimeout();
    }
  }, 1000);
}

function updateTimerLabel() {
  if (!timerLabel) return;
  const m = Math.max(0, Math.floor(timeRemaining / 60));
  const s = Math.max(0, timeRemaining % 60);
  timerLabel.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function renderAudioGroup() {
  const group = listeningData.audios[currentAudioIndex];
  currentAnswers = { ...(savedAnswersByGroup[currentAudioIndex] || {}) };
  const totalAudios = listeningData.audios.length;
  progressLabel.textContent = `${group.part_label} (Audio ${currentAudioIndex + 1} / ${totalAudios})`;
  progressFill.style.width = `${Math.round((currentAudioIndex / totalAudios) * 100)}%`;
  const used = playsUsed[group.audio_asset_id] || 0;
  const remaining = group.max_plays - used;
  const isCaseNotes = group.questions[0] && group.questions[0].answer_format === 'note_completion';
  let numberOffset = 0;
  for (let i = 0; i < currentAudioIndex; i++) numberOffset += listeningData.audios[i].questions.length;
  quizArea.innerHTML = `
    <div class="card question-card">
      <div class="q-text">${escapeHtml(group.title)}</div>
      <p class="note">Click "Play audio" now — the recording itself gives you time to read the questions before it starts. You will hear it a maximum of ${group.max_plays} time(s) in total.</p>
      <audio class="player" id="audioPlayer"></audio>
      <div class="audio-controls">
        <button class="audio-play" id="playBtn" type="button" ${remaining <= 0 ? 'disabled' : ''}>${remaining <= 0 ? 'No plays remaining' : 'Play audio'}</button>
        <span class="plays-remaining" id="playsRemaining">Plays used: ${used} / ${group.max_plays}</span>
      </div>
      <p class="note" id="audioError" style="color:#c62828; display:none;"></p>
      ${isCaseNotes ? renderCaseNotes(group, numberOffset) : renderMultipleChoice(group, numberOffset)}
      <p class="note">Once you continue, you cannot go back to change your answers for this part.</p>
      <div class="nav-row">
        <button class="primary" id="nextBtn" type="button">${currentAudioIndex === totalAudios - 1 ? 'Finish' : 'Save and continue'}</button>
      </div>
    </div>
  `;
  startTimerForCurrentGroup();
  document.getElementById('playBtn').addEventListener('click', () => playAudio(group));
  if (isCaseNotes) {
    group.questions.forEach((q) => {
      const input = document.getElementById(`blank_${q.id}`);
      if (!input) return;
      input.value = currentAnswers[q.id] || '';
      input.addEventListener('input', () => {
        currentAnswers[q.id] = input.value;
      });
    });
  } else {
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
  }
  document.getElementById('nextBtn').addEventListener('click', handleNext);
}

function renderMultipleChoice(group, numberOffset) {
  return group.questions.map((q, idx) => `
    <div class="question-card" style="margin-top:20px;">
      <div class="q-text"><strong>${numberOffset + idx + 1}.</strong> ${escapeHtml(q.question_text)}</div>
      <div id="options_${q.id}"></div>
    </div>
  `).join('');
}

// Cada question_text de note_completion puede traer un subtítulo de sección como
// primera línea (ej. "Medical history\nhas occasional ___") -- eso separa las notas
// en bloques (Medical history / Baby's father / Points raised), igual que el examen
// real. Pedido de Diana (06/08/2026): esos subtítulos deben verse en negrita para
// distinguirse claramente del texto de la pregunta, y TODAS las preguntas (incluidas
// las de esta parte) deben mostrar su número.
function renderCaseNotes(group, numberOffset) {
  const rows = group.questions.map((q, idx) => {
    const num = numberOffset + idx + 1;
    const parts = q.question_text.split('___');
    const rawBefore = parts[0] || '';
    const after = escapeHtml(parts[1] || '').replace(/\n/g, '<br>');
    const lines = rawBefore.split('\n');
    let subtitleHtml = '';
    let beforeText = rawBefore;
    if (lines.length > 1) {
      subtitleHtml = `<div class="note-subtitle">${escapeHtml(lines[0])}</div>`;
      beforeText = lines.slice(1).join('\n');
    }
    const before = escapeHtml(beforeText).replace(/\n/g, '<br>');
    return `${subtitleHtml}<div class="note-row"><strong>${num}.</strong> ${before}<input type="text" class="blank-input" id="blank_${q.id}" autocomplete="off" />${after}</div>`;
  }).join('');
  return `
    <div class="case-notes-heading">${escapeHtml(group.case_notes_heading || 'PATIENT NOTES')}</div>
    ${rows}
  `;
}

async function playAudio(group) {
  const sessionToken = sessionTokenOrRedirect();
  if (!sessionToken) return;
  const errorEl = document.getElementById('audioError');
  errorEl.style.display = 'none';
  const playBtn = document.getElementById('playBtn');
  playBtn.disabled = true;
  playBtn.textContent = 'Loading...';
  try {
    const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/get-audio-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ session_token: sessionToken, audio_asset_id: group.audio_asset_id }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 401) {
        window.location.href = 'index.html';
        return;
      }
      errorEl.textContent = data.error || 'We could not load the audio. Please try again.';
      errorEl.style.display = 'block';
      if (typeof data.plays_used === 'number') {
        playsUsed[group.audio_asset_id] = data.plays_used;
      }
      return;
    }
    playsUsed[group.audio_asset_id] = data.plays_used;
    const player = document.getElementById('audioPlayer');
    player.src = data.url;
    player.play().catch(() => {
      // Reproducción automática bloqueada por el navegador: no es un error real.
    });
  } catch (err) {
    errorEl.textContent = 'We could not connect to the server. Check your connection and try again.';
    errorEl.style.display = 'block';
  } finally {
    updatePlaysUi(group);
  }
}

function updatePlaysUi(group) {
  const used = playsUsed[group.audio_asset_id] || 0;
  const remaining = group.max_plays - used;
  const playBtn = document.getElementById('playBtn');
  const remainingLabel = document.getElementById('playsRemaining');
  if (!playBtn || !remainingLabel) return;
  remainingLabel.textContent = `Plays used: ${used} / ${group.max_plays}`;
  playBtn.disabled = remaining <= 0;
  playBtn.textContent = remaining <= 0 ? 'No plays remaining' : 'Play audio';
}

async function handleNext() {
  if (saving || finished) return;
  const sessionToken = sessionTokenOrRedirect();
  if (!sessionToken) return;
  const group = listeningData.audios[currentAudioIndex];
  const totalAudios = listeningData.audios.length;
  const nextBtn = document.getElementById('nextBtn');
  const errorEl = document.getElementById('audioError');
  saving = true;
  nextBtn.disabled = true;
  nextBtn.textContent = 'Saving...';
  try {
    for (const q of group.questions) {
      const selected = currentAnswers[q.id];
      const result = await saveAnswer(sessionToken, q.id, selected);
      if (result === 'unauthorized') return;
      if (result === 'error') {
        errorEl.textContent = 'We could not save your answer. Please try again.';
        errorEl.style.display = 'block';
        return;
      }
    }
    savedAnswersByGroup[currentAudioIndex] = { ...currentAnswers };
    if (currentAudioIndex < totalAudios - 1) {
      currentAudioIndex++;
      renderAudioGroup();
    } else {
      finishListening(false);
    }
  } finally {
    saving = false;
    const btn = document.getElementById('nextBtn');
    if (btn) {
      btn.disabled = false;
      btn.textContent = currentAudioIndex === totalAudios - 1 ? 'Finish' : 'Save and continue';
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
async function handlePartTimeout() {
  if (finished) return;
  const sessionToken = sessionStorage.getItem('cp360_session_token');
  const group = listeningData.audios[currentAudioIndex];
  const totalAudios = listeningData.audios.length;
  if (sessionToken) {
    for (const q of group.questions) {
      const selected = currentAnswers[q.id];
      const result = await saveAnswer(sessionToken, q.id, selected);
      if (result === 'unauthorized') return;
    }
  }
  savedAnswersByGroup[currentAudioIndex] = { ...currentAnswers };
  if (currentAudioIndex < totalAudios - 1) {
    currentAudioIndex++;
    renderAudioGroup();
  } else {
    finishListening(true);
  }
}

function finishListening(timedOut) {
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
  progressLabel.textContent = 'OET Listening completed';
  resultArea.innerHTML = `
    <div class="card">
      <h3>${timedOut ? 'Time is up — we saved what you answered' : 'OET Listening completed'}</h3>
      <p>All of your answers were saved. This part is not scored pass/fail — our team reviews the results.</p>
      <p>Next: <strong>OET Reading</strong>. You can continue now.</p>
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

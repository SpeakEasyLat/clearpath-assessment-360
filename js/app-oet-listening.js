// OET Listening — 3 audios (Part A note completion, Part B y C multiple choice),
// 22 preguntas en total. Adaptación directa de app-nivel1-listening.js (misma
// arquitectura: primero se muestran las preguntas, después se reproduce el audio como
// máximo max_plays veces, controlado server-side por get-audio-url).
//
// A diferencia de Nivel 1 Listening, este módulo SÍ tiene límite de tiempo (decisión de
// Diana, 06/08/2026): un timer visible que, al llegar a cero, guarda lo que haya
// quedado pendiente (igual que STEP CK2 / Nivel 1 Reading) y cierra la pantalla,
// pasando al siguiente paso (OET Reading).
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
const DEFAULT_TIME_LIMIT_SECONDS = 30 * 60;

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
let timeRemaining = DEFAULT_TIME_LIMIT_SECONDS;

async function init() {
  const sessionToken = sessionTokenOrRedirect();
  if (!sessionToken) return;
  const res = await fetch('data/oet-listening.json');
  listeningData = await res.json();
  timeRemaining = Number(listeningData.time_limit_seconds) > 0 ? Number(listeningData.time_limit_seconds) : DEFAULT_TIME_LIMIT_SECONDS;
  startTimer();
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

function startTimer() {
  updateTimerLabel();
  timerHandle = setInterval(() => {
    timeRemaining--;
    updateTimerLabel();
    if (timeRemaining <= 60 && timerBox) timerBox.classList.add('warning');
    if (timeRemaining <= 0) {
      clearInterval(timerHandle);
      timerHandle = null;
      finishListening(true);
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
  quizArea.innerHTML = `
    <div class="card question-card">
      <div class="q-text">${escapeHtml(group.title)}</div>
      <p class="note">You will hear this audio a maximum of ${group.max_plays} time(s) in total. Read the questions before playing it.</p>
      <audio class="player" id="audioPlayer"></audio>
      <div class="audio-controls">
        <button class="audio-play" id="playBtn" type="button" ${remaining <= 0 ? 'disabled' : ''}>${remaining <= 0 ? 'No plays remaining' : 'Play audio'}</button>
        <span class="plays-remaining" id="playsRemaining">Plays used: ${used} / ${group.max_plays}</span>
      </div>
      <p class="note" id="audioError" style="color:#c62828; display:none;"></p>
      ${isCaseNotes ? renderCaseNotes(group) : renderMultipleChoice(group)}
      <p class="note">Once you continue, you cannot go back to change your answers for this part.</p>
      <div class="nav-row">
        <button class="primary" id="nextBtn" type="button">${currentAudioIndex === totalAudios - 1 ? 'Finish' : 'Save and continue'}</button>
      </div>
    </div>
  `;
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

function renderMultipleChoice(group) {
  return group.questions.map((q) => `
    <div class="question-card" style="margin-top:20px;">
      <div class="q-text">${escapeHtml(q.question_text)}</div>
      <div id="options_${q.id}"></div>
    </div>
  `).join('');
}

function renderCaseNotes(group) {
  const rows = group.questions.map((q) => {
    const parts = q.question_text.split('___');
    const before = escapeHtml(parts[0] || '').replace(/\n/g, '<br>');
    const after = escapeHtml(parts[1] || '').replace(/\n/g, '<br>');
    return `<div class="note-row">${before}<input type="text" class="blank-input" id="blank_${q.id}" autocomplete="off" />${after}</div>`;
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

async function finishListening(timedOut) {
  if (finished) return;
  finished = true;
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
  if (timedOut) {
    const sessionToken = sessionStorage.getItem('cp360_session_token');
    if (sessionToken) {
      // Igual que en Nivel 1 Reading / STEP CK2: si se acaba el tiempo, guardamos lo que
      // haya quedado pendiente desde el audio actual en adelante (lo que el estudiante
      // había elegido sin confirmar, y lo que nunca llegó a ver, como "sin respuesta").
      for (let g = currentAudioIndex; g < listeningData.audios.length; g++) {
        const group = listeningData.audios[g];
        const answersForGroup = g === currentAudioIndex ? currentAnswers : {};
        const alreadySaved = savedAnswersByGroup[g] || {};
        for (const q of group.questions) {
          if (Object.prototype.hasOwnProperty.call(alreadySaved, q.id)) continue;
          const selected = answersForGroup[q.id];
          const result = await saveAnswer(sessionToken, q.id, selected);
          if (result === 'unauthorized') return;
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

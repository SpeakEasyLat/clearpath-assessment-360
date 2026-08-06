// OET Writing — una sola tarea (carta de referencia sobre el caso de Betty Johnson),
// adaptada de app-nivel1-writing.js. A diferencia de Nivel 1 Writing, esta pantalla
// tiene DOS fases con timers propios, replicando el formato real de OET Writing:
//   1) Reading time (2 min): se muestran las notas del caso, todavía no se puede
//      escribir. El estudiante puede pasar antes si ya terminó de leer.
//   2) Writing time (15 min): aparece la consigna + el textarea; las notas del caso
//      quedan SIEMPRE VISIBLES arriba, sin colapsar (decisión de Diana, 06/08/2026:
//      el estudiante debe poder ver el texto de case notes mientras escribe, sin
//      necesidad de hacer click en nada).
// Si se acaba el tiempo de escritura, se guarda lo que haya en el textarea (igual que
// Nivel 1 Writing) y se cierra la pantalla.
//
// Corrección: IA del lado del servidor (mismo pipeline que Nivel 1 Writing, rúbrica de
// placement 0-10 + CEFR), pero el sub_score se guarda con skill 'oet_writing' (no
// 'writing' -- ver fix v15 en submit-writing/index.ts) y NO recalcula la ruta del
// Nivel 1 (ya quedó fija). Es diagnóstico para Diana, no un gate.

const SUPABASE_FUNCTIONS_BASE = 'https://qqdxmmvhthwcqhgmvyic.supabase.co/functions/v1';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFxZHhtbXZodGh3Y3FoZ212eWljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MzY3NDQsImV4cCI6MjA5OTAxMjc0NH0.iP5BTeUjw8FnElgQzp9r1-iSR-B9USVMcKGRs-Yh8GA';

const NEXT_STEP_URL = 'siguiente.html';
const NEXT_STEP_LABEL = 'Continue';

const quizArea = document.getElementById('quizArea');
const resultArea = document.getElementById('resultArea');
const timerLabel = document.getElementById('timerLabel');
const timerBox = document.getElementById('timerBox');
const progressLabel = document.getElementById('progressLabel');
const progressFill = document.getElementById('progressFill');

let writingData = null;
let prompt = null;
let phase = 'reading'; // 'reading' | 'writing'
let readingRemaining = 120;
let writingRemaining = 900;
let savedText = '';
let finished = false;
let timerHandle = null;

function sessionTokenOrRedirect() {
  const token = sessionStorage.getItem('cp360_session_token');
  if (!token) {
    window.location.href = 'index.html';
    return null;
  }
  return token;
}

async function init() {
  const sessionToken = sessionTokenOrRedirect();
  if (!sessionToken) return;
  try {
    const res = await fetch('data/oet-writing.json');
    writingData = await res.json();
  } catch (err) {
    quizArea.innerHTML = '<p class="note">We could not load the task. Please reload the page and try again.</p>';
    return;
  }
  prompt = (writingData.prompts || [])[0];
  if (!prompt) {
    quizArea.innerHTML = '<p class="note">No task is configured for this module.</p>';
    return;
  }
  readingRemaining = Number(writingData.readingTimeSeconds) > 0 ? Number(writingData.readingTimeSeconds) : 120;
  const total = Number(writingData.timeLimitSeconds) > 0 ? Number(writingData.timeLimitSeconds) : 1020;
  writingRemaining = Math.max(60, total - readingRemaining);

  startTimer();
  renderReadingPhase();
}

function startTimer() {
  updateTimerLabel();
  timerHandle = setInterval(() => {
    if (phase === 'reading') {
      readingRemaining--;
      updateTimerLabel();
      if (readingRemaining <= 0) {
        startWritingPhase();
      }
    } else {
      writingRemaining--;
      updateTimerLabel();
      if (writingRemaining <= 60 && timerBox) timerBox.classList.add('timer-low');
      if (writingRemaining <= 0) {
        clearInterval(timerHandle);
        timerHandle = null;
        handleTimeout();
      }
    }
  }, 1000);
}

function updateTimerLabel() {
  if (!timerLabel) return;
  const secs = phase === 'reading' ? readingRemaining : writingRemaining;
  const m = Math.max(0, Math.floor(secs / 60));
  const s = Math.max(0, secs % 60);
  timerLabel.textContent = `${m}:${String(s).padStart(2, '0')}`;
}

function renderReadingPhase() {
  if (progressLabel) progressLabel.textContent = 'Reading time — case notes';
  if (progressFill) progressFill.style.width = '10%';
  quizArea.innerHTML = `
    <h2 class="writing-title">${escapeHtml(prompt.title)}</h2>
    <p class="note">Read the case notes below. You cannot write yet — writing time starts automatically when reading time ends, or you can continue early.</p>
    <div class="case-notes-box">${escapeHtml(prompt.case_notes || '')}</div>
    <button class="primary" id="startWritingBtn" type="button">Continue to writing now</button>
  `;
  const btn = document.getElementById('startWritingBtn');
  if (btn) btn.addEventListener('click', () => startWritingPhase());
}

function startWritingPhase() {
  if (phase === 'writing') return;
  phase = 'writing';
  readingRemaining = 0;
  updateTimerLabel();
  if (timerBox) timerBox.classList.remove('warning');
  renderWritingPhase();
}

function wordCount(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function renderWritingPhase() {
  if (progressLabel) progressLabel.textContent = 'Writing time';
  if (progressFill) progressFill.style.width = '50%';
  const promptHtml = escapeHtml(prompt.prompt_text).replace(/\n/g, '<br>');
  const guidanceHtml = prompt.guidance ? `<p class="writing-guidance">${escapeHtml(prompt.guidance)}</p>` : '';

  quizArea.innerHTML = `
    <h2 class="writing-title">${escapeHtml(prompt.title)}</h2>
    <h3 class="case-notes-heading" style="margin:0 0 0.4rem; font-size:0.95rem;">Case notes (reference)</h3>
    <div class="case-notes-box">${escapeHtml(prompt.case_notes || '')}</div>
    <p class="writing-prompt">${promptHtml}</p>
    ${guidanceHtml}
    <label for="writingText" class="writing-label">Your letter (in English):</label>
    <textarea id="writingText" class="writing-textarea" rows="14" placeholder="Write your response here...">${escapeHtml(savedText)}</textarea>
    <div class="writing-meta">
      <span id="wordCount" class="writing-wordcount"></span>
      <span class="writing-range">Target: ${prompt.min_words}–${prompt.max_words} words (body of the letter)</span>
    </div>
    <p class="note" id="writingError" style="color:#c62828; display:none;"></p>
    <button class="primary" id="saveBtn">Finish</button>
  `;

  const textarea = document.getElementById('writingText');
  const wordCountEl = document.getElementById('wordCount');
  const saveBtn = document.getElementById('saveBtn');

  function refreshCount() {
    const n = wordCount(textarea.value);
    wordCountEl.textContent = `${n} ${n === 1 ? 'word' : 'words'}`;
  }
  refreshCount();
  textarea.addEventListener('input', () => {
    savedText = textarea.value;
    refreshCount();
  });
  saveBtn.addEventListener('click', () => handleSave());
}

function showError(msg) {
  const el = document.getElementById('writingError');
  if (el) {
    el.textContent = msg;
    el.style.display = 'block';
  }
}

async function handleSave() {
  if (finished) return;
  const sessionToken = sessionStorage.getItem('cp360_session_token');
  if (!sessionToken) {
    window.location.href = 'index.html';
    return;
  }
  const textarea = document.getElementById('writingText');
  const saveBtn = document.getElementById('saveBtn');
  const text = (textarea.value || '').trim();

  if (!text) {
    showError('Write your response before continuing.');
    return;
  }
  savedText = textarea.value;

  saveBtn.disabled = true;
  const originalLabel = saveBtn.textContent;
  saveBtn.textContent = 'Saving...';

  const result = await saveResponse(sessionToken, text);
  if (result === 'unauthorized') return;
  if (result === 'error') {
    showError('We could not save your response. Check your connection and try again.');
    saveBtn.disabled = false;
    saveBtn.textContent = originalLabel;
    return;
  }
  finishModule(false);
}

async function saveResponse(sessionToken, text) {
  try {
    const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/submit-writing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        session_token: sessionToken,
        prompt_id: prompt.id,
        response_text: text,
      }),
    });
    if (res.status === 401) {
      sessionStorage.removeItem('cp360_session_token');
      window.location.href = 'index.html';
      return 'unauthorized';
    }
    if (!res.ok) return 'error';
    return 'ok';
  } catch (err) {
    return 'error';
  }
}

async function handleTimeout() {
  if (finished) return;
  const sessionToken = sessionStorage.getItem('cp360_session_token');
  const textarea = document.getElementById('writingText');
  const text = textarea ? (textarea.value || '').trim() : '';
  if (sessionToken && text) {
    await saveResponse(sessionToken, text);
  }
  finishModule(true);
}

function finishModule(timedOut = false) {
  if (finished) return;
  finished = true;
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
  if (progressFill) progressFill.style.width = '100%';
  if (progressLabel) progressLabel.textContent = 'OET Writing completed';
  renderDone(timedOut);
}

function renderDone(timedOut) {
  if (timerBox) timerBox.style.display = 'none';
  quizArea.style.display = 'none';
  if (resultArea) {
    resultArea.style.display = 'block';
    resultArea.innerHTML = `
      <h2>OET Writing completed</h2>
      <p>${timedOut ? 'Time is up. ' : ''}Your response was saved.</p>
      <p class="note">Your writing is reviewed afterwards; no results are shown on this screen.</p>
    `;
    const spk = document.createElement('a');
    spk.href = NEXT_STEP_URL;
    spk.textContent = NEXT_STEP_LABEL;
    spk.style.cssText = 'display:block;width:100%;box-sizing:border-box;text-align:center;text-decoration:none;font-weight:600;padding:0.9rem 1rem;border-radius:8px;margin:1.2rem 0 0;background:#2a6f97;color:#fff;';
    resultArea.appendChild(spk);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

init();

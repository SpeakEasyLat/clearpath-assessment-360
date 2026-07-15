// Nivel 1 - Writing (cliente)
//
// Presenta las 2 tareas de writing (una general más fácil, una médica tipo OET más
// difícil), guarda cada texto vía la Edge Function submit-writing, y -- igual que
// Grammar y Listening -- NUNCA muestra puntaje ni nivel en vivo. La corrección la hace
// la IA del lado del servidor (rúbrica de placement 0-10 + CEFR); el navegador solo
// sabe "guardado / módulo completo".

const SUPABASE_FUNCTIONS_BASE = 'https://qqdxmmvhthwcqhgmvyic.supabase.co/functions/v1';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFxZHhtbXZodGh3Y3FoZ212eWljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MzY3NDQsImV4cCI6MjA5OTAxMjc0NH0.iP5BTeUjw8FnElgQzp9r1-iSR-B9USVMcKGRs-Yh8GA';

const quizArea = document.getElementById('quizArea');
const resultArea = document.getElementById('resultArea');
const timerLabel = document.getElementById('timerLabel');
const timerBox = document.getElementById('timerBox');
const progressLabel = document.getElementById('progressLabel');
const progressFill = document.getElementById('progressFill');

let writingData = null;
let prompts = [];
let currentIndex = 0;
const responses = new Map(); // index -> texto ya escrito (para no perderlo entre renders)
let finished = false;
let timerHandle = null;
let remainingSeconds = 0;

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
const res = await fetch('data/nivel1-writing.json');
writingData = await res.json();
} catch (err) {
quizArea.innerHTML = '<p class="note">No pudimos cargar las consignas. Recarga la página e intenta de nuevo.</p>';
return;
}
prompts = writingData.prompts || [];
if (prompts.length === 0) {
quizArea.innerHTML = '<p class="note">No hay consignas configuradas.</p>';
return;
}
remainingSeconds = writingData.timeLimitSeconds || 2400;
startTimer();
renderTask();
}

function startTimer() {
updateTimerLabel();
timerHandle = setInterval(() => {
remainingSeconds -= 1;
updateTimerLabel();
if (remainingSeconds <= 0) {
clearInterval(timerHandle);
timerHandle = null;
handleTimeout();
}
}, 1000);
}

function updateTimerLabel() {
if (!timerLabel) return;
const m = Math.floor(Math.max(0, remainingSeconds) / 60);
const s = Math.max(0, remainingSeconds) % 60;
timerLabel.textContent = `${m}:${String(s).padStart(2, '0')}`;
if (timerBox && remainingSeconds <= 120) timerBox.classList.add('timer-low');
}

function wordCount(text) {
const trimmed = (text || '').trim();
if (!trimmed) return 0;
return trimmed.split(/\s+/).length;
}

function renderTask() {
const q = prompts[currentIndex];
const total = prompts.length;
if (progressLabel) progressLabel.textContent = `Tarea ${currentIndex + 1} de ${total}`;
if (progressFill) progressFill.style.width = `${((currentIndex) / total) * 100}%`;

const saved = responses.get(currentIndex) || '';
const isLast = currentIndex === total - 1;
const promptHtml = escapeHtml(q.prompt_text).replace(/\n/g, '<br>');
const guidanceHtml = q.guidance ? `<p class="writing-guidance">${escapeHtml(q.guidance)}</p>` : '';

quizArea.innerHTML = `
<h2 class="writing-title">${escapeHtml(q.title)}</h2>
<p class="writing-prompt">${promptHtml}</p>
${guidanceHtml}
<label for="writingText" class="writing-label">Tu respuesta (en inglés):</label>
<textarea id="writingText" class="writing-textarea" rows="14" placeholder="Write your response here...">${escapeHtml(saved)}</textarea>
<div class="writing-meta">
<span id="wordCount" class="writing-wordcount"></span>
<span class="writing-range">Recomendado: ${q.min_words}–${q.max_words} palabras</span>
</div>
<p class="note" id="writingError" style="color:#c62828; display:none;"></p>
<button class="primary" id="saveBtn">${isLast ? 'Finalizar' : 'Guardar y continuar'}</button>
`;

const textarea = document.getElementById('writingText');
const wordCountEl = document.getElementById('wordCount');
const saveBtn = document.getElementById('saveBtn');

function refreshCount() {
const n = wordCount(textarea.value);
wordCountEl.textContent = `${n} ${n === 1 ? 'palabra' : 'palabras'}`;
}
refreshCount();
textarea.addEventListener('input', () => {
responses.set(currentIndex, textarea.value);
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
const q = prompts[currentIndex];
const textarea = document.getElementById('writingText');
const saveBtn = document.getElementById('saveBtn');
const text = (textarea.value || '').trim();

if (!text) {
showError('Escribe tu respuesta antes de continuar.');
return;
}
responses.set(currentIndex, textarea.value);

saveBtn.disabled = true;
const originalLabel = saveBtn.textContent;
saveBtn.textContent = 'Guardando...';

const result = await saveResponse(sessionToken, q, text);
if (result === 'unauthorized') {
return; // ya redirige a index.html
}
if (result === 'error') {
showError('No pudimos guardar tu respuesta. Revisa tu conexión e intenta de nuevo.');
saveBtn.disabled = false;
saveBtn.textContent = originalLabel;
return;
}

// Guardado OK: avanzar o finalizar.
if (currentIndex < prompts.length - 1) {
currentIndex += 1;
renderTask();
} else {
finishModule();
}
}

async function saveResponse(sessionToken, q, text) {
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
prompt_id: q.id,
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
// Si hay texto en la tarea actual, intentamos guardarlo antes de cerrar.
const sessionToken = sessionStorage.getItem('cp360_session_token');
const textarea = document.getElementById('writingText');
const text = textarea ? (textarea.value || '').trim() : '';
if (sessionToken && text) {
const q = prompts[currentIndex];
await saveResponse(sessionToken, q, text);
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
if (progressLabel) progressLabel.textContent = 'Writing completado';
renderDone(timedOut);
}

function renderDone(timedOut) {
if (timerBox) timerBox.style.display = 'none';
quizArea.style.display = 'none';
if (resultArea) {
resultArea.style.display = 'block';
resultArea.innerHTML = `
<h2>Writing completado</h2>
<p>${timedOut ? 'Se terminó el tiempo. ' : ''}Tus respuestas quedaron guardadas.</p>
<p class="note">Tu writing se revisa después; no se muestran resultados en esta pantalla.</p>
`;
}

  var __spk = document.createElement('a');
  __spk.href = 'speaking.html';
  __spk.textContent = 'Agendar tu Speaking Assessment';
  __spk.style.cssText = 'display:block;width:100%;box-sizing:border-box;text-align:center;text-decoration:none;font-weight:600;padding:0.9rem 1rem;border-radius:8px;margin:1.2rem 0 0;background:#2a6f97;color:#fff;';
  resultArea.appendChild(__spk);
}

function escapeHtml(str) {
return String(str)
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;');
}

init();

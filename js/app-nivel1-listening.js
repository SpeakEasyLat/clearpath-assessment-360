// Nivel 1 — Listening.
//
// Por cada audio: primero se muestran las preguntas (o la hoja de "patient notes"
// para los audios 7 y 8, formato note completion tipo OET), y recién después el
// estudiante reproduce el audio -- máximo la cantidad de veces que indique
// max_plays (normalmente 2), controlado server-side por el Edge Function
// get-audio-url (que devuelve una signed URL de corta duración y registra la
// reproducción en audio_play_log; el navegador nunca ve la ruta real del archivo
// en Storage).
//
// Cada respuesta se guarda vía submit-response, que corrige server-side contra
// question_bank.correct_answer / accepted_answers -- el navegador nunca los ve.
// A pedido explícito de Diana, esta pantalla NO muestra ningún acierto ni puntaje
// en vivo, solo confirma que se guardó cada módulo.
const SUPABASE_FUNCTIONS_BASE = 'https://qqdxmmvhthwcqhgmvyic.supabase.co/functions/v1';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFxZHhtbXZodGh3Y3FoZ212eWljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MzY3NDQsImV4cCI6MjA5OTAxMjc0NH0.iP5BTeUjw8FnElgQzp9r1-iSR-B9USVMcKGRs-Yh8GA';
const quizArea = document.getElementById('quizArea');
const resultArea = document.getElementById('resultArea');
const progressLabel = document.getElementById('progressLabel');
const progressFill = document.getElementById('progressFill');
let listeningData = null;
let currentAudioIndex = 0;
let currentAnswers = {}; // questionId -> string (respuestas del audio actual, todavía no confirman guardado)
const savedAnswersByGroup = {}; // audioIndex -> { questionId: string } (última respuesta ya guardada en el server)
const playsUsed = {}; // audio_asset_id -> número de reproducciones ya usadas, según el server
let saving = false;
async function init() {
const sessionToken = sessionTokenOrRedirect();
if (!sessionToken) return;
const res = await fetch('data/nivel1-listening.json');
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
function renderAudioGroup() {
const group = listeningData.audios[currentAudioIndex];
currentAnswers = { ...(savedAnswersByGroup[currentAudioIndex] || {}) };
const totalAudios = listeningData.audios.length;
progressLabel.textContent = `Audio ${currentAudioIndex + 1} / ${totalAudios}`;
progressFill.style.width = `${Math.round((currentAudioIndex / totalAudios) * 100)}%`;
const used = playsUsed[group.audio_asset_id] || 0;
const remaining = group.max_plays - used;
const isCaseNotes = group.questions[0] && group.questions[0].answer_format === 'note_completion';
quizArea.innerHTML = `
<div class="card question-card">
<div class="q-index">Nivel CEFR: ${group.cefr_level}</div>
<div class="q-text">${escapeHtml(group.title)}</div>
<p class="note">Vas a escuchar este audio como máximo ${group.max_plays} veces en total. Lee las preguntas antes de reproducirlo.</p>
<audio class="player" id="audioPlayer" controls></audio>
<div class="audio-controls">
<button class="audio-play" id="playBtn" type="button" ${remaining <= 0 ? 'disabled' : ''}>${remaining <= 0 ? 'Sin reproducciones disponibles' : 'Reproducir audio'}</button>
<span class="plays-remaining" id="playsRemaining">Reproducciones usadas: ${used} / ${group.max_plays}</span>
</div>
<p class="note" id="audioError" style="color:#c62828; display:none;"></p>
${isCaseNotes ? renderCaseNotes(group) : renderMultipleChoice(group)}
<div class="nav-row">
<button class="secondary" id="prevBtn" type="button" ${currentAudioIndex === 0 ? 'disabled' : ''}>Anterior</button>
<button class="primary" id="nextBtn" type="button">${currentAudioIndex === totalAudios - 1 ? 'Finalizar' : 'Guardar y continuar'}</button>
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
document.getElementById('prevBtn').addEventListener('click', () => {
if (currentAudioIndex > 0) {
currentAudioIndex--;
renderAudioGroup();
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
function renderCaseNotes(group) {
const rows = group.questions.map((q) => {
const parts = q.question_text.split('___');
const before = escapeHtml(parts[0] || '');
const after = escapeHtml(parts[1] || '');
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
playBtn.textContent = 'Cargando...';
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
errorEl.textContent = data.error || 'No pudimos cargar el audio. Intenta de nuevo.';
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
// Reproducción automática bloqueada por el navegador: no es un error real,
// el estudiante puede darle play manualmente con los controles nativos.
});
} catch (err) {
errorEl.textContent = 'No pudimos conectar con el servidor. Revisa tu conexión e intenta de nuevo.';
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
remainingLabel.textContent = `Reproducciones usadas: ${used} / ${group.max_plays}`;
playBtn.disabled = remaining <= 0;
playBtn.textContent = remaining <= 0 ? 'Sin reproducciones disponibles' : 'Reproducir audio';
}
async function handleNext() {
if (saving) return;
const sessionToken = sessionTokenOrRedirect();
if (!sessionToken) return;
const group = listeningData.audios[currentAudioIndex];
const totalAudios = listeningData.audios.length;
const nextBtn = document.getElementById('nextBtn');
const errorEl = document.getElementById('audioError');
saving = true;
nextBtn.disabled = true;
nextBtn.textContent = 'Guardando...';
try {
let lastResult = null;
for (const q of group.questions) {
const selected = currentAnswers[q.id];
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
const data = await res.json();
if (!res.ok) {
if (res.status === 401) {
window.location.href = 'index.html';
return;
}
throw new Error(data.error || 'No pudimos guardar tu respuesta. Intenta de nuevo.');
}
lastResult = data;
}
savedAnswersByGroup[currentAudioIndex] = { ...currentAnswers };
if (currentAudioIndex < totalAudios - 1) {
currentAudioIndex++;
renderAudioGroup();
} else {
renderDone(lastResult);
}
} catch (err) {
errorEl.textContent = (err && err.message) || 'No pudimos guardar tus respuestas. Intenta de nuevo.';
errorEl.style.display = 'block';
} finally {
saving = false;
const btn = document.getElementById('nextBtn');
if (btn) {
btn.disabled = false;
btn.textContent = currentAudioIndex === totalAudios - 1 ? 'Finalizar' : 'Guardar y continuar';
}
}
}
function renderDone() {
quizArea.style.display = 'none';
resultArea.style.display = 'block';
progressFill.style.width = '100%';
progressLabel.textContent = `Audio ${listeningData.audios.length} / ${listeningData.audios.length}`;
resultArea.innerHTML = `
<div class="card">
<h3>Listening completado</h3>
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

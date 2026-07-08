// Formulario de intake (NO calificado) que el estudiante completa después de hacer
// login y antes de arrancar Nivel 1. Guarda contexto (nivel autopercibido, experiencia
// previa, uso del idioma, disponibilidad horaria) vía el Edge Function submit-intake.
// Franjas horarias definidas por Diana: lunes a viernes, hora Colombia.
const SUPABASE_FUNCTIONS_BASE = 'https://qqdxmmvhthwcqhgmvyic.supabase.co/functions/v1';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFxZHhtbXZodGh3Y3FoZ212eWljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MzY3NDQsImV4cCI6MjA5OTAxMjc0NH0.iP5BTeUjw8FnElgQzp9r1-iSR-B9USVMcKGRs-Yh8GA';
const LEVEL_OPTIONS = ['Principiante (A1-A2)', 'Intermedio (B1-B2)', 'Avanzado (C1-C2)', 'No estoy seguro/a'];
const EXPERIENCE_OPTIONS = ['Colegio o escuela', 'Instituto o academia', 'Clases particulares', 'Autodidacta (apps, videos, etc.)', 'Viví o trabajé en un país de habla inglesa', 'Ninguna experiencia formal'];
const PRACTICE_OPTIONS = ['Actualmente estoy estudiando o practicando', 'Menos de 6 meses sin practicar', 'Entre 6 meses y 2 años sin practicar', 'Más de 2 años sin practicar', 'Nunca practiqué de forma regular'];
const USAGE_OPTIONS = ['Todos los días (trabajo, estudio o vida diaria)', 'Varias veces por semana', 'Rara vez', 'Prácticamente nunca'];
const HOURS_OPTIONS = ['Menos de 2 horas', 'Entre 2 y 5 horas', 'Entre 5 y 10 horas', 'Más de 10 horas'];
const DAYS_OPTIONS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'];
const SLOT_OPTIONS = [
'Mañana (8:00am - 10:00am)',
'Media mañana (10:00am - 12:00pm)',
'Mediodía (12:00pm - 2:00pm)',
'Media tarde (2:00pm - 4:00pm)',
'Tarde (4:00pm - 6:00pm)',
];
const state = {
level: null,
experience: new Set(),
practice: null,
usage: null,
hours: null,
days: new Set(),
slots: new Set(),
};
const errorMsg = document.getElementById('errorMsg');
const submitBtn = document.getElementById('submitBtn');
function init() {
const sessionToken = sessionStorage.getItem('cp360_session_token');
if (!sessionToken) {
window.location.href = 'index.html';
return;
}
renderSingleSelect('levelOptions', LEVEL_OPTIONS, 'level');
renderMultiSelect('experienceOptions', EXPERIENCE_OPTIONS, 'experience');
renderSingleSelect('practiceOptions', PRACTICE_OPTIONS, 'practice');
renderSingleSelect('usageOptions', USAGE_OPTIONS, 'usage');
renderSingleSelect('hoursOptions', HOURS_OPTIONS, 'hours');
renderMultiSelect('daysOptions', DAYS_OPTIONS, 'days');
renderMultiSelect('slotsOptions', SLOT_OPTIONS, 'slots');
submitBtn.addEventListener('click', handleSubmit);
}
function renderSingleSelect(containerId, options, stateKey) {
const container = document.getElementById(containerId);
container.innerHTML = '';
options.forEach((opt) => {
const btn = document.createElement('button');
btn.type = 'button';
btn.className = 'option' + (state[stateKey] === opt ? ' selected' : '');
btn.textContent = opt;
btn.addEventListener('click', () => {
state[stateKey] = opt;
renderSingleSelect(containerId, options, stateKey);
});
container.appendChild(btn);
});
}
function renderMultiSelect(containerId, options, stateKey) {
const container = document.getElementById(containerId);
container.innerHTML = '';
options.forEach((opt) => {
const btn = document.createElement('button');
btn.type = 'button';
btn.className = 'option' + (state[stateKey].has(opt) ? ' selected' : '');
btn.textContent = opt;
btn.addEventListener('click', () => {
if (state[stateKey].has(opt)) {
state[stateKey].delete(opt);
} else {
state[stateKey].add(opt);
}
renderMultiSelect(containerId, options, stateKey);
});
container.appendChild(btn);
});
}
function showError(msg) {
errorMsg.textContent = msg;
errorMsg.style.display = 'block';
}
async function handleSubmit() {
errorMsg.style.display = 'none';
if (
!state.level ||
!state.practice ||
!state.usage ||
!state.hours ||
state.experience.size === 0 ||
state.days.size === 0 ||
state.slots.size === 0
) {
showError('Por favor completa todas las preguntas antes de continuar.');
return;
}
const sessionToken = sessionStorage.getItem('cp360_session_token');
if (!sessionToken) {
window.location.href = 'index.html';
return;
}
submitBtn.disabled = true;
submitBtn.textContent = 'Guardando...';
try {
const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/submit-intake`, {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
'apikey': SUPABASE_ANON_KEY,
},
body: JSON.stringify({
session_token: sessionToken,
self_perceived_level: state.level,
prior_experience: Array.from(state.experience),
time_since_regular_practice: state.practice,
usage_frequency: state.usage,
weekly_hours_available: state.hours,
preferred_days: Array.from(state.days),
preferred_time_slots: Array.from(state.slots),
}),
});
const data = await res.json();
if (!res.ok) {
showError(data.error || 'No pudimos guardar tus respuestas. Intenta de nuevo.');
submitBtn.disabled = false;
submitBtn.textContent = 'Continuar al examen';
return;
}
window.location.href = 'nivel1.html';
} catch (err) {
showError('No pudimos conectar con el servidor. Revisa tu conexión e intenta de nuevo.');
submitBtn.disabled = false;
submitBtn.textContent = 'Continuar al examen';
}
}
init();

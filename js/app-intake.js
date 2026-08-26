// Formulario de intake (NO calificado) que el estudiante completa después de hacer
// login y antes de arrancar Nivel 1. Guarda contexto (nivel autopercibido, experiencia
// previa, uso del idioma) vía el Edge Function submit-intake.
//
// NOTA (06/08/2026): se quitaron a pedido de Diana las preguntas de horas por semana
// disponibles, días preferidos y franjas horarias -- ya no se muestran ni se envían.
//
// NOTA (26/08/2026, caso de Araceli): antes de mostrar el formulario, se consulta
// get-intake-status -- si el estudiante ya lo había llenado en una sesión anterior
// (recargó la página o volvió a entrar con el mismo código antes de terminar el
// attempt), no lo obligamos a repetirlo: se salta directo a siguiente.html (el router),
// que ya sabe mandarlo al primer módulo real que le falte -- mismo criterio que
// get-module-progress usa dentro de cada módulo calificado. Si la consulta falla (sin
// conexión), no bloquea: se muestra el formulario como antes.
const SUPABASE_FUNCTIONS_BASE = 'https://qqdxmmvhthwcqhgmvyic.supabase.co/functions/v1';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFxZHhtbXZodGh3Y3FoZ212eWljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MzY3NDQsImV4cCI6MjA5OTAxMjc0NH0.iP5BTeUjw8FnElgQzp9r1-iSR-B9USVMcKGRs-Yh8GA';
const LEVEL_OPTIONS = ['Principiante (A1-A2)', 'Intermedio (B1-B2)', 'Avanzado (C1-C2)', 'No estoy seguro/a'];
const EXPERIENCE_OPTIONS = ['Colegio o escuela', 'Instituto o academia', 'Clases particulares', 'Autodidacta (apps, videos, etc.)', 'Viví o trabajé en un país de habla inglesa', 'Ninguna experiencia formal'];
const PRACTICE_OPTIONS = ['Actualmente estoy estudiando o practicando', 'Menos de 6 meses sin practicar', 'Entre 6 meses y 2 años sin practicar', 'Más de 2 años sin practicar', 'Nunca practiqué de forma regular'];
const USAGE_OPTIONS = ['Todos los días (trabajo, estudio o vida diaria)', 'Varias veces por semana', 'Rara vez', 'Prácticamente nunca'];
const state = {
level: null,
experience: new Set(),
practice: null,
usage: null,
};
const errorMsg = document.getElementById('errorMsg');
const submitBtn = document.getElementById('submitBtn');
async function init() {
const sessionToken = sessionStorage.getItem('cp360_session_token');
if (!sessionToken) {
window.location.href = 'index.html';
return;
}
const alreadyCompleted = await checkIntakeAlreadyCompleted(sessionToken);
if (alreadyCompleted) {
window.location.href = 'siguiente.html';
return;
}
renderSingleSelect('levelOptions', LEVEL_OPTIONS, 'level');
renderMultiSelect('experienceOptions', EXPERIENCE_OPTIONS, 'experience');
renderSingleSelect('practiceOptions', PRACTICE_OPTIONS, 'practice');
renderSingleSelect('usageOptions', USAGE_OPTIONS, 'usage');
submitBtn.addEventListener('click', handleSubmit);
}

// Devuelve true solo si el intake de este attempt ya existe en la base. Ante
// cualquier error (401, red caída, etc.) devuelve false para no bloquear: el
// estudiante ve el formulario como si nunca lo hubiera llenado, en vez de quedarse
// atascado en una pantalla en blanco.
async function checkIntakeAlreadyCompleted(sessionToken) {
try {
const res = await fetch(`${SUPABASE_FUNCTIONS_BASE}/get-intake-status`, {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
'apikey': SUPABASE_ANON_KEY,
},
body: JSON.stringify({ session_token: sessionToken }),
});
if (!res.ok) return false;
const data = await res.json();
return data.completed === true;
} catch (err) {
return false;
}
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
state.experience.size === 0
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

// Edge Function: submit-response
//
// Recibe la respuesta que el estudiante elige para una pregunta (session_token +
// question_id + selected_answer), la corrige contra question_bank.correct_answer /
// accepted_answers (que el navegador nunca ve), la guarda, y -- a pedido explicito
// de Diana -- NO devuelve si acerto o no, ni ningun puntaje parcial. El estudiante
// solo se entera de "guardado, pasa a la siguiente" (o "se termino este modulo"),
// nunca de su desempeno en vivo.
//
// Soporta dos formatos de pregunta (question_bank.answer_format):
//   - multiple_choice: selected_answer debe coincidir con correct_answer
//     (comparacion insensible a mayusculas/espacios).
//   - note_completion: selected_answer se compara contra CUALQUIERA de las
//     variantes en accepted_answers (ej. "4" y "four" son ambas correctas),
//     tambien insensible a mayusculas/espacios. Si accepted_answers viene
//     vacio o null, se usa correct_answer como unica variante valida.
//
// Cuando la respuesta guardada completa todas las preguntas del modulo para este
// attempt, calcula el sub_score (ceiling CEFR, igual al algoritmo de js/scoring.js)
// y recalcula la ruta del Nivel 1 (OET / STEPS2 / ENGLISH).
//
// v22 (09/09/2026, pedido de Diana): el nivel MOSTRADO en el reporte (cefr_estimate)
// ahora es el nivel rescatado por highestPassingBand() cuando hubo un traspie puntual
// en una banda intermedia -- antes (v21) el rescate SOLO afectaba la elegibilidad a
// OET/STEPS2 (band_detail.oet_effective_level), y el reporte seguia mostrando el
// ceiling bottom-up de siempre (computeCeiling). Diana aclaro que el nivel rescatado
// tambien debe ser el que se muestra, con una nota explicando la inconsistencia --
// nunca "silenciar" el traspie, pero tampoco penalizar con el nivel mas bajo cuando el
// estudiante demostro consistentemente un nivel mas alto (>=70%) en una banda superior.
// Cuando NO hay traspie, highestPassingBand() da exactamente el mismo resultado que
// computeCeiling() (ver comentario de esa funcion), asi que este cambio no afecta el
// caso normal. El ceiling bottom-up viejo se sigue calculando y ahora se guarda aparte,
// en band_detail.ceiling_level, solo para auditoria de Diana -- ya no es el nivel
// mostrado. Ver highestPassingBand() y el bloque de calculo mas abajo. DUPLICADO en
// js/scoring.js (comentario alli tambien corregido) -- submit-writing.ts no necesita
// cambios, porque solo LEE cefr_estimate/oet_effective_level ya calculados aca, nunca
// los calcula el mismo. Recalculo retroactivo para los 3 casos reales ya afectados
// (Carlos Diaz Arizmendi, Juan Sebastian Estrada Reyna, Luis Padilla) hecho por SQL
// directo el mismo dia, no por este codigo -- ver memoria de proyecto.
//
// v21 (31/08/2026, pedido de Diana, caso de Luis Padilla): reemplaza el rescate de OET
// que antes existia SOLO para Listening (LISTENING_B2_RESCUE_THRESHOLD = 75% especifico
// en la banda B2) por una regla general, aplicada a las 3 destrezas con banda (grammar,
// listening, reading): si el estudiante aprobo (>=70%, el mismo PERCENT_THRESHOLD de
// siempre) una banda POR ENCIMA de donde se corto el ceiling -- sin importar si esa
// banda es B2 o C1 -- se le da el beneficio de la duda del NIVEL MAS ALTO que aprobo,
// pero SOLO para efectos de elegibilidad a OET/STEPS2 (el ceiling mostrado en el
// reporte, cefr_estimate, NO cambia -- sigue siendo el resultado bottom-up de siempre).
// [ESTO ULTIMO YA NO ES ASI DESDE v22 DE ARRIBA -- cefr_estimate ahora SI refleja el
// rescate.] Ver highestPassingBand() mas abajo. Ademas, la regla para abrir OET deja de
// exigir que las 4 destrezas dan B2+ -- ahora alcanza con que 3 de las 4 lo hagan
// (usando este nivel "efectivo"), siempre que la restante no sea inferior a B1. Ver
// recomputeRouteAndPersist. DUPLICADO en submit-writing.ts, mantener sincronizados; y
// generate-report.ts / generate-partial-report.ts ya no filtran la nota a "solo
// listening", la muestran para cualquier destreza que traiga oet_unlock_note.
//
// v14 (14/08/2026): recomputeRouteAndPersist ahora lee attempts.track y fuerza la
// ruta ENGLISH para NIVEL1_ONLY sin evaluar los niveles CEFR -- bug real encontrado
// antes de que ningun estudiante lo pisara (ver comentario en la funcion).
//
// v11 (06/08/2026): agrega OET Listening y OET Reading (Fase 4, module ===
// 'oet_listening' | 'oet_reading'). Decision de Diana: estos dos modulos son SOLO
// puntaje informativo -- los estudiantes que llegan aca ya calificaron para OET en el
// Nivel 1 (los 4 skills >= B2), asi que no hay banda CEFR ni aprobar/reprobar, solo
// raw_score/max_score para que Diana los revise. Rama nueva, analoga a steps2 pero sin
// threshold/passed. Tampoco llama a recomputeRouteAndPersist (la ruta del Nivel 1 ya
// quedo fija; estos sub_scores solo le sirven a get-unlock-state para encadenar las
// pantallas de OET).
//
// v10 (05/08/2026): agrega el modulo STEP CK 2 (module === 'steps2'). A diferencia de
// Grammar/Listening/Reading, sus preguntas tienen cefr_level = null (no hay bandas --
// decision de Diana: "en steps no hay banda, tiene que sacar al menos el 75% correcto
// para aprobarlos o falla"). Se agrega una rama separada que calcula porcentaje simple
// y pass/fail (>=75%) y la guarda en sub_scores.band_detail con cefr_estimate = null,
// sin pasar por computeCeiling()/detectPatternInconsistency() (que asumen bandas CEFR y
// siempre devolverian null/false para este modulo). No se llama a
// recomputeRouteAndPersist para steps2: la ruta del Nivel 1 (OET/STEPS2/ENGLISH) ya
// quedo fija cuando se completaron los 4 modulos de Nivel 1 y no depende de
// steps2_reading -- ese sub_score solo le sirve a get-unlock-state para saber si el
// estudiante ya rindio STEP CK 2.
//
// v9 (05/08/2026): decision de Diana -- "nunca decision manual, si es inconsistente
// debe quedar un registro en el resultado del assessment 360". Se agrega
// detectPatternInconsistency() y se persiste sub_scores.band_detail (jsonb, columna
// nueva via migracion sub_scores_band_detail) con el detalle por banda y un booleano
// pattern_inconsistent. Esto es SOLO diagnostico: el ceiling asignado y la ruta
// (OET/STEPS2/ENGLISH) se siguen calculando automaticamente, sin bloqueo, exactamente
// igual que antes -- nada queda esperando revision manual.
//
// v7 (05/08/2026, tarea 1.3): agrega "reading" a MODULE_TO_SKILL (modulo
// nivel1_reading) y reescribe la decision de ruta como las TRES ramas de
// claude/flujo-objetivo.md en vez de la regla binaria vieja (oetUnlocked ?
// 'OET' : 'English'). La decision de ruta (assignedRoute) solo se calcula y
// se guarda cuando existen los CUATRO sub_scores del Nivel 1 (grammar,
// listening, writing, reading) -- mientras falte alguno, queda en null
// ("pendiente"), igual que en js/scoring.js (deben mantenerse sincronizados,
// ver ese archivo para el razonamiento completo de la regla). Tambien marca
// attempts.status = 'completed' apenas se asigna la ruta (tarea 1.8).
//
// OJO: esta misma logica de recalculo de ruta (deciderAndPersistRoute) esta
// DUPLICADA en submit-writing, porque el sub_score de writing se calcula ahi
// (con IA) y no aca. Cualquier cambio a la regla debe aplicarse en los dos
// lugares. Mantenerlos sincronizados.
//
// Corre con el service_role key (inyectado automaticamente por Supabase).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
"Access-Control-Allow-Origin": "*",
"Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
"Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body, status = 200) {
return new Response(JSON.stringify(body), {
status,
headers: { "Content-Type": "application/json", ...CORS_HEADERS },
});
}

// --- Mismos umbrales y algoritmo que js/scoring.js (mantenerlos sincronizados) ----
const CEFR_ORDER = ["A1", "A2", "B1", "B2", "C1"];
const PERCENT_THRESHOLD = 70;
const MIN_LEVEL_FOR_OET = "B2";
const MIN_LEVEL_FOR_STEPS2 = "B2";
// Minimo absoluto para la destreza "floja" cuando se abre OET por la regla de 3-de-4
// (ver recomputeRouteAndPersist v21 mas abajo) -- nunca deja pasar una destreza
// genuinamente A1/A2 solo porque las otras tres compensan.
const MIN_LEVEL_FLOOR_FOR_OET = "B1";

const SKILL_LABELS_ES = {
grammar: "Grammar",
listening: "Listening",
reading: "Reading",
};

// STEP CK 2 (Fase 3): pass/fail puro, sin bandas CEFR. Decision de Diana (05/08/2026):
// ">=75% correcto para aprobar". Con 8 preguntas eso era exactamente 6/8 (75.0%).
//
// v (24/08/2026, pedido de Diana): el banco de steps2 se redisenio por completo -- las
// 8 vinetas clinicas originales median conocimiento medico/de manejo clinico (formato
// USMLE), no habilidad de lectura en ingles, que es lo que este modulo dice evaluar
// (los datos mostraban 0%-50% de aciertos por pregunta). Se mantuvo el texto de cada
// vineta pero se reemplazo la pregunta final por DOS preguntas de comprension lectora
// (gist + vocabulario en contexto C1-C2), lo que paso el banco de 8 a 16 preguntas.
// No hizo falta tocar nada de este archivo: el calculo de abajo es 100% dinamico
// (cuenta las preguntas de question_bank en runtime via totalInModule/moduleQuestionIds,
// nunca un numero fijo), asi que 12/16 sigue siendo el mismo 75% que antes era 6/8. Ver
// data/steps2.json y js/app-steps2.js para el contenido nuevo.
const STEPS2_PASS_THRESHOLD = 75;

// v13 (11/08/2026): agrega nivel1_listening_general y nivel1_reading_general (los
// modulos de Listening/Reading del track NIVEL1_ONLY / Assessment Speak Easy).
// BUG REAL encontrado antes de que ningun estudiante lo pisara (0 respuestas
// registradas en esos dos modulos al momento del fix): sin esta entrada, skill salia
// undefined para esos modulos, la rama `else if (skill)` de mas abajo nunca se
// ejecutaba, y el sub_score de listening/reading nunca se guardaba -- el estudiante
// terminaba el modulo en pantalla pero el attempt se quedaba sin ese sub_score para
// siempre, sin poder avanzar (nivel1Complete nunca se cumple). Fix aditivo, no toca
// ninguna rama existente.
//
// module (question_bank) -> skill (sub_scores).
const MODULE_TO_SKILL = {
nivel1_grammar: "grammar",
nivel1_listening: "listening",
nivel1_listening_general: "listening",
nivel1_reading: "reading",
nivel1_reading_general: "reading",
steps2: "steps2_reading",
oet_listening: "oet_listening",
oet_reading: "oet_reading",
};

function meetsLevel(level, minLevel) {
if (!level) return false;
const idx = CEFR_ORDER.indexOf(level);
const minIdx = CEFR_ORDER.indexOf(minLevel);
return idx >= 0 && minIdx >= 0 && idx >= minIdx;
}

function computeCeiling(perBand) {
let ceilingLevel = null;
for (const level of CEFR_ORDER) {
const band = perBand[level];
if (band && band.total > 0 && band.percent >= PERCENT_THRESHOLD) {
ceilingLevel = level;
} else if (band && band.total > 0) {
break;
}
}
return ceilingLevel;
}

// Decision de Diana (05/08/2026): "nunca decision manual, si es inconsistente debe
// quedar un registro en el resultado del assessment 360". El ceiling YA se asigna
// siempre en forma automatica (nunca bloquea), pero un patron con "huecos" -- ej.
// aprueba B2 pero falla B1, o falla A1 pero aprueba A2+ -- merece quedar trazado
// para que Diana pueda auditarlo despues sin que nadie tenga que intervenir para
// que el estudiante avance. True cuando alguna banda POR ENCIMA del ceiling
// calculado (la banda donde se corto la racha, o cualquiera despues) en realidad
// supero el umbral.
function detectPatternInconsistency(perBand, ceilingLevel) {
const ceilingIdx = ceilingLevel ? CEFR_ORDER.indexOf(ceilingLevel) : -1;
for (let i = ceilingIdx + 1; i < CEFR_ORDER.length; i++) {
const band = perBand[CEFR_ORDER[i]];
if (band && band.total > 0 && band.percent >= PERCENT_THRESHOLD) {
return true;
}
}
return false;
}

// v21 (31/08/2026, pedido de Diana, caso de Luis Padilla): a diferencia de
// computeCeiling() (que se DETIENE en la primera banda reprobada, aunque una banda mas
// arriba se haya aprobado), esta funcion recorre TODAS las bandas de A1 a C1 y devuelve
// la MAS ALTA que haya superado el umbral -- sin cortar en el primer traspie. Cuando no
// hay ningun traspie de por medio, da exactamente el mismo resultado que computeCeiling
// (porque todas las bandas por debajo del ceiling, por construccion, ya lo superaron).
// Cuando SI hay un traspie puntual (ej. aprobo A1/A2/B1/C1 pero fallo B2), devuelve el
// nivel mas alto real (C1 en ese ejemplo) -- ese es el "beneficio de la duda" que pidio
// Diana. v22 (09/09/2026): este es ahora tambien el nivel MOSTRADO (cefr_estimate) --
// ver comentario largo de v22 al inicio del archivo. Antes (v21) se usaba solo para
// decidir elegibilidad a OET/STEPS2.
function highestPassingBand(perBand) {
let best = null;
for (const level of CEFR_ORDER) {
const band = perBand[level];
if (band && band.total > 0 && band.percent >= PERCENT_THRESHOLD) {
best = level;
}
}
return best;
}

// Normaliza para comparar respuestas de forma insensible a mayusculas/espacios
// (ej. " Four " === "four", "38.5" === "38.5 "). No toca acentos porque las
// respuestas de Listening/Reading son en ingles.
function normalizeAnswer(value) {
return typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";
}

function gradeAnswer(question, selectedAnswer) {
if (selectedAnswer === null || selectedAnswer === undefined) return false;
const normalizedSelected = normalizeAnswer(selectedAnswer);
if (!normalizedSelected) return false;

if (question.answer_format === "note_completion") {
const variants = Array.isArray(question.accepted_answers) && question.accepted_answers.length > 0
? question.accepted_answers
: [question.correct_answer];
return variants.some((variant) => normalizeAnswer(variant) === normalizedSelected);
}

// multiple_choice (default)
return normalizedSelected === normalizeAnswer(question.correct_answer);
}

// Recalcula la ruta del Nivel 1 (OET / STEPS2 / ENGLISH) con TODOS los sub_scores
// disponibles hasta ahora, y la persiste en unlock_state + attempts.status. Devuelve
// el resultado por si el llamador lo necesita (no se usa hoy, pero deja la funcion
// reutilizable). Debe mantenerse identica a la version en submit-writing.
async function recomputeRouteAndPersist(supabase, attemptId) {
// v14 (14/08/2026, bug real encontrado antes de que ningun estudiante lo pisara):
// falta esta lectura de track, un estudiante de NIVEL1_ONLY que sacara B2 en las 4
// destrezas de Nivel 1 quedaba asignado a la ruta OET o STEPS2 igual que uno de
// FULL_360, y get-unlock-state lo mandaba a oet-listening.html/steps2.html --
// modulos con contenido medico que no existen para este producto. NIVEL1_ONLY debe
// quedar SIEMPRE en la ruta ENGLISH (Speaking breve tipo English), sin importar el
// resultado -- ver seccion 1 del Brief. Mantener sincronizado con submit-writing.
const { data: attemptRow, error: attemptTrackError } = await supabase
.from("attempts")
.select("track")
.eq("id", attemptId)
.maybeSingle();

if (attemptTrackError) {
console.error("submit-response: error leyendo track del attempt", attemptTrackError);
return { error: "Error interno. Intenta de nuevo en un momento." };
}
const track = attemptRow ? attemptRow.track : null;

const { data: allSubScores, error: allSubScoresError } = await supabase
.from("sub_scores")
.select("skill, cefr_estimate, band_detail")
.eq("attempt_id", attemptId);

if (allSubScoresError) {
console.error("submit-response: error leyendo sub_scores", allSubScoresError);
return { error: "Error interno. Intenta de nuevo en un momento." };
}

// OJO: un sub_score puede existir con cefr_estimate = null (el estudiante no superó
// ni la banda A1 -- eso es un resultado legítimo, no "todavía no rindió"). Por eso
// "completo" se determina por la PRESENCIA de la fila en sub_scores (skillsPresent),
// nunca por si cefr_estimate es truthy. Confundir esto fue un bug real: un estudiante
// con reading por debajo de A1 se quedaba con assignedRoute = null para siempre.
const bySkill = Object.fromEntries(allSubScores.map((s) => [s.skill, s]));
const skillsPresent = new Set(allSubScores.map((s) => s.skill));

// v21 (31/08/2026, pedido de Diana, caso de Luis Padilla): nivel "efectivo" por
// destreza para decidir OET/STEPS2 -- usa band_detail.oet_effective_level (el
// highestPassingBand guardado mas abajo) cuando existe, que puede ser mas alto que el
// cefr_estimate mostrado si hubo un traspie puntual en una banda intermedia. Writing
// no tiene bandas (rubrica IA holistica), asi que cae directo a su cefr_estimate.
// v22 (09/09/2026): desde ahora cefr_estimate YA ES el nivel efectivo cuando hubo
// override, asi que esta funcion da el mismo resultado leyendo cualquiera de los dos
// campos -- se deja igual, sin tocar, por no romper nada que dependa de ella.
function effectiveLevel(skillName) {
const row = bySkill[skillName];
if (!row) return null;
return (row.band_detail && row.band_detail.oet_effective_level) || row.cefr_estimate || null;
}
const grammarEff = effectiveLevel("grammar");
const listeningEff = effectiveLevel("listening");
const readingEff = effectiveLevel("reading");
const writingEff = effectiveLevel("writing");

const nivel1Complete =
skillsPresent.has("grammar") && skillsPresent.has("listening") && skillsPresent.has("writing") && skillsPresent.has("reading");

let assignedRoute = null;
let oetUnlocked = false;
let steps2Unlocked = false;
let speakingAssessmentType = null;

if (nivel1Complete) {
if (track === "NIVEL1_ONLY") {
// NIVEL1_ONLY nunca pasa por STEPS2 ni OET, sin importar el resultado (ver
// comentario mas arriba y seccion 1 del Brief) -- se fuerza ENGLISH sin
// evaluar los niveles CEFR.
assignedRoute = "ENGLISH";
oetUnlocked = false;
steps2Unlocked = false;
speakingAssessmentType = "English";
} else {
// v21 (31/08/2026, pedido de Diana, caso de Luis Padilla): ya NO hace falta que
// las 4 destrezas den B2+ para abrir OET -- alcanza con que 3 de las 4 lo hagan
// (usando el nivel "efectivo" de arriba, que puede incluir el beneficio de la
// duda de highestPassingBand), siempre que la restante no sea inferior a B1 --
// eso evita que una destreza genuinamente floja (A1/A2) cuele a alguien a OET
// solo porque las otras tres compensan. Antes: allFourOk exigia meetsLevel(...,
// B2) en las 4 destrezas (con un override booleano solo para listening).
const levels = [grammarEff, listeningEff, writingEff, readingEff];
const countB2Plus = levels.filter((l) => meetsLevel(l, MIN_LEVEL_FOR_OET)).length;
const allAtLeastFloor = levels.every((l) => meetsLevel(l, MIN_LEVEL_FLOOR_FOR_OET));
const allFourOk = countB2Plus >= 3 && allAtLeastFloor;
const readingOk = meetsLevel(readingEff, MIN_LEVEL_FOR_STEPS2);

// Regla de Diana (claude/flujo-objetivo.md, ajustada 31/08/2026 -- ver arriba):
// 3 de 4 destrezas en B2+ (con la 4ta en al menos B1) -> OET; si no, "el reading
// es la llave de STEPS 2" -- si reading >= B2 -> STEPS2; si no -> ENGLISH.
assignedRoute = allFourOk ? "OET" : (readingOk ? "STEPS2" : "ENGLISH");
oetUnlocked = assignedRoute === "OET";
steps2Unlocked = assignedRoute === "STEPS2";
// El modulo STEPS 2 (Fase 3) todavia no existe: mientras tanto, tanto la ruta
// STEPS2 como la ruta ENGLISH agendan el mismo Speaking Assessment breve tipo
// 'English' (ver diagrama en flujo-objetivo.md: STEPS 2 -> Link English Speaking).
speakingAssessmentType = assignedRoute === "OET" ? "OET" : "English";
}
}

const { error: unlockError } = await supabase
.from("unlock_state")
.upsert(
{
attempt_id: attemptId,
steps2_unlocked: steps2Unlocked,
oet_unlocked: oetUnlocked,
speaking_assessment_type: speakingAssessmentType,
assigned_route: assignedRoute,
updated_at: new Date().toISOString(),
},
{ onConflict: "attempt_id" },
);

if (unlockError) {
console.error("submit-response: error actualizando unlock_state", unlockError);
return { error: "Error interno. Intenta de nuevo en un momento." };
}

// v12 (10/08/2026, pedido de Diana): ya NO marcamos completed aca con solo
// nivel1Complete -- para las rutas OET y STEPS2 todavia quedan modulos pendientes en
// este punto (OET Listening/Reading/Writing, o STEP CK 2). Eso es lo que
// checkAndMarkAttemptComplete() (mas abajo) resuelve correctamente para las 3 rutas;
// se llama aca abajo con el assignedRoute recien calculado, y tambien se llama de
// forma independiente desde los otros puntos donde termina un modulo final de la ruta
// (steps2 en este mismo archivo, oet_writing en submit-writing) -- ver el comentario
// largo en esa funcion para el porque completo.
if (nivel1Complete) {
await checkAndMarkAttemptComplete(supabase, attemptId, assignedRoute);
}

return { assignedRoute, oetUnlocked, steps2Unlocked, speakingAssessmentType, nivel1Complete };
}

// Dispara generate-partial-report de forma fire-and-forget para este attempt --
// pedido de Diana (24/08/2026): quiere el reporte parcial (sin Speaking) apenas
// termina la parte escrita del assessment, no solo el reporte final (que espera
// Speaking, ver generate-report). Se llama SOLO desde checkAndMarkAttemptComplete,
// justo despues de marcar attempts.status = 'completed' -- exactamente el momento en
// que termina la parte escrita para las 3 rutas (ENGLISH/STEPS2/OET). Es idempotente
// (attempts.partial_report_sent_at) y nunca bloquea ni falla esta funcion si tiene un
// problema. DUPLICADA en submit-writing.ts (mismo motivo que checkAndMarkAttemptComplete
// -- cualquiera de las dos puede ser la que cierre la parte escrita), mantener
// sincronizada.
function triggerPartialReport(attemptId) {
fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-partial-report`, {
method: "POST",
headers: {
"Content-Type": "application/json",
"Authorization": `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}`,
"apikey": Deno.env.get("SUPABASE_ANON_KEY"),
},
body: JSON.stringify({ attempt_id: attemptId }),
}).catch((err) => {
console.error("submit-response: no se pudo disparar generate-partial-report", err);
});
}

// Marca attempts.status = 'completed' solo cuando el estudiante ya no tiene NINGUN
// modulo pendiente segun la ruta que le toco -- no solo Nivel 1. Bug real que esto
// corrige (encontrado 10/08/2026): antes, el attempt se marcaba completed apenas
// terminaba Nivel 1 (los 4 sub_scores de grammar/listening/writing/reading), aunque
// para las rutas OET y STEPS2 todavia quedaran modulos por rendir (OET Listening/
// Reading/Writing, o STEP CK 2). Si en ese punto el estudiante recargaba la pagina o
// volvia a entrar con el mismo access_code, login() (attempt.status !== "in_progress"
// -> crear nuevo) le armaba un attempt en blanco y perdia TODO Nivel 1, no solo el
// modulo en el que estaba parado -- esto era el bug reportado como "me llevo a
// grammar". Ahora: ENGLISH no tiene modulos extra (Nivel 1 completo ya es todo el
// recorrido); OET necesita ademas oet_listening + oet_reading + oet_writing; STEPS2
// necesita ademas steps2_reading. Mientras falte alguno de esos, el attempt sigue
// in_progress y login() siempre retoma el mismo attempt sin importar cuantas veces el
// estudiante recargue o reingrese. Se llama desde el final de cada ruta: nivel1
// (recomputeRouteAndPersist, arriba, cubre ENGLISH), steps2 (mas abajo en este mismo
// archivo), y oet_writing (submit-writing/index.ts -- DUPLICADA alli, mantener
// sincronizada).
async function checkAndMarkAttemptComplete(supabase, attemptId, knownAssignedRoute) {
let assignedRoute = knownAssignedRoute;
if (assignedRoute === undefined) {
const { data: unlock, error: unlockError } = await supabase
.from("unlock_state")
.select("assigned_route")
.eq("attempt_id", attemptId)
.maybeSingle();
if (unlockError) {
console.error("checkAndMarkAttemptComplete: error leyendo unlock_state", unlockError);
return;
}
assignedRoute = unlock ? unlock.assigned_route : null;
}
if (!assignedRoute) return; // Nivel 1 todavia no termino -- nada que cerrar.

const { data: subScores, error: subScoresError } = await supabase
.from("sub_scores")
.select("skill")
.eq("attempt_id", attemptId);
if (subScoresError) {
console.error("checkAndMarkAttemptComplete: error leyendo sub_scores", subScoresError);
return;
}
const skillsPresent = new Set((subScores || []).map((s) => s.skill));

let fullJourneyComplete = false;
if (assignedRoute === "OET") {
fullJourneyComplete =
skillsPresent.has("oet_listening") && skillsPresent.has("oet_reading") && skillsPresent.has("oet_writing");
} else if (assignedRoute === "STEPS2") {
fullJourneyComplete = skillsPresent.has("steps2_reading");
} else {
fullJourneyComplete = true; // ENGLISH: Nivel 1 completo ya es todo el recorrido.
}
if (!fullJourneyComplete) return;

const { error: attemptError } = await supabase
.from("attempts")
.update({ status: "completed", completed_at: new Date().toISOString() })
.eq("id", attemptId)
.neq("status", "completed");
if (attemptError) {
console.error("checkAndMarkAttemptComplete: error marcando attempt completed", attemptError);
// No cortamos la respuesta por esto -- el router (get-unlock-state) sigue
// funcionando igual de bien con status in_progress. Se puede reintentar/corregir a
// mano si hace falta.
return;
}

// Recien aca el attempt quedo 'completed' de verdad (el .neq de arriba evita
// disparar esto de nuevo si ya estaba completed de antes). Ver triggerPartialReport.
triggerPartialReport(attemptId);
}

Deno.serve(async (req) => {
if (req.method === "OPTIONS") {
return new Response(null, { headers: CORS_HEADERS });
}
if (req.method !== "POST") {
return json({ error: "Metodo no permitido." }, 405);
}

let body;
try {
body = await req.json();
} catch {
return json({ error: "Body invalido." }, 400);
}

const sessionToken = typeof body.session_token === "string" ? body.session_token.trim() : "";
const questionId = typeof body.question_id === "string" ? body.question_id.trim() : "";
const selectedAnswer = typeof body.selected_answer === "string" ? body.selected_answer : null;

if (!sessionToken || !questionId) {
return json({ error: "Faltan session_token o question_id." }, 400);
}
// El token es un uuid en la base -- si no tiene ese formato, la query de
// abajo tira un error de Postgres ("invalid input syntax for type uuid")
// en vez de simplemente no encontrar nada. Lo cortamos aca como 401
// generico (sesion invalida), igual que si no existiera.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!UUID_RE.test(sessionToken)) {
return json({ error: "Sesion invalida o expirada. Volve a ingresar tu codigo de acceso." }, 401);
}

const supabase = createClient(
Deno.env.get("SUPABASE_URL"),
Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
);

// 1. Validar la sesion (emitida por login) y que no haya expirado.
const { data: session, error: sessionError } = await supabase
.from("attempt_sessions")
.select("attempt_id, expires_at")
.eq("token", sessionToken)
.maybeSingle();

if (sessionError) {
console.error("submit-response: error buscando session", sessionError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}
if (!session || new Date(session.expires_at).getTime() < Date.now()) {
return json({ error: "Sesion invalida o expirada. Volve a ingresar tu codigo de acceso." }, 401);
}
const attemptId = session.attempt_id;

// 2. Buscar la pregunta (con la respuesta correcta, invisible para el navegador).
const { data: question, error: questionError } = await supabase
.from("question_bank")
.select("id, module, cefr_level, correct_answer, answer_format, accepted_answers")
.eq("id", questionId)
.maybeSingle();

if (questionError) {
console.error("submit-response: error buscando question", questionError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}
if (!question) {
return json({ error: "Pregunta no encontrada." }, 404);
}

const isCorrect = gradeAnswer(question, selectedAnswer);

// 3. Guardar la respuesta (upsert: si el estudiante vuelve atras y cambia la
// respuesta, se actualiza en vez de duplicar -- unique(attempt_id, question_id)).
const { error: upsertError } = await supabase
.from("student_responses")
.upsert(
{
attempt_id: attemptId,
question_id: question.id,
selected_answer: selectedAnswer,
is_correct: isCorrect,
},
{ onConflict: "attempt_id,question_id" },
);

if (upsertError) {
console.error("submit-response: error guardando respuesta", upsertError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

// 4. Ver si con esta respuesta se completo el modulo entero para este attempt.
const { count: totalInModule, error: totalError } = await supabase
.from("question_bank")
.select("id", { count: "exact", head: true })
.eq("module", question.module);

if (totalError) {
console.error("submit-response: error contando preguntas del modulo", totalError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

const { data: moduleQuestions, error: moduleQuestionsError } = await supabase
.from("question_bank")
.select("id, cefr_level")
.eq("module", question.module);

if (moduleQuestionsError) {
console.error("submit-response: error listando preguntas del modulo", moduleQuestionsError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

const moduleQuestionIds = moduleQuestions.map((q) => q.id);

const { data: responses, error: responsesError } = await supabase
.from("student_responses")
.select("question_id, is_correct")
.eq("attempt_id", attemptId)
.in("question_id", moduleQuestionIds);

if (responsesError) {
console.error("submit-response: error listando respuestas del modulo", responsesError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

const moduleComplete = responses.length >= (totalInModule ?? moduleQuestionIds.length);

if (!moduleComplete) {
return json({ ok: true, module_complete: false });
}

// 5. Modulo completo: calcular el resultado. STEP CK 2 (module === 'steps2') es
// pass/fail simple sobre el total de preguntas -- sus filas en question_bank tienen
// cefr_level = null, asi que computeCeiling() siempre devolveria null para este
// modulo y no serviria. El resto de los modulos (grammar/listening/reading) siguen
// el ceiling CEFR de siempre (mismo algoritmo que js/scoring.js).
const totalCorrect = responses.filter((r) => r.is_correct === true).length;
const skill = MODULE_TO_SKILL[question.module];

if (skill && question.module === "steps2") {
const totalQuestions = moduleQuestionIds.length;
const percent = totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0;
const passed = percent >= STEPS2_PASS_THRESHOLD;

const { error: subScoreError } = await supabase
.from("sub_scores")
.upsert(
{
attempt_id: attemptId,
skill,
raw_score: totalCorrect,
max_score: totalQuestions,
cefr_estimate: null,
computed_at: new Date().toISOString(),
band_detail: {
type: "pass_fail",
correct: totalCorrect,
total: totalQuestions,
percent,
threshold: STEPS2_PASS_THRESHOLD,
passed,
},
},
{ onConflict: "attempt_id,skill" },
);

if (subScoreError) {
console.error("submit-response: error guardando sub_score de steps2", subScoreError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}
// No se llama a recomputeRouteAndPersist aca -- la ruta del Nivel 1 no depende de
// steps2_reading (ver comentario v10 arriba). get-unlock-state usa la presencia de
// este sub_score para saber que STEP CK 2 ya se rindio y mandar a speaking.html.
// STEP CK 2 es el ultimo modulo de la ruta STEPS2 -- si ya esta, el recorrido
// completo termino (v12, pedido de Diana 10/08/2026, ver checkAndMarkAttemptComplete
// mas arriba).
await checkAndMarkAttemptComplete(supabase, attemptId);
} else if (skill && (question.module === "oet_listening" || question.module === "oet_reading")) {
const totalQuestions = moduleQuestionIds.length;
const percent = totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0;

const { error: subScoreError } = await supabase
.from("sub_scores")
.upsert(
{
attempt_id: attemptId,
skill,
raw_score: totalCorrect,
max_score: totalQuestions,
cefr_estimate: null,
computed_at: new Date().toISOString(),
band_detail: {
type: "informational",
correct: totalCorrect,
total: totalQuestions,
percent,
},
},
{ onConflict: "attempt_id,skill" },
);

if (subScoreError) {
console.error(`submit-response: error guardando sub_score de ${question.module}`, subScoreError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}
// No se llama a recomputeRouteAndPersist aca -- la ruta del Nivel 1 ya quedo fija
// antes de llegar al modulo OET; este sub_score solo le sirve a get-unlock-state
// para saber que esta parte de OET ya se rindio y encadenar a la siguiente pantalla.
} else if (skill) {
const correctByQuestion = new Map(responses.map((r) => [r.question_id, r.is_correct === true]));
const perBand = {};
for (const level of CEFR_ORDER) {
const idsInBand = moduleQuestions.filter((q) => q.cefr_level === level).map((q) => q.id);
const correct = idsInBand.filter((id) => correctByQuestion.get(id)).length;
const total = idsInBand.length;
const percent = total > 0 ? Math.round((correct / total) * 100) : 0;
perBand[level] = { correct, total, percent };
}
const ceilingLevel = computeCeiling(perBand);
const patternInconsistent = detectPatternInconsistency(perBand, ceilingLevel);

// v21 (31/08/2026, pedido de Diana, caso de Luis Padilla): reemplaza el rescate que
// antes existia solo para listening (LISTENING_B2_RESCUE_THRESHOLD = 75% especifico
// en B2) -- ver highestPassingBand() arriba. Se aplica ahora a grammar/listening/
// reading por igual: si el nivel mas alto realmente aprobado (highestPassingBand)
// queda por encima del ceiling bottom-up, se guarda ese nivel como
// oet_effective_level (lo usa recomputeRouteAndPersist para decidir OET/STEPS2) y se
// deja una nota para el reporte.
// v22 (09/09/2026, pedido de Diana): el nivel MOSTRADO (cefr_estimate) ahora es
// displayedLevel (= oetEffectiveLevel cuando hubo override, si no es el mismo
// ceilingLevel de siempre) -- ver comentario largo de v22 al inicio del archivo. El
// ceiling bottom-up viejo se guarda aparte, en band_detail.ceiling_level, solo para
// auditoria de Diana -- ya no es el nivel mostrado. La nota se reescribe para
// reflejar que el nivel alto SI se muestra, explicando la inconsistencia sin
// penalizar al estudiante por el traspie puntual.
const oetEffectiveLevel = highestPassingBand(perBand);
const oetUnlockOverride =
!!oetEffectiveLevel && !!ceilingLevel && CEFR_ORDER.indexOf(oetEffectiveLevel) > CEFR_ORDER.indexOf(ceilingLevel);
const displayedLevel = oetEffectiveLevel || ceilingLevel;
const oetUnlockNote = oetUnlockOverride
? `Tu nivel en ${SKILL_LABELS_ES[skill] || skill} quedó en ${oetEffectiveLevel}: hubo un traspié puntual en una banda intermedia (no llegaste al 70% ahí), pero se reconoce el nivel más alto que sí alcanzaste con al menos 70% de aciertos.`
: null;

const { error: subScoreError } = await supabase
.from("sub_scores")
.upsert(
{
attempt_id: attemptId,
skill,
raw_score: totalCorrect,
max_score: moduleQuestionIds.length,
cefr_estimate: displayedLevel,
computed_at: new Date().toISOString(),
// pattern_inconsistent es solo diagnostico -- nunca cambia displayedLevel.
// ceiling_level es el ceiling bottom-up viejo, solo para auditoria de Diana.
// oet_effective_level SI se usa en recomputeRouteAndPersist (mas abajo) para
// decidir OET/STEPS2 -- ver highestPassingBand() y detectPatternInconsistency().
band_detail: {
perBand,
ceiling_level: ceilingLevel,
pattern_inconsistent: patternInconsistent,
oet_effective_level: oetEffectiveLevel,
oet_unlock_override: oetUnlockOverride,
oet_unlock_note: oetUnlockNote,
},
},
{ onConflict: "attempt_id,skill" },
);

if (subScoreError) {
console.error("submit-response: error guardando sub_score", subScoreError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

// 6. Recalcular la ruta del Nivel 1 con todos los sub_scores disponibles hasta ahora.
const routeResult = await recomputeRouteAndPersist(supabase, attemptId);
if (routeResult && routeResult.error) {
return json({ error: routeResult.error }, 500);
}
}

// Sin feedback de puntaje ni de nivel -- el estudiante solo sabe que este modulo termino.
return json({ ok: true, module_complete: true });
});

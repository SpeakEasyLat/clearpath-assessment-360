// Edge Function: submit-writing
//
// Califica con IA una tarea de writing anclando el juicio a los descriptores del CEFR.
// NUNCA le devuelve al estudiante puntaje ni nivel en vivo.
//
// v20 (31/08/2026, pedido de Diana, caso de Luis Padilla): recomputeRouteAndPersist ya
// no exige que las 4 destrezas den B2+ para abrir OET -- alcanza con que 3 de las 4 lo
// hagan (usando el nivel "efectivo" por destreza, band_detail.oet_effective_level,
// calculado en submit-response.ts con highestPassingBand -- reemplaza el rescate viejo
// que solo aplicaba a listening), siempre que la restante no sea inferior a B1. Ver el
// comentario largo en recomputeRouteAndPersist mas abajo y en submit-response.ts
// (DUPLICADO, mantener sincronizados).
//
// v19 (22/08/2026, pedido de Diana): sube el tope de "correcciones_para_b2" de 5 a 7
// items (y de 2 a 3 en modo compacto) -- Diana identifico mas errores aprovechables en
// textos reales de prueba de los que el tope anterior dejaba mostrar.
//
// v18 (22/08/2026, pedido de Diana): agrega "correcciones_para_b2" al JSON que devuelve
// la IA -- una lista corta (hasta 7) de errores de gramatica/estructura concretos,
// tomados del propio texto del estudiante, con su correccion y una explicacion breve de
// la regla o estructura que hay que dominar para llegar a B2 (el nivel minimo para
// desbloquear OET). Se guarda dentro de ai_rubric_scores, igual que el resto del
// feedback -- NO se le muestra al estudiante en vivo, es para que Diana lo use en el
// reporte final. Si el texto ya califica en B2 o mas, la lista puede venir vacia (no hay
// nada que corregir para ese umbral). Igual que "dimensions"/"overall_comment", todo el
// texto de la IA en este campo va en espanol -- las citas del propio texto del
// estudiante (el "error" tal cual lo escribio) se copian en ingles, sin traducir.
//
// v17 (21/08/2026, pedido de Diana): TODO el feedback/analisis que escribe la IA sobre
// el texto del estudiante -- "overall_comment" (el unico campo que llega al estudiante,
// via generate-report / writingCommentFromRubric), y tambien "dimensions" (las 6
// oraciones) y "cefr_justification" (uso interno de Diana en Supabase) -- ahora se pide
// explicitamente en ESPANOL (tuteo, nunca voseo). Antes todo el prompt de calificacion
// estaba en ingles y la IA respondia en ingles en todos esos campos.
// LO UNICO que sigue en ingles es el contenido propio del assessment: las citas
// textuales del propio texto del estudiante (evidence.errors_found,
// complex_structures_controlled, cohesive_devices_used) -- nunca se traduce una cita, se
// copia tal cual la escribio -- y los codigos estructurales (A1-C1, true/false,
// "B1/B2"), que no son prosa. rubric_version pasa a "cefr-anchored-v6-spanish-feedback"
// para poder distinguir, si hace falta revisar algo viejo, las evaluaciones de antes de
// este cambio (feedback en ingles) de las nuevas.
//
// v16 (14/08/2026): recomputeRouteAndPersist ahora lee attempts.track y fuerza la ruta
// ENGLISH para NIVEL1_ONLY sin evaluar los niveles CEFR -- bug real encontrado antes de
// que ningun estudiante lo pisara (ver comentario en la funcion). DUPLICADO en
// submit-response, mantener sincronizados.
//
// v15 (06/08/2026): agrega OET Writing (Fase 4, module === 'oet_writing' en
// writing_prompts). BUG REAL encontrado y corregido: sub_scores.skill se escribia
// SIEMPRE como el literal "writing", sin importar que modulo se acababa de completar.
// Si se agregaba oet_writing sin arreglar esto, terminar OET Writing pisaba (mismo
// onConflict attempt_id,skill) el sub_score de Writing de Nivel 1. Ahora hay un mapa
// MODULE_TO_SKILL (nivel1_writing -> "writing", oet_writing -> "oet_writing"). Ademas,
// recomputeRouteAndPersist ahora SOLO se llama cuando el modulo es nivel1_writing -- la
// ruta del Nivel 1 (OET/STEPS2/ENGLISH) ya quedo fija para cuando el estudiante llega a
// OET Writing, e igual que steps2/oet_listening/oet_reading en submit-response, este
// sub_score es diagnostico y solo le sirve a get-unlock-state para encadenar pantallas.
//
// v14 (05/08/2026): decision de Diana -- el word count sugerido en la consigna
// ("Write between X and Y words") NO es un criterio de calificacion. Si el estudiante
// escribe menos de lo pedido, eso no se penaliza como tal: se califica el nivel de
// idioma de lo que efectivamente escribio, usando el mismo framework de siempre.
// Se agrego una seccion explicita al prompt de la IA para que quede a prueba de
// interpretacion (antes no estaba prohibido, pero tampoco estaba dicho -- y el
// prompt_text de la consigna sí menciona el rango de palabras, asi que la IA lo tenia
// disponible como para, sin querer, tratarlo como un requisito a cumplir).
//
// v13 (05/08/2026): FIX de un bug real encontrado en la prueba end-to-end -- un
// sub_score puede existir con cefr_estimate = null (el estudiante no supero ni la
// banda A1; un resultado legitimo, no "todavia no lo rindio"). v12 confundia esto con
// "modulo no completado" y assignedRoute se quedaba en null para siempre. Ahora
// nivel1Complete se determina por la PRESENCIA de la fila en sub_scores, no por si
// cefr_estimate es truthy.
//
// v12 (05/08/2026, tarea 1.3): la decision de ruta al final de esta funcion ya no es
// binaria (oetUnlocked ? 'OET' : 'English'). Ahora recalcula las TRES ramas del Nivel 1
// (OET / STEPS2 / ENGLISH) segun claude/flujo-objetivo.md, usando los CUATRO sub_scores
// (grammar, listening, writing, reading) -- la ruta solo se asigna cuando existen los
// cuatro; mientras falte alguno queda en null ("pendiente").
//
// OJO: la funcion recomputeRouteAndPersist de aca abajo esta DUPLICADA en
// submit-response (con el mismo nombre y cuerpo) porque cualquiera de las dos puede ser
// la que complete el cuarto sub_score, segun el orden en que el estudiante termine los
// modulos. Cualquier cambio a la regla debe aplicarse en los dos lugares, y tambien en
// js/scoring.js (decideUnlocks), que es el espejo de referencia del lado del cliente.
//
// v10 (26 de julio de 2026): decision de Diana -- LA DUDA FAVORECE AL ESTUDIANTE.
//   - Si la evidencia de un texto queda genuinamente repartida entre dos niveles
//     contiguos, se asigna el ALTO. El caso queda marcado en evidence.borderline_decision
//     para que Diana pueda revisar a mano esos textos sin frenar al estudiante.
//   - El promedio de las dos tareas del modulo tambien resuelve HACIA ARRIBA: una tarea
//     B1 y otra B2 dan B2, y el estudiante entra al modulo OET. Antes daba B1.
//   Razon de negocio: es preferible que alguien entre al OET y el propio modulo lo
//   filtre, a que alguien listo se quede afuera por un punto de criterio.
//
// v9: modo compacto ante corte por longitud + registro de consumo de tokens.
// v8: fallos guardados en la base + normalizacion del nivel CEFR devuelto.
// v7: regla B1/B2 corregida (la influencia de L1 solo baja el nivel si es generalizada).
// v6: descriptores textuales del CEFR y evidencia citada.
//
// La API key de IA vive SOLO en un secret de Supabase (ANTHROPIC_API_KEY).

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

const CEFR_ORDER = ["A1", "A2", "B1", "B2", "C1"];
const MIN_LEVEL_FOR_OET = "B2";
const MIN_LEVEL_FOR_STEPS2 = "B2";
// v20 (31/08/2026): minimo absoluto para la destreza "floja" cuando se abre OET por la
// regla de 3-de-4 -- ver recomputeRouteAndPersist mas abajo. DUPLICADO en
// submit-response.ts, mantener sincronizado.
const MIN_LEVEL_FLOOR_FOR_OET = "B1";
const PLACEMENT_MAX = 10;
const MAX_OUTPUT_TOKENS = 4096;

// module (writing_prompts) -> skill (sub_scores). Ver nota v15 arriba -- antes de esto
// el skill quedaba hardcodeado a "writing" sin importar el modulo.
const MODULE_TO_SKILL = {
  nivel1_writing: "writing",
  oet_writing: "oet_writing",
};

// v21 (01/09/2026, pedido de Diana -- reportó que OET Writing no se calificaba contra
// los criterios reales de OET): antes oet_writing pasaba por el MISMO framework
// CEFR-anchored de arriba, pensado para un ensayo general de Nivel 1 -- nunca se
// evaluaba contra Purpose/Content/Conciseness & Clarity/Genre & Style/
// Organisation & Layout/Language, los 6 criterios oficiales de OET Writing (fuente:
// "Writing sub-test: Assessment criteria and level descriptors", documento oficial de
// OET que Diana compartió el 01/09/2026). Desde esta versión, oet_writing usa su
// propio prompt de calificación (buildOetWritingGradingPrompt/parseOetWritingGrading
// más abajo) anclado a esos 6 criterios y sus descriptores oficiales por banda, y el
// grade final (A/B/C+/C/D/E) + puntaje 0-500 se calculan en el SERVIDOR a partir de
// los 6 puntajes -- igual criterio que ya usa submit-speaking-score.ts para OET
// Speaking (nunca se confía en un grade que devuelva la IA).
//
// Purpose se puntúa 0-3; los otros 5 criterios se puntúan 0-7 cada uno (máximo total
// 38 por tarea) -- así lo define la grilla oficial de OET (las bandas pares, ej. banda
// 6, son "comparte features de las bandas 5 y 7").
const OET_WRITING_CRITERIA = [
  { key: "purpose", max: 3 },
  { key: "content", max: 7 },
  { key: "conciseness_clarity", max: 7 },
  { key: "genre_style", max: 7 },
  { key: "organisation_layout", max: 7 },
  { key: "language", max: 7 },
];
const OET_WRITING_MAX_TOTAL = OET_WRITING_CRITERIA.reduce((sum, c) => sum + c.max, 0); // 38

// Mismos umbrales que ya usa generate-report.ts (oetRangeFromPercent) y
// submit-speaking-score.ts (gradeFromScaledScore) para el resto de la escala OET
// 0-500 (vigente desde sept. 2018, verificada contra geniusclass.co.uk/oet-calculator)
// -- mantener sincronizado si cambia en cualquiera de los tres lugares.
function oetWritingScaledScore500(rawScore, maxScore) {
  return Math.round((rawScore / maxScore) * 100 * 5);
}
function oetWritingGradeFromScaled(scaled) {
  if (scaled >= 450) return "A";
  if (scaled >= 350) return "B";
  if (scaled >= 300) return "C+";
  if (scaled >= 200) return "C";
  if (scaled >= 100) return "D";
  return "E";
}

// sub_scores.cefr_estimate debe seguir teniendo un string no vacío para que
// moduleComplete (más abajo) considere terminada la tarea y deje avanzar el intento
// -- pero OET Writing ya NO se califica contra el framework CEFR, así que este valor
// es puramente un placeholder TÉCNICO para no romper ese gate. Nunca se muestra al
// estudiante ni a Diana: lo que se usa en todos lados (reporte, panel) es
// ai_rubric_scores.overall_grade / overall_score_500, calculados arriba a partir de
// los 6 criterios oficiales.
function oetWritingPlaceholderCefr(percent) {
  if (percent >= 80) return "C1";
  if (percent >= 60) return "B2";
  if (percent >= 40) return "B1";
  if (percent >= 20) return "A2";
  return "A1";
}

function meetsLevel(level, minLevel) {
  if (!level) return false;
  const idx = CEFR_ORDER.indexOf(level);
  const minIdx = CEFR_ORDER.indexOf(minLevel);
  return idx >= 0 && minIdx >= 0 && idx >= minIdx;
}

// Promedia los niveles CEFR de las tareas del modulo.
// Decision de Diana (26/07/2026): el empate resuelve HACIA ARRIBA. Una tarea B1 y otra
// B2 dan B2. Math.round lleva el .5 al nivel superior.
function averageCefr(levels) {
  const idxs = levels.map((l) => CEFR_ORDER.indexOf(l)).filter((i) => i >= 0);
  if (idxs.length === 0) return null;
  const mean = idxs.reduce((a, b) => a + b, 0) / idxs.length;
  const rounded = Math.max(0, Math.min(CEFR_ORDER.length - 1, Math.round(mean)));
  return CEFR_ORDER[rounded];
}

function normalizeCefr(raw) {
  const text = typeof raw === "string" ? raw.toUpperCase() : "";
  const match = text.match(/\b(A1|A2|B1|B2|C1|C2)\b/);
  if (!match) return null;
  return match[1] === "C2" ? "C1" : match[1];
}

// v21 (01/09/2026): prompt de calificación de OET Writing, anclado a los 6 criterios
// oficiales (Purpose, Content, Conciseness & Clarity, Genre & Style,
// Organisation & Layout, Language) y sus descriptores por banda, reproducidos tal cual
// del documento oficial de OET ("Writing sub-test: Assessment criteria and level
// descriptors") -- son la autoridad, igual criterio que los descriptores CEFR
// reproducidos en buildGradingPrompt para Nivel 1. Completamente separado del
// framework CEFR-anchored: OET Writing evalúa una carta profesional real (referral,
// discharge, etc.) a partir de case notes, no un ensayo general.
function buildOetWritingGradingPrompt(promptRow, responseText, compact) {
  const compactBlock = compact
    ? `
=== COMPACT MODE - THE PREVIOUS ANSWER WAS CUT OFF FOR BEING TOO LONG ===

Apply exactly the same criteria and reach exactly the same scores, but make the
WRITTEN OUTPUT much shorter so it fits:
- Each "dimensions" sentence: at most 12 words (still in Spanish).
- "overall_comment": one sentence, at most 25 words (still in Spanish).
- Each quotation: at most 8 words.
- "correcciones_para_b2": at most 3 items instead of 7, each field still as short as
  possible (still in Spanish, quotations still verbatim in English).
Do not change any of the six scores to make the output shorter.
`
    : "";

  return `You are a certified OET (Occupational English Test) Writing examiner. You are
grading a real OET Writing sub-test task: a healthcare professional was given case
notes and asked to write a letter (referral, discharge, transfer, update, etc.) to
another reader (a colleague, a specialist, a patient, a carer). This is NOT a general
English essay -- grade it ONLY against OET's own official Writing assessment criteria
and level descriptors, reproduced in full below. They are the authority; a general
impression of "good writing" that is not grounded in these specific criteria and their
band descriptors is not acceptable.
${compactBlock}
=== THE SIX OFFICIAL OET WRITING CRITERIA ===

You must score six criteria. Purpose is scored 0 to 3. The other five are each scored
0 to 7. For the five 0-7 criteria, even bands (2, 4, 6) are not separately described --
the official grid defines them as "shares features of bands X and Y" (the two odd
bands immediately below and above), so use them when the letter is genuinely a blend
of the two neighbouring band descriptors.

--- 1. PURPOSE (0-3) ---
Purpose has two parts: making the reason for the letter "immediately apparent" (clear
from the very start, so the reader does not have to search for it) and "sufficiently
expanding" that reason with more detail (usually towards the end of the letter, with
specifics the reader needs to continue care).

Band 3: Purpose of document is immediately apparent and sufficiently expanded as required.
Band 2: Purpose of document is apparent but not sufficiently highlighted or expanded.
Band 1: Purpose of document is not immediately apparent and may show very limited expansion.
Band 0: Purpose of document is partially obscured/unclear and/or misunderstood.

--- 2. CONTENT (0-7) ---
Considers whether all key information the reader needs is included, whether the case
notes are represented accurately (no altered meaning, no wrong tense/timeframe -- e.g.
turning something that already happened into "will be" is an accuracy error here even
if the sentence is grammatically correct), and whether the content is appropriate to
what THIS specific reader needs to know to continue the patient's care.

Band 7: Content is appropriate to intended reader and addresses what is needed to continue care (key information is included; no important details missing); content from case notes is accurately represented.
Band 6: Performance shares features of bands 5 and 7.
Band 5: Content is appropriate to intended reader and mostly addresses what is needed to continue care; content from case notes is generally accurately represented.
Band 4: Performance shares features of bands 3 and 5.
Band 3: Content is mostly appropriate to intended reader; some key information (about case or to continue care) may be missing; there may be some inaccuracies in content.
Band 2: Performance shares features of bands 1 and 3.
Band 1: Content does not provide intended reader sufficient information about the case and what is needed to continue care; key information is missing or inaccurate.
Band 0: Performance below Band 1.

--- 3. CONCISENESS & CLARITY (0-7) ---
Considers whether irrelevant information from the case notes was correctly left out
(does THIS reader need it, or is it outside their role / already known / too much
historical detail?), and how effectively and clearly the relevant case notes were
summarised and grouped for the reader.

Band 7: Length of document is appropriate to case and reader (no irrelevant information included); information is summarised effectively and presented clearly.
Band 6: Performance shares features of bands 5 and 7.
Band 5: Length of document is mostly appropriate to case and reader, information is mostly summarized effectively and presented clearly.
Band 4: Performance shares features of bands 3 and 5.
Band 3: Inclusion of some irrelevant information distracts from overall clarity of document; attempt to summarise only partially successful.
Band 2: Performance shares features of bands 1 and 3.
Band 1: Clarity of document is obscured by the inclusion of many unnecessary details; attempt to summarise not successful.
Band 0: Performance below Band 1.

--- 4. GENRE & STYLE (0-7) ---
Considers whether the writing is clinical/factual (fact-based, e.g. "Mr X smokes 30
cigarettes a day" rather than judgemental, e.g. "Mr X is a heavy smoker"), formal
(no contractions like "he's"/"didn't"), and whether register, tone, technical
language and abbreviations are appropriate to this genre (a formal letter) and to
THIS specific reader's discipline and prior knowledge of the case.

Band 7: Writing is clinical/factual and appropriate to genre and reader (discipline and knowledge); technical language, abbreviations and polite language are used appropriately for document and recipient.
Band 6: Performance shares features of bands 5 and 7.
Band 5: Writing is clinical/factual and appropriate to genre and reader with occasional, minor inappropriacies; technical language, abbreviations and polite language are used appropriately with minor inconsistencies.
Band 4: Performance shares features of bands 3 and 5.
Band 3: Writing is at times inappropriate to the document or target reader; over-reliance on technical language and abbreviations may distract reader.
Band 2: Performance shares features of bands 1 and 3.
Band 1: The writing shows inadequate understanding of the genre and target reader; mis- or over-use of technical language and abbreviations cause strain for the reader.
Band 0: Performance below Band 1.

--- 5. ORGANISATION & LAYOUT (0-7) ---
Considers whether paragraphing is logical (organised chronologically or thematically,
whichever suits the case), whether sub-sections are well organised, whether key
information is clearly highlighted so it is not missed, and whether the overall
layout (greeting, opening that states purpose, body, closing) is appropriate to a
formal letter.

Band 7: Organisation and paragraphing are appropriate, logical and clear; key information is highlighted and sub-sections are well organised; document is well laid out.
Band 6: Performance shares features of bands 5 and 7.
Band 5: Organisation and paragraphing are generally appropriate, logical and clear; occasional lapses of organisation in sub-sections and/or highlighting of key information; layout is generally good.
Band 4: Performance shares features of bands 3 and 5.
Band 3: Organisation and paragraphing are not always logical, creating strain for the reader; key information may not be highlighted; layout is mostly appropriate with some lapses.
Band 2: Performance shares features of bands 1 and 3.
Band 1: Organisation not logical, putting strain on the reader; or heavy reliance on case note structure; key information is not well highlighted and the layout may not be appropriate.
Band 0: Performance below Band 1.

--- 6. LANGUAGE (0-7) ---
Grammar, vocabulary, spelling, punctuation and sentence structure -- judged only by
whether they help or hinder THIS reader's understanding and reading speed, not in the
abstract.

Band 7: Language features (spelling/punctuation/vocabulary/grammar/sentence structure) are accurate and do not interfere with meaning.
Band 6: Performance shares features of bands 5 and 7.
Band 5: Minor slips in language generally do not interfere with meaning.
Band 4: Performance shares features of bands 3 and 5.
Band 3: Inaccuracies in language, in particular in complex structures, cause minor strain for the reader but do not interfere with meaning.
Band 2: Performance shares features of bands 1 and 3.
Band 1: Inaccuracies in language cause considerable strain for the reader and may interfere with meaning.
Band 0: Performance below Band 1.

=== WORD COUNT IS NOT ITSELF A SCORING CRITERION ===

The task below may suggest a word count. This is guidance for the student, not
something you grade directly. Do not penalise brevity by itself -- grade the language
and content quality of what was actually written. If something the reader genuinely
needed is missing because too little was written, that is a Content or
Conciseness & Clarity issue, not a word-count issue.

=== SCORE EACH CRITERION INDEPENDENTLY ===

A letter can be very accurate in Language but still score poorly in Content if it
selected the wrong information from the case notes, or vice versa. Do not let your
impression of one criterion bleed into another.

=== THE CASE NOTES AND WRITING TASK GIVEN TO THE STUDENT ===
"""
${promptRow.prompt_text}
"""

=== OUTPUT ===

Respond with ONLY a valid JSON object, no markdown, no commentary, in exactly this
shape. IMPORTANT -- LANGUAGE: every field that is YOUR OWN written analysis or
feedback ("dimensions" -- all six sentences --, "overall_comment", and
"correcciones_para_b2[].correccion" / "correcciones_para_b2[].explicacion") must be
written IN SPANISH -- Latin American Spanish, informal "tú", never "vos". The ONLY
exception is the literal quotation you copy from the student's own letter
("correcciones_para_b2[].error") -- copy it exactly as written, in English, never
translate or paraphrase a quotation. The score integers are not prose and are not
affected by this.
{
  "scores": {
    "purpose": <integer 0-3>,
    "content": <integer 0-7>,
    "conciseness_clarity": <integer 0-7>,
    "genre_style": <integer 0-7>,
    "organisation_layout": <integer 0-7>,
    "language": <integer 0-7>
  },
  "dimensions": {
    "purpose": "<1-2 sentences in Spanish, justify the Purpose score with evidence from the letter>",
    "content": "<1-2 sentences in Spanish>",
    "conciseness_clarity": "<1-2 sentences in Spanish>",
    "genre_style": "<1-2 sentences in Spanish>",
    "organisation_layout": "<1-2 sentences in Spanish>",
    "language": "<1-2 sentences in Spanish>"
  },
  "overall_comment": "<two or three sentences in Spanish summarising the overall performance across the six criteria>",
  "correcciones_para_b2": [
    {
      "error": "<exact short quotation from the student's letter, verbatim in English>",
      "correccion": "<the corrected version of that same fragment, in English>",
      "explicacion": "<short explanation, in Spanish, of the rule/convention involved and which OET criterion it affects>"
    }
  ]
}

Include up to 7 items in "correcciones_para_b2" (fewer if the letter does not have
that many distinct concrete issues) -- concrete, actionable language/register/format
fixes grounded in fragments the student actually wrote, the kind of thing that would
raise their Language, Genre & Style, or Organisation & Layout score. If the letter is
already strong with only occasional minor slips, return fewer items or an empty list
-- do not invent problems that are not really there.

Student's letter:
"""
${responseText}
"""`;
}

function buildGradingPrompt(promptRow, responseText, compact) {
  if (promptRow.module === "oet_writing") {
    return buildOetWritingGradingPrompt(promptRow, responseText, compact);
  }
  const compactBlock = compact
    ? `
=== COMPACT MODE - THE PREVIOUS ANSWER WAS CUT OFF FOR BEING TOO LONG ===

Apply exactly the same rules and reach exactly the same judgement, but make the WRITTEN
OUTPUT much shorter so it fits:
- Each "dimensions" sentence: at most 12 words (still in Spanish).
- "overall_comment": one sentence, at most 25 words (still in Spanish).
- "cefr_justification": one sentence, at most 30 words (still in Spanish).
- Each quotation: at most 8 words.
- Each list: at most 3 items.
- "correcciones_para_b2": at most 3 items instead of 7, each field still as short as
  possible (still in Spanish, quotations still verbatim in English).
Do not change the placement band or the CEFR level to make it shorter.
`
    : "";

  return `You are an expert examiner placing an adult English learner's writing on a level.
You must ground every judgement in the Common European Framework of Reference
(CEFR) descriptors reproduced below, and in evidence quoted from the student's own
text. Do not rely on general impression.
${compactBlock}
=== FRAMEWORK A - PLACEMENT BAND (integer 0 to 10) ===

Judge the writing holistically across these six qualities:
1. Topic development - how fully and with how little apparent effort the task is developed.
2. Clarity of purpose - how clear the writer's aim and the purpose of the text are.
3. Organization - how well organized the text is at sentence and paragraph level.
4. Language control - how much control the writer has to express ideas.
5. Accuracy - how frequent errors are in language use and writing conventions.
6. Range - how appropriate and wide the vocabulary and structures are.

Banding guide: 0-1 very weak; 2-3 low; 4-5 fair; 6-7 good; 8-9 very good;
10 excellent (topic fully developed and effortless, purpose perfectly clear, very
well organized, wide range of appropriate vocabulary and structures, almost no errors).

=== FRAMEWORK B - CEFR LEVEL ===

Assign exactly one of: A1, A2, B1, B2, C1. One level only, with no qualifier,
no slash, no plus sign and no parenthesis.
Use these official CEFR descriptors. They are the authority; your intuition is not.

--- RANGE ---
A1: "Has a very basic repertoire of words and simple phrases related to personal
    details and particular concrete situations."
A2: "Uses basic sentence patterns with memorised phrases, groups of a few words and
    formulae in order to communicate limited information in simple everyday situations."
B1: "Has enough language to get by, with sufficient vocabulary to express him/herself
    with some hesitation and circumlocutions on topics such as family, hobbies and
    interests, work, travel and current events."
B2: "Has a sufficient range of language to be able to give clear descriptions, express
    viewpoints on most general topics, without much conspicuous searching for words,
    using some complex sentence forms to do so."
C1: "Has a good command of a broad range of language allowing him/her to select a
    formulation to express him/herself clearly in an appropriate style on a wide range
    of general, academic, professional or leisure topics without having to restrict
    what he/she wants to say."

--- GRAMMATICAL ACCURACY ---
A1: "Shows only limited control of a few simple grammatical structures and sentence
    patterns in a learnt repertoire."
A2: "Uses some simple structures correctly, but still systematically makes basic
    mistakes - for example tends to mix up tenses and forget to mark agreement;
    nevertheless, it is usually clear what he/she is trying to say."
B1: "Communicates with reasonable accuracy in familiar contexts; generally good control
    though with noticeable mother tongue influence."
B2: "Good grammatical control. Occasional 'slips' or non-systematic errors and minor
    flaws in sentence structure may still occur."
C1: "Consistently maintains a high degree of grammatical accuracy; errors are rare and
    difficult to spot."

--- VOCABULARY CONTROL ---
A2: "Can control a narrow repertoire dealing with concrete everyday needs."
B1: "Shows good control of elementary vocabulary but major errors still occur when
    expressing more complex thoughts."
B2: "Lexical accuracy is generally high, though some confusion and incorrect word choice
    does occur without hindering communication."
C1: "Occasional minor slips, but no significant vocabulary errors."

--- COHERENCE AND COHESION ---
A1: "Can link words or groups of words with very basic linear connectors like 'and' or 'then'."
A2: "Can link groups of words with simple connectors like 'and', 'but' and 'because'."
B1: "Can link a series of shorter, discrete simple elements into a connected, linear
    sequence of points."
B2: "Can use a limited number of cohesive devices to link his/her utterances into clear,
    coherent discourse, though there may be some 'jumpiness' in a long contribution."
C1: "Can produce clear, smoothly flowing, well-structured text, showing controlled use of
    organisational patterns, connectors and cohesive devices."

--- OVERALL WRITTEN PRODUCTION ---
A1: "Can write simple isolated phrases and sentences."
A2: "Can write a series of simple phrases and sentences linked with simple connectors
    like 'and', 'but' and 'because'."
B1: "Can write straightforward connected texts on a range of familiar subjects within
    his/her field of interest, by linking a series of shorter discrete elements into a
    linear sequence."
B2: "Can write clear, detailed texts on a variety of subjects related to his/her field of
    interest, synthesising and evaluating information and arguments from a number of sources."
C1: "Can write clear, well-structured texts on complex subjects, underlining the relevant
    salient issues, expanding and supporting points of view at some length with subsidiary
    points, reasons and relevant examples, and rounding off with an appropriate conclusion."

=== THE B1 / B2 BOUNDARY - DECISION RULE ===

This boundary decides whether the student is admitted to the OET pathway, so apply it
strictly and mechanically - but do not over-penalise (see the warning below).

Award B2 IF ALL THREE of the following are true:
  (a) COMPLEX SENTENCE FORMS are present and controlled - for example relative clauses,
      passive voice, subordination with although / while / whereas, non-finite clauses,
      reported speech with correct backshift.
  (b) ERRORS ARE NON-SYSTEMATIC - occasional slips of different kinds, not one error type
      repeated across the text.
  (c) The text forms COHERENT DISCOURSE with cohesive devices, not merely a linear list of
      separate points.

Award B1 (not B2) if ANY of the following is true, even when the vocabulary looks advanced:
  (a) ERRORS ARE SYSTEMATIC - the same error type recurs across the text (for example the
      same wrong preposition pattern, the same missing agreement, the same calque used
      again and again).
  (b) MOTHER TONGUE INFLUENCE IS PERVASIVE - structures transferred from the first language
      recur and characterise the text as a whole (for example "explain me something",
      "depends of", "I would like that you come", "he has 30 years", "in the coast"
      appearing repeatedly across the text).
  (c) The text is LINEAR - one discrete point after another, with no hierarchy between ideas.
  (d) COMPLEX SENTENCE FORMS ARE ATTEMPTED BUT NOT CONTROLLED.

=== WHEN THE EVIDENCE IS GENUINELY SPLIT, GO UP ===

After applying the rule above, if the evidence is genuinely balanced between two adjacent
levels - some criteria point to the lower level and some to the higher one, and neither
side clearly wins - assign the HIGHER level. Doubt favours the student.

This is a deliberate decision by the programme owner and it overrides any instinct to be
cautious. Do NOT use it to inflate a text whose evidence clearly points to the lower level:
it applies ONLY when the evidence is truly split.

Whenever you use this rule, you MUST report it: set "borderline_decision" to true and name
the two levels in "borderline_between" (for example "B1/B2"). When the level is clear, set
"borderline_decision" to false and leave "borderline_between" as null.

=== WARNING - DO NOT OVER-PENALISE ===

The B2 descriptor states explicitly that "occasional 'slips' or non-systematic errors and
minor flaws in sentence structure MAY STILL OCCUR" at B2. Therefore:
- Two or three isolated errors in an otherwise controlled text - INCLUDING errors that happen
  to look like first-language transfer - are exactly what B2 means by occasional slips. They
  do NOT justify B1.
- A single missing word, a single wrong preposition, or a single singular/plural slip is a
  slip, not evidence of pervasive mother tongue influence.
- "Noticeable mother tongue influence" in the B1 descriptor means influence that characterises
  the whole text, not the presence of one or two L1-flavoured expressions.

=== WORD COUNT IS NOT A SCORING CRITERION ===

The task below may suggest a recommended word count (for example "write between 120 and
180 words"). This is guidance for the student, NOT something you grade. If the response is
shorter than the suggested range, that fact must NOT by itself lower the placement band or
the CEFR level. Grade only the language quality of what the student actually wrote, using
the six qualities and the CEFR descriptors above.

A short response naturally gives you less text to find evidence in for some qualities (for
example topic development or range of structures) -- if there genuinely is not enough text
to judge a quality with confidence, say so honestly in that dimension's sentence and in the
evidence fields, rather than assuming the missing length itself indicates a lower level. Do
not mention the word count, or the fact that it was not met, as a reason for the level in
"cefr_justification" or "overall_comment".

=== CONSISTENCY CHECK - apply before answering ===

If ALL THREE of these hold, the level MUST be B2 or higher:
  - errors_are_systematic is false, AND
  - at least one complex structure is present and controlled, AND
  - discourse_is_linear is false.
Your justification must never contradict your own evidence fields.

=== OBSERVABLE GRAMMAR INVENTORY ===

Structures within the B1 repertoire: present simple and continuous, past simple vs present
perfect, modals of obligation and deduction, first / second / third conditional, basic
passive, basic reported speech, gerund and infinitive, question tags, comparatives and
superlatives, clauses of contrast, purpose and reason, verb + preposition.

Structures that mark B2: defining and non-defining relative clauses, passive with two
objects and passive of reporting verbs, mixed conditionals and alternatives to "if", unreal
uses of past tenses (wish, if only, it's time), complex gerund and infinitive forms,
participle clauses, ellipsis and substitution, modified comparatives, discourse markers,
inversion after negative adverbials, cleft sentences.

Presence of a B2 structure is not sufficient on its own; it must be CONTROLLED, i.e. used
without error and appropriately for the context.

=== EVIDENCE REQUIREMENT ===

Every judgement must cite evidence from the student's text:
- For accuracy: quote the actual erroneous fragments, and state whether they are systematic
  (a repeated pattern) or occasional (isolated slips of different kinds).
- For range: quote the most complex structure the student actually controlled.
- For coherence: name the cohesive devices actually used.
Never invent a quotation. If a level's evidence is absent, say it is absent.
KEEP IT SHORT: each quotation must be at most 15 words, and each list at most 5 items.

=== CORRECTIONS TO REACH B2 (for the student's OET pathway) ===

Separately from the placement judgement above, produce a short, ACTIONABLE list (up to 7
items, fewer if the text does not have that many distinct issues) of the grammar and
sentence-structure points the student most needs to fix to reach a solid B2 -- B2 is the
minimum CEFR level required to unlock the OET pathway in this programme, so this list is
specifically aimed at that threshold, not at general perfection.

Rules for this list:
- Prioritise patterns that RECUR or that are the clearest markers of the B1/B2 boundary
  (see the B1/B2 boundary rule above) over one-off slips.
- Each item must be grounded in something the student ACTUALLY WROTE -- quote the exact
  fragment (verbatim, in English, never translated or invented).
- Each item must include the corrected version of that same fragment, and a short
  explanation, IN SPANISH, of the grammar/structure category involved (for example
  "cláusulas relativas", "voz pasiva", "concordancia verbal", "uso de preposiciones",
  "conectores de contraste", "condicionales") and why it matters for B2.
- If the text ALREADY meets B2 or higher with only occasional slips (per the warning
  above), you may return FEWER items, or an empty list -- do not invent problems that are
  not really there.
- Do not repeat here, verbatim, entire sentences already quoted in "evidence.errors_found"
  without adding the correction and explanation -- this list must always pair each quoted
  error with its fix and its explanation.

=== THE TASK THE STUDENT WAS GIVEN (title: "${promptRow.title}") ===
"""
${promptRow.prompt_text}
"""

=== OUTPUT ===

Respond with ONLY a valid JSON object, no markdown, no commentary, in exactly this shape.
IMPORTANT -- LANGUAGE: every field below that is YOUR OWN written analysis or feedback
("dimensions" -- all six sentences --, "cefr_justification", "overall_comment", and
"correcciones_para_b2[].correccion" / "correcciones_para_b2[].explicacion") must be
written IN SPANISH -- Latin American Spanish, informal "tú", never "vos". The ONLY
exception is the literal quotations you copy from the student's own text
("errors_found", "complex_structures_controlled", "cohesive_devices_used", and
"correcciones_para_b2[].error") -- those are the actual assessment content the student
wrote in English, so copy them EXACTLY as written, never translate or paraphrase a
quotation. Structural values (true/false, the CEFR level codes, "borderline_between") are
not prose and are not affected by this.
{
  "placement_band": <integer 0-10>,
  "dimensions": {
    "topic_development": "<one short sentence, in Spanish>",
    "clarity_of_purpose": "<one short sentence, in Spanish>",
    "organization": "<one short sentence, in Spanish>",
    "language_control": "<one short sentence, in Spanish>",
    "accuracy": "<one short sentence, in Spanish>",
    "range": "<one short sentence, in Spanish>"
  },
  "evidence": {
    "errors_found": ["<exact short quotation from the student's text, verbatim in English -- never translate a quotation>"],
    "errors_are_systematic": <true|false>,
    "mother_tongue_influence_is_pervasive": <true|false>,
    "complex_structures_controlled": ["<exact short quotation showing a controlled complex form, verbatim in English>"],
    "cohesive_devices_used": ["<device, verbatim in English>"],
    "discourse_is_linear": <true|false>,
    "borderline_decision": <true|false>,
    "borderline_between": "<for example B1/B2, or null when the level is clear>"
  },
  "cefr_justification": "<one or two sentences naming which CEFR descriptor the text matches and why -- IN SPANISH>",
  "overall_comment": "<two or three sentences summarizing the level -- IN SPANISH>",
  "cefr_estimate": "<A1|A2|B1|B2|C1>",
  "correcciones_para_b2": [
    {
      "error": "<exact short quotation from the student's text, verbatim in English>",
      "correccion": "<la version corregida de ese mismo fragmento, en espanol solo si hace falta explicar, pero el fragmento corregido en si va en ingles porque es el texto del estudiante>",
      "explicacion": "<explicacion breve, en espanol, de la regla o estructura gramatical involucrada y por que importa para llegar a B2>"
    }
  ]
}

The CEFR estimate must be consistent with the placement band, the six qualities, the
B1/B2 decision rule, the split-evidence rule, the over-penalisation warning and the
consistency check above.

Student's response:
"""
${responseText}
"""`;
}

async function gradeWithAI(promptRow, responseText, compact = false) {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error("Falta el secret ANTHROPIC_API_KEY en Supabase.");
  }
  const model = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-5-20250929";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      messages: [{ role: "user", content: buildGradingPrompt(promptRow, responseText, compact) }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    const e = new Error(`API de IA respondio ${res.status}`);
    e.rawExcerpt = errText.slice(0, 600);
    e.truncated = false;
    throw e;
  }

  const data = await res.json();
  const rawText = Array.isArray(data.content)
    ? data.content.map((c) => (typeof c.text === "string" ? c.text : "")).join("")
    : "";
  const stopReason = data.stop_reason || "";
  const usage = data.usage || {};
  const cutOff = stopReason === "max_tokens";

  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    const e = new Error(`Respuesta sin JSON completo (stop_reason: ${stopReason})`);
    e.rawExcerpt = rawText.slice(0, 600);
    e.truncated = true;
    throw e;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch (parseErr) {
    const e = new Error(`JSON invalido (stop_reason: ${stopReason}): ${parseErr.message}`);
    e.rawExcerpt = rawText.slice(0, 600);
    e.truncated = true;
    throw e;
  }

  // v21 (01/09/2026): oet_writing tiene su propio parser, anclado a los 6 criterios
  // oficiales de OET (ver parseOetWritingGrading mas abajo) -- nunca pasa por el
  // framework CEFR de aqui para abajo.
  if (promptRow.module === "oet_writing") {
    return parseOetWritingGrading(parsed, rawText, stopReason, cutOff, usage, model, compact);
  }

  const rawCefr = parsed.cefr_estimate;
  const cefrFromAi = normalizeCefr(rawCefr);
  if (!cefrFromAi) {
    const e = new Error(`cefr_estimate invalido: ${JSON.stringify(rawCefr)}`);
    e.rawExcerpt = rawText.slice(0, 600);
    e.truncated = cutOff;
    throw e;
  }

  // v9 (24/08/2026, bug real encontrado con el caso de Paula): el prompt le pide a la
  // IA que cuando marca evidence.borderline_decision = true, asigne el nivel ALTO de
  // los dos (regla "la duda favorece al estudiante", decision de Diana del 26/07/2026).
  // Pero nada en el CODIGO garantizaba que la IA aplicara esa regla ella sola -- y en
  // el caso de Paula, la IA marco borderline_decision:true, borderline_between:"B1/B2",
  // y aun asi devolvio cefr_estimate B1 en vez de B2, dejandola afuera de OET sin
  // motivo. Ahora se fuerza el nivel alto en el codigo mismo cuando hay borderline,
  // sin depender de que el modelo lo haga bien: no hace falta reintentar la IA para
  // corregir estos casos a futuro.
  //
  // v10 (24/08/2026, pedido de Diana): ademas de asignar el nivel alto, dejar
  // ANOTADO en el feedback (overall_comment, el unico campo que llega al reporte via
  // writingCommentFromRubric) que el resultado quedo entre dos niveles y que conviene
  // seguir trabajando para consolidar el nivel asignado -- para que quede visible sin
  // tener que abrir ai_rubric_scores en Supabase.
  let cefr = cefrFromAi;
  let borderlineOverrideApplied = false;
  let borderlineNote = null;
  const evidenceForBorderline = parsed.evidence || {};
  if (evidenceForBorderline.borderline_decision === true && typeof evidenceForBorderline.borderline_between === "string") {
    const uniqueLevels = [...new Set(evidenceForBorderline.borderline_between.match(/A1|A2|B1|B2|C1/g) || [])]
      .sort((a, b) => CEFR_ORDER.indexOf(a) - CEFR_ORDER.indexOf(b));
    let loLevel = null;
    let hiLevel = null;
    if (uniqueLevels.length >= 2) {
      loLevel = uniqueLevels[0];
      hiLevel = uniqueLevels[uniqueLevels.length - 1];
    } else if (uniqueLevels.length === 1) {
      // borderline_between vino mal formado (un solo nivel, ej. "B2" en vez de
      // "B1/B2") -- se asume que ese nivel es el de abajo y se sube un escalon.
      const idx = CEFR_ORDER.indexOf(uniqueLevels[0]);
      loLevel = uniqueLevels[0];
      hiLevel = idx >= 0 && idx < CEFR_ORDER.length - 1 ? CEFR_ORDER[idx + 1] : uniqueLevels[0];
    }
    if (hiLevel && CEFR_ORDER.indexOf(hiLevel) >= CEFR_ORDER.indexOf(cefrFromAi)) {
      if (CEFR_ORDER.indexOf(hiLevel) > CEFR_ORDER.indexOf(cefrFromAi)) {
        borderlineOverrideApplied = true;
      }
      cefr = hiLevel;
      borderlineNote = `Nota: este resultado quedó entre los niveles ${loLevel} y ${hiLevel} (caso límite) -- se asignó ${hiLevel}, pero conviene seguir reforzando para consolidar el ${hiLevel} por completo.`;
    }
  }

  let band = Number(parsed.placement_band);
  if (!Number.isFinite(band)) band = 0;
  band = Math.max(0, Math.min(PLACEMENT_MAX, Math.round(band)));

  const correccionesParaB2 = Array.isArray(parsed.correcciones_para_b2)
    ? parsed.correcciones_para_b2
        .filter((c) => c && typeof c === "object")
        .slice(0, 7)
        .map((c) => ({
          error: typeof c.error === "string" ? c.error : "",
          correccion: typeof c.correccion === "string" ? c.correccion : "",
          explicacion: typeof c.explicacion === "string" ? c.explicacion : "",
        }))
    : [];

  const overallCommentAi = typeof parsed.overall_comment === "string" ? parsed.overall_comment : "";
  const overallComment = borderlineNote ? `${overallCommentAi} ${borderlineNote}`.trim() : overallCommentAi;

  return {
    cefr_estimate: cefr,
    placement_band: band,
    ai_rubric_scores: {
      placement_band: band,
      placement_max: PLACEMENT_MAX,
      dimensions: parsed.dimensions || {},
      evidence: parsed.evidence || {},
      cefr_justification: typeof parsed.cefr_justification === "string" ? parsed.cefr_justification : "",
      overall_comment: overallComment,
      overall_comment_ai: overallCommentAi,
      borderline_note: borderlineNote,
      correcciones_para_b2: correccionesParaB2,
      cefr_estimate: cefr,
      cefr_estimate_ai: cefrFromAi,
      borderline_override_applied: borderlineOverrideApplied,
      cefr_estimate_raw: typeof rawCefr === "string" ? rawCefr : null,
      rubric_version: "cefr-anchored-v10-borderline-note",
      compact_mode: compact === true,
      stop_reason: stopReason,
      input_tokens: Number(usage.input_tokens) || null,
      output_tokens: Number(usage.output_tokens) || null,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      model,
      graded_at: new Date().toISOString(),
    },
  };
}

// v21 (01/09/2026): parser de la respuesta de la IA para oet_writing, anclado a los 6
// criterios oficiales de OET (ver OET_WRITING_CRITERIA arriba y
// buildOetWritingGradingPrompt). El grade final (A/B/C+/C/D/E) y el puntaje 0-500 se
// calculan ACA, en el servidor, a partir de los 6 puntajes que devuelve la IA -- nunca
// se confia en un grade/puntaje-final que la IA pudiera inventar (mismo criterio que
// submit-speaking-score.ts para OET Speaking).
function parseOetWritingGrading(parsed, rawText, stopReason, cutOff, usage, model, compact) {
  const rawScores = parsed.scores && typeof parsed.scores === "object" ? parsed.scores : {};
  const scores = {};
  let rawTotal = 0;
  for (const criterion of OET_WRITING_CRITERIA) {
    let v = Number(rawScores[criterion.key]);
    if (!Number.isFinite(v)) v = 0;
    v = Math.max(0, Math.min(criterion.max, Math.round(v)));
    scores[criterion.key] = v;
    rawTotal += v;
  }

  const scaled500 = oetWritingScaledScore500(rawTotal, OET_WRITING_MAX_TOTAL);
  const grade = oetWritingGradeFromScaled(scaled500);
  const percent = Math.round((rawTotal / OET_WRITING_MAX_TOTAL) * 100);

  const rawDimensions = parsed.dimensions && typeof parsed.dimensions === "object" ? parsed.dimensions : {};
  const dimensions = {};
  for (const criterion of OET_WRITING_CRITERIA) {
    dimensions[criterion.key] = typeof rawDimensions[criterion.key] === "string" ? rawDimensions[criterion.key] : "";
  }

  const correccionesParaB2 = Array.isArray(parsed.correcciones_para_b2)
    ? parsed.correcciones_para_b2
        .filter((c) => c && typeof c === "object")
        .slice(0, 7)
        .map((c) => ({
          error: typeof c.error === "string" ? c.error : "",
          correccion: typeof c.correccion === "string" ? c.correccion : "",
          explicacion: typeof c.explicacion === "string" ? c.explicacion : "",
        }))
    : [];

  const overallComment = typeof parsed.overall_comment === "string" ? parsed.overall_comment : "";

  return {
    // Placeholder tecnico, NUNCA mostrado -- ver comentario en oetWritingPlaceholderCefr.
    // Existe solo para que moduleComplete (que exige cefr_estimate no vacio) siga
    // dejando avanzar el intento como lo hacia antes.
    cefr_estimate: oetWritingPlaceholderCefr(percent),
    placement_band: rawTotal,
    ai_rubric_scores: {
      rubric_version: "oet-official-criteria-v1",
      oet_scores: scores,
      oet_total_raw: rawTotal,
      oet_total_max: OET_WRITING_MAX_TOTAL,
      overall_score_500: scaled500,
      overall_grade: grade,
      dimensions,
      overall_comment: overallComment,
      correcciones_para_b2: correccionesParaB2,
      compact_mode: compact === true,
      stop_reason: stopReason,
      input_tokens: Number(usage.input_tokens) || null,
      output_tokens: Number(usage.output_tokens) || null,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      model,
      graded_at: new Date().toISOString(),
    },
  };
}

// Recalcula la ruta del Nivel 1 (OET / STEPS2 / ENGLISH) con TODOS los sub_scores
// disponibles hasta ahora, y la persiste en unlock_state + attempts.status. DUPLICADA
// en submit-response -- ver la nota al inicio de este archivo.
async function recomputeRouteAndPersist(supabase, attemptId) {
  // v2 (14/08/2026, bug real encontrado antes de que ningun estudiante lo pisara):
  // falta esta lectura de track, un estudiante de NIVEL1_ONLY que sacara B2 en las 4
  // destrezas de Nivel 1 quedaba asignado a la ruta OET o STEPS2 igual que uno de
  // FULL_360. NIVEL1_ONLY debe quedar SIEMPRE en la ruta ENGLISH, sin importar el
  // resultado -- ver seccion 1 del Brief. DUPLICADO en submit-response, mantener
  // sincronizados.
  const { data: attemptRow, error: attemptTrackError } = await supabase
    .from("attempts")
    .select("track")
    .eq("id", attemptId)
    .maybeSingle();

  if (attemptTrackError) {
    console.error("submit-writing: error leyendo track del attempt", attemptTrackError);
    return { error: "Error interno. Intenta de nuevo en un momento." };
  }
  const track = attemptRow ? attemptRow.track : null;

  const { data: allSubScores, error: allSubScoresError } = await supabase
    .from("sub_scores")
    .select("skill, cefr_estimate, band_detail")
    .eq("attempt_id", attemptId);

  if (allSubScoresError) {
    console.error("submit-writing: error leyendo sub_scores", allSubScoresError);
    return { error: "Error interno. Intenta de nuevo en un momento." };
  }

  // OJO: un sub_score puede existir con cefr_estimate = null (el estudiante no superó
  // ni la banda A1 -- eso es un resultado legítimo, no "todavía no rindió"). Por eso
  // "completo" se determina por la PRESENCIA de la fila en sub_scores (skillsPresent),
  // nunca por si cefr_estimate es truthy. Debe mantenerse igual que en submit-response.
  const bySkill = Object.fromEntries(allSubScores.map((s) => [s.skill, s]));
  const skillsPresent = new Set(allSubScores.map((s) => s.skill));

  // v20 (31/08/2026, pedido de Diana, caso de Luis Padilla): nivel "efectivo" por
  // destreza para decidir OET/STEPS2 -- usa band_detail.oet_effective_level (el
  // highestPassingBand calculado en submit-response.ts) cuando existe, que puede ser
  // mas alto que el cefr_estimate mostrado si hubo un traspie puntual en una banda
  // intermedia. DUPLICADO en submit-response.ts, mantener sincronizado.
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
      // NIVEL1_ONLY nunca pasa por STEPS2 ni OET, sin importar el resultado.
      assignedRoute = "ENGLISH";
      oetUnlocked = false;
      steps2Unlocked = false;
      speakingAssessmentType = "English";
    } else {
      // v20 (31/08/2026, pedido de Diana, caso de Luis Padilla): ya NO hace falta que
      // las 4 destrezas den B2+ para abrir OET -- alcanza con que 3 de las 4 lo hagan
      // (usando el nivel "efectivo" de arriba), siempre que la restante no sea
      // inferior a B1. DUPLICADO en submit-response.ts, mantener sincronizado.
      const levels = [grammarEff, listeningEff, writingEff, readingEff];
      const countB2Plus = levels.filter((l) => meetsLevel(l, MIN_LEVEL_FOR_OET)).length;
      const allAtLeastFloor = levels.every((l) => meetsLevel(l, MIN_LEVEL_FLOOR_FOR_OET));
      const allFourOk = countB2Plus >= 3 && allAtLeastFloor;
      const readingOk = meetsLevel(readingEff, MIN_LEVEL_FOR_STEPS2);

      assignedRoute = allFourOk ? "OET" : (readingOk ? "STEPS2" : "ENGLISH");
      oetUnlocked = assignedRoute === "OET";
      steps2Unlocked = assignedRoute === "STEPS2";
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
    console.error("submit-writing: error actualizando unlock_state", unlockError);
    return { error: "Error interno. Intenta de nuevo en un momento." };
  }

  // v12 (10/08/2026, pedido de Diana): ya NO marcamos completed aca con solo
  // nivel1Complete -- ver checkAndMarkAttemptComplete() mas abajo (DUPLICADA en
  // submit-response/index.ts, mantener sincronizada) para el porque completo.
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
// problema. DUPLICADA en submit-response.ts (mismo motivo que checkAndMarkAttemptComplete
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
    console.error("submit-writing: no se pudo disparar generate-partial-report", err);
  });
}

// Marca attempts.status = 'completed' solo cuando el estudiante ya no tiene NINGUN
// modulo pendiente segun la ruta que le toco -- no solo Nivel 1. Se llama desde el
// final de cada ruta: nivel1 (recomputeRouteAndPersist, arriba, cubre ENGLISH), steps2
// (submit-response/index.ts), y oet_writing (mas abajo en este mismo archivo).
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
  if (!assignedRoute) return;

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
    fullJourneyComplete = true;
  }
  if (!fullJourneyComplete) return;

  const { error: attemptError } = await supabase
    .from("attempts")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", attemptId)
    .neq("status", "completed");
  if (attemptError) {
    console.error("checkAndMarkAttemptComplete: error marcando attempt completed", attemptError);
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
  const promptId = typeof body.prompt_id === "string" ? body.prompt_id.trim() : "";
  const responseText = typeof body.response_text === "string" ? body.response_text : "";

  if (!sessionToken || !promptId) {
    return json({ error: "Faltan session_token o prompt_id." }, 400);
  }
  if (!responseText.trim()) {
    return json({ error: "El texto de tu respuesta esta vacio." }, 400);
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(sessionToken)) {
    return json({ error: "Sesion invalida o expirada. Vuelve a ingresar tu codigo de acceso." }, 401);
  }
  if (!UUID_RE.test(promptId)) {
    return json({ error: "Consigna no encontrada." }, 404);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL"),
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  );

  const { data: session, error: sessionError } = await supabase
    .from("attempt_sessions")
    .select("attempt_id, expires_at")
    .eq("token", sessionToken)
    .maybeSingle();

  if (sessionError) {
    console.error("submit-writing: error buscando session", sessionError);
    return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
  }
  if (!session || new Date(session.expires_at).getTime() < Date.now()) {
    return json({ error: "Sesion invalida o expirada. Vuelve a ingresar tu codigo de acceso." }, 401);
  }
  const attemptId = session.attempt_id;

  const { data: promptRow, error: promptError } = await supabase
    .from("writing_prompts")
    .select("id, module, title, prompt_text, cefr_target")
    .eq("id", promptId)
    .maybeSingle();

  if (promptError) {
    console.error("submit-writing: error buscando prompt", promptError);
    return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
  }
  if (!promptRow) {
    return json({ error: "Consigna no encontrada." }, 404);
  }

  const { error: upsertError } = await supabase
    .from("writing_submissions")
    .upsert(
      {
        attempt_id: attemptId,
        prompt_id: promptRow.id,
        response_text: responseText,
        ai_rubric_scores: null,
        cefr_estimate: null,
        submitted_at: new Date().toISOString(),
      },
      { onConflict: "attempt_id,prompt_id" },
    );

  if (upsertError) {
    console.error("submit-writing: error guardando writing_submission", upsertError);
    return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
  }

  let grading = null;
  let compact = false;
  const fallos = [];
  for (let intento = 1; intento <= 3 && !grading; intento++) {
    try {
      grading = await gradeWithAI(promptRow, responseText, compact);
    } catch (err) {
      const truncated = !!(err && err.truncated);
      console.error(`submit-writing: fallo intento ${intento} (compacto: ${compact}, cortado: ${truncated})`, err);
      fallos.push({
        intento,
        compact_mode: compact,
        truncated,
        error: err && err.message ? String(err.message) : String(err),
        raw_excerpt: err && err.rawExcerpt ? err.rawExcerpt : null,
      });
      if (truncated) compact = true;
    }
  }

  if (!grading) {
    await supabase
      .from("writing_submissions")
      .update({
        ai_rubric_scores: {
          grading_failed: true,
          attempts: fallos,
          rubric_version:
            promptRow.module === "oet_writing" ? "oet-official-criteria-v1" : "cefr-anchored-v10-borderline-note",
          failed_at: new Date().toISOString(),
        },
      })
      .eq("attempt_id", attemptId)
      .eq("prompt_id", promptRow.id);
    return json({ ok: true, module_complete: false, graded: false });
  }

  if (fallos.length > 0) {
    grading.ai_rubric_scores.recovered_after = fallos;
  }

  const { error: gradeSaveError } = await supabase
    .from("writing_submissions")
    .update({
      ai_rubric_scores: grading.ai_rubric_scores,
      cefr_estimate: grading.cefr_estimate,
    })
    .eq("attempt_id", attemptId)
    .eq("prompt_id", promptRow.id);

  if (gradeSaveError) {
    console.error("submit-writing: error guardando calificacion", gradeSaveError);
    return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
  }

  const { data: modulePrompts, error: modulePromptsError } = await supabase
    .from("writing_prompts")
    .select("id")
    .eq("module", promptRow.module);

  if (modulePromptsError) {
    console.error("submit-writing: error listando prompts del modulo", modulePromptsError);
    return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
  }
  const modulePromptIds = modulePrompts.map((p) => p.id);

  const { data: submissions, error: submissionsError } = await supabase
    .from("writing_submissions")
    .select("prompt_id, cefr_estimate, ai_rubric_scores")
    .eq("attempt_id", attemptId)
    .in("prompt_id", modulePromptIds);

  if (submissionsError) {
    console.error("submit-writing: error listando submissions del modulo", submissionsError);
    return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
  }

  const gradedSubs = submissions.filter((s) => typeof s.cefr_estimate === "string" && s.cefr_estimate);
  const moduleComplete = gradedSubs.length >= modulePromptIds.length;

  if (!moduleComplete) {
    return json({ ok: true, module_complete: false, graded: true });
  }

  const moduleCefr = averageCefr(gradedSubs.map((s) => s.cefr_estimate));
  // v21 (01/09/2026): oet_writing no guarda placement_band en ai_rubric_scores (usa
  // oet_total_raw/oet_total_max, ver parseOetWritingGrading) y su maximo por tarea es
  // 38 (OET_WRITING_MAX_TOTAL), no PLACEMENT_MAX -- hay que leer/escalar distinto segun
  // el modulo.
  let rawScore, maxScore;
  if (promptRow.module === "oet_writing") {
    rawScore = gradedSubs.reduce((sum, s) => {
      const r = s.ai_rubric_scores && Number(s.ai_rubric_scores.oet_total_raw);
      return sum + (Number.isFinite(r) ? r : 0);
    }, 0);
    maxScore = modulePromptIds.length * OET_WRITING_MAX_TOTAL;
  } else {
    rawScore = gradedSubs.reduce((sum, s) => {
      const b = s.ai_rubric_scores && Number(s.ai_rubric_scores.placement_band);
      return sum + (Number.isFinite(b) ? b : 0);
    }, 0);
    maxScore = modulePromptIds.length * PLACEMENT_MAX;
  }
  const skill = MODULE_TO_SKILL[promptRow.module] || "writing";

  const { error: subScoreError } = await supabase
    .from("sub_scores")
    .upsert(
      {
        attempt_id: attemptId,
        skill,
        raw_score: rawScore,
        max_score: maxScore,
        cefr_estimate: moduleCefr,
        computed_at: new Date().toISOString(),
      },
      { onConflict: "attempt_id,skill" },
    );

  if (subScoreError) {
    console.error("submit-writing: error guardando sub_score", subScoreError);
    return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
  }

  // Solo recalculamos la ruta del Nivel 1 (OET/STEPS2/ENGLISH) cuando el modulo
  // completado es nivel1_writing -- para oet_writing la ruta ya quedo fija antes de
  // llegar aca (igual que steps2/oet_listening/oet_reading en submit-response).
  if (promptRow.module === "nivel1_writing") {
    const routeResult = await recomputeRouteAndPersist(supabase, attemptId);
    if (routeResult && routeResult.error) {
      return json({ error: routeResult.error }, 500);
    }
  } else if (promptRow.module === "oet_writing") {
    // oet_writing es el ultimo modulo de la ruta OET (oet_listening -> oet_reading ->
    // oet_writing) -- si ya esta, el recorrido completo termino (v12, pedido de Diana
    // 10/08/2026, ver checkAndMarkAttemptComplete arriba).
    await checkAndMarkAttemptComplete(supabase, attemptId);
  }

  return json({ ok: true, module_complete: true, graded: true });
});

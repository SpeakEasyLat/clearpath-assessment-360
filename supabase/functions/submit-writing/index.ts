// Edge Function: submit-writing
//
// Califica con IA una tarea de writing anclando el juicio a los descriptores del CEFR.
// NUNCA le devuelve al estudiante puntaje ni nivel en vivo.
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
// cuatro; mientras falte alguno queda en null ("pendiente"). Tambien marca
// attempts.status = 'completed' apenas se asigna la ruta (tarea 1.8).
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
const PLACEMENT_MAX = 10;
const MAX_OUTPUT_TOKENS = 4096;

// module (writing_prompts) -> skill (sub_scores). Ver nota v15 arriba -- antes de esto
// el skill quedaba hardcodeado a "writing" sin importar el modulo.
const MODULE_TO_SKILL = {
  nivel1_writing: "writing",
  oet_writing: "oet_writing",
};

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

function buildGradingPrompt(promptRow, responseText, compact) {
  const compactBlock = compact
    ? `
=== COMPACT MODE - THE PREVIOUS ANSWER WAS CUT OFF FOR BEING TOO LONG ===

Apply exactly the same rules and reach exactly the same judgement, but make the WRITTEN
OUTPUT much shorter so it fits:
- Each "dimensions" sentence: at most 12 words.
- "overall_comment": one sentence, at most 25 words.
- "cefr_justification": one sentence, at most 30 words.
- Each quotation: at most 8 words.
- Each list: at most 3 items.
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

=== THE TASK THE STUDENT WAS GIVEN (title: "${promptRow.title}") ===
"""
${promptRow.prompt_text}
"""

=== OUTPUT ===

Respond with ONLY a valid JSON object, no markdown, no commentary, in exactly this shape:
{
  "placement_band": <integer 0-10>,
  "dimensions": {
    "topic_development": "<one short sentence>",
    "clarity_of_purpose": "<one short sentence>",
    "organization": "<one short sentence>",
    "language_control": "<one short sentence>",
    "accuracy": "<one short sentence>",
    "range": "<one short sentence>"
  },
  "evidence": {
    "errors_found": ["<exact short quotation from the student's text>"],
    "errors_are_systematic": <true|false>,
    "mother_tongue_influence_is_pervasive": <true|false>,
    "complex_structures_controlled": ["<exact short quotation showing a controlled complex form>"],
    "cohesive_devices_used": ["<device>"],
    "discourse_is_linear": <true|false>,
    "borderline_decision": <true|false>,
    "borderline_between": "<for example B1/B2, or null when the level is clear>"
  },
  "cefr_justification": "<one or two sentences naming which CEFR descriptor the text matches and why>",
  "overall_comment": "<two or three sentences summarizing the level>",
  "cefr_estimate": "<A1|A2|B1|B2|C1>"
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

  const rawCefr = parsed.cefr_estimate;
  const cefr = normalizeCefr(rawCefr);
  if (!cefr) {
    const e = new Error(`cefr_estimate invalido: ${JSON.stringify(rawCefr)}`);
    e.rawExcerpt = rawText.slice(0, 600);
    e.truncated = cutOff;
    throw e;
  }

  let band = Number(parsed.placement_band);
  if (!Number.isFinite(band)) band = 0;
  band = Math.max(0, Math.min(PLACEMENT_MAX, Math.round(band)));

  return {
    cefr_estimate: cefr,
    placement_band: band,
    ai_rubric_scores: {
      placement_band: band,
      placement_max: PLACEMENT_MAX,
      dimensions: parsed.dimensions || {},
      evidence: parsed.evidence || {},
      cefr_justification: typeof parsed.cefr_justification === "string" ? parsed.cefr_justification : "",
      overall_comment: typeof parsed.overall_comment === "string" ? parsed.overall_comment : "",
      cefr_estimate: cefr,
      cefr_estimate_raw: typeof rawCefr === "string" ? rawCefr : null,
      rubric_version: "cefr-anchored-v5-word-count-neutral",
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
  const { data: allSubScores, error: allSubScoresError } = await supabase
    .from("sub_scores")
    .select("skill, cefr_estimate")
    .eq("attempt_id", attemptId);

  if (allSubScoresError) {
    console.error("submit-writing: error leyendo sub_scores", allSubScoresError);
    return { error: "Error interno. Intenta de nuevo en un momento." };
  }

  // OJO: un sub_score puede existir con cefr_estimate = null (el estudiante no superó
  // ni la banda A1 -- eso es un resultado legítimo, no "todavía no rindió"). Por eso
  // "completo" se determina por la PRESENCIA de la fila en sub_scores (skillsPresent),
  // nunca por si cefr_estimate es truthy. Debe mantenerse igual que en submit-response.
  const bySkill = Object.fromEntries(allSubScores.map((s) => [s.skill, s.cefr_estimate]));
  const skillsPresent = new Set(allSubScores.map((s) => s.skill));
  const grammarLevel = bySkill.grammar ?? null;
  const listeningLevel = bySkill.listening ?? null;
  const writingLevel = bySkill.writing ?? null;
  const readingLevel = bySkill.reading ?? null;

  const nivel1Complete =
    skillsPresent.has("grammar") && skillsPresent.has("listening") && skillsPresent.has("writing") && skillsPresent.has("reading");

  let assignedRoute = null;
  let oetUnlocked = false;
  let steps2Unlocked = false;
  let speakingAssessmentType = null;

  if (nivel1Complete) {
    const allFourOk =
      meetsLevel(grammarLevel, MIN_LEVEL_FOR_OET) &&
      meetsLevel(listeningLevel, MIN_LEVEL_FOR_OET) &&
      meetsLevel(writingLevel, MIN_LEVEL_FOR_OET) &&
      meetsLevel(readingLevel, MIN_LEVEL_FOR_OET);
    const readingOk = meetsLevel(readingLevel, MIN_LEVEL_FOR_STEPS2);

    assignedRoute = allFourOk ? "OET" : (readingOk ? "STEPS2" : "ENGLISH");
    oetUnlocked = assignedRoute === "OET";
    steps2Unlocked = assignedRoute === "STEPS2";
    speakingAssessmentType = assignedRoute === "OET" ? "OET" : "English";
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

// Marca attempts.status = 'completed' solo cuando el estudiante ya no tiene NINGUN
// modulo pendiente segun la ruta que le toco -- no solo Nivel 1. DUPLICADA en
// submit-response/index.ts (ver el comentario largo alli para el porque completo del
// bug real que esto corrige, reportado como "me llevo a grammar"). Mantener
// sincronizadas. Se llama desde el final de cada ruta: nivel1 (recomputeRouteAndPersist,
// arriba, cubre ENGLISH), steps2 (submit-response/index.ts), y oet_writing (mas abajo
// en este mismo archivo).
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
  }
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
          rubric_version: "cefr-anchored-v5-word-count-neutral",
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
  const rawScore = gradedSubs.reduce((sum, s) => {
    const b = s.ai_rubric_scores && Number(s.ai_rubric_scores.placement_band);
    return sum + (Number.isFinite(b) ? b : 0);
  }, 0);
  const maxScore = modulePromptIds.length * PLACEMENT_MAX;
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

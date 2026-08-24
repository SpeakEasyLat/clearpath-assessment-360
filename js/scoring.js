/**
 * scoring.js
 * Lógica pura (sin dependencias de UI ni de red) para:
 *   1. Determinar el nivel CEFR alcanzado en un módulo tipo "escalera" (grammar, listening
 *      y reading del Nivel 1, todos calificados por ceiling de bandas CEFR).
 *   2. Calcular el % de acierto de un sub-score (grammar / listening / writing / reading).
 *   3. Decidir la ruta del estudiante al terminar el Nivel 1, según el flujo validado por
 *      Diana el 26/07/2026 (ver claude/flujo-objetivo.md) y ampliado con Reading el
 *      05/08/2026 (tarea 1.3/1.4):
 *        "El Nivel 1 tiene CUATRO sub-scores: grammar, listening, writing y reading.
 *         La decisión se toma recién cuando los cuatro existen.
 *           - Si los CUATRO llegan a B2 -> módulo OET -> Speaking Assessment tipo 'OET'.
 *           - Si no, pero reading llega a B2 -> el estudiante está listo para STEPS 2.
 *           - Si reading NO llega a B2 -> el estudiante queda en English Level.
 *         'El reading es la llave de STEPS 2': los otros tres sub-scores solo deciden el
 *         acceso al módulo OET, nunca el de STEPS 2.
 *         Mientras el módulo STEPS 2 (Fase 3) no exista todavía, tanto la rama STEPS2 como
 *         la rama ENGLISH desembocan en el mismo Speaking Assessment breve tipo 'English'
 *         (ver el diagrama: STEPS 2 -> Link English Speaking). El campo assignedRoute sí
 *         queda registrado distinto para cuando STEPS 2 se construya y haya que enchufarlo."
 *
 * Los umbrales son los mismos para las cuatro habilidades y para el gate de reading
 * (MIN_LEVEL_FOR_OET y MIN_LEVEL_FOR_STEPS2, ambos B2 por defecto) -- configurables acá
 * abajo sin tocar el resto del código.
 */

export const CEFR_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1'];

// --- Umbrales ajustables ----------------------------------------------------
export const PERCENT_THRESHOLD = 70; // % mínimo de acierto en una banda para "aprobarla"
export const MIN_LEVEL_FOR_OET = 'B2'; // nivel CEFR mínimo (ceiling) para considerar "B1 alto"
export const MIN_LEVEL_FOR_STEPS2 = 'B2'; // nivel CEFR mínimo (ceiling de reading + vocab médico) para considerar "capacitado para STEPS 2"

// v (24/08/2026, pedido de Diana, caso de Juan Sebastian): cuando el patrón de listening
// es inconsistente (ver detectPatternInconsistency más abajo -- el estudiante superó
// alguna banda POR ENCIMA de donde se cortó el ceiling) PERO sacó >=75% específicamente
// en la banda B2, igual se desbloquea OET para esta destreza, aunque el ceiling
// bottom-up haya quedado más abajo por un traspié puntual en una banda intermedia (ej.
// B1). Solo aplica a listening -- pedido explícito de Diana, no generalizado a
// grammar/reading. El ceilingLevel mostrado NO cambia, solo la elegibilidad para OET.
// Debe mantenerse sincronizado con submit-response.ts / submit-writing.ts (Edge
// Functions), que son las que realmente deciden el acceso -- este archivo es la
// referencia espejo del lado del cliente.
export const LISTENING_B2_RESCUE_THRESHOLD = 75;

/**
 * @param {Array<{id:number, cefrLevel:string}>} questions - banco de preguntas con su banda CEFR
 * @param {Map<number, boolean>} responses - questionId -> isCorrect
 * @param {Array<{level:string, range:[number,number]}>} cefrRanges - rangos desde nivel1-grammar.json
 * @returns {{
 *   perBand: Record<string, {correct:number, total:number, percent:number, passed:boolean}>,
 *   ceilingLevel: string,            // nivel CEFR alcanzado (última banda que "pasó" el umbral)
 *   overallPercent: number           // % de acierto sobre el total de preguntas respondidas
 * }}
 */
export function computeGrammarCefr(questions, responses, cefrRanges, percentThreshold = PERCENT_THRESHOLD) {
  const perBand = {};
  let totalCorrect = 0;
  let totalCount = 0;

  for (const band of cefrRanges) {
    const [start, end] = band.range;
    const idsInBand = questions
      .filter((q) => q.id >= start && q.id <= end)
      .map((q) => q.id);

    let correct = 0;
    for (const id of idsInBand) {
      if (responses.get(id) === true) correct++;
    }
    const total = idsInBand.length;
    const percent = total > 0 ? Math.round((correct / total) * 100) : 0;
    perBand[band.level] = { correct, total, percent, passed: percent >= percentThreshold };

    totalCorrect += correct;
    totalCount += total;
  }

  // Ceiling: subimos de A1 en adelante mientras cada banda vaya superando el umbral.
  // Apenas una banda no lo supera, ahí se corta (no seguimos "premiando" aciertos sueltos
  // en bandas más difíciles si hay un hueco antes).
  let ceilingLevel = null;
  for (const level of CEFR_ORDER) {
    if (perBand[level] && perBand[level].passed) {
      ceilingLevel = level;
    } else {
      break;
    }
  }

  return {
    perBand,
    ceilingLevel, // puede ser null si ni A1 se supera
    overallPercent: totalCount > 0 ? Math.round((totalCorrect / totalCount) * 100) : 0,
  };
}

/**
 * Detecta un patrón "inconsistente": alguna banda POR ENCIMA del ceiling calculado en
 * realidad superó el umbral -- el estudiante rindió bien en un nivel más difícil que
 * donde se le cortó la racha. Es solo diagnóstico (nunca cambia el ceiling en sí), salvo
 * el caso puntual de listening + LISTENING_B2_RESCUE_THRESHOLD (ver computeListeningOetOverride).
 * Debe mantenerse sincronizada con detectPatternInconsistency en submit-response.ts.
 *
 * @param {Record<string, {correct:number, total:number, percent:number}>} perBand
 * @param {string|null} ceilingLevel
 * @returns {boolean}
 */
export function detectPatternInconsistency(perBand, ceilingLevel) {
  const ceilingIdx = ceilingLevel ? CEFR_ORDER.indexOf(ceilingLevel) : -1;
  for (let i = ceilingIdx + 1; i < CEFR_ORDER.length; i++) {
    const band = perBand[CEFR_ORDER[i]];
    if (band && band.total > 0 && band.percent >= PERCENT_THRESHOLD) {
      return true;
    }
  }
  return false;
}

/**
 * Rescate de OET para listening (ver LISTENING_B2_RESCUE_THRESHOLD arriba): true cuando
 * el patrón está inconsistente Y la banda B2 específicamente llegó a >=75%. Debe
 * mantenerse sincronizada con el mismo cálculo en submit-response.ts / submit-writing.ts.
 *
 * @param {Record<string, {correct:number, total:number, percent:number}>} perBand
 * @param {string|null} ceilingLevel
 * @param {number} [rescueThreshold]
 * @returns {boolean}
 */
export function computeListeningOetOverride(perBand, ceilingLevel, rescueThreshold = LISTENING_B2_RESCUE_THRESHOLD) {
  const patternInconsistent = detectPatternInconsistency(perBand, ceilingLevel);
  return (
    patternInconsistent &&
    !!perBand.B2 &&
    perBand.B2.total > 0 &&
    perBand.B2.percent >= rescueThreshold
  );
}

/**
 * Decide la ruta del estudiante (OET / STEPS2 / ENGLISH) al terminar el Nivel 1, en base
 * a los CUATRO sub-scores (grammar, listening, writing, reading). Debe mantenerse
 * sincronizada con la misma lógica en las Edge Functions submit-response y submit-writing.
 *
 * Reglas (flujo validado por Diana, ver claude/flujo-objetivo.md):
 *   1. La decisión NO se toma hasta que existan los cuatro sub-scores. Mientras falte
 *      alguno, assignedRoute queda en null ("pendiente") -- no se inventa un resultado.
 *   2. Si grammar Y listening Y writing Y reading superan minLevelOet (por defecto B2)
 *      -> assignedRoute = 'OET' -> Speaking Assessment tipo 'OET'.
 *   3. Si no, pero reading solo (sin importar los otros tres) llega a minLevelSteps2
 *      (por defecto B2) -> assignedRoute = 'STEPS2'. "El reading es la llave de STEPS 2."
 *   4. Si reading tampoco llega -> assignedRoute = 'ENGLISH'.
 *   5. Mientras el módulo STEPS 2 (Fase 3) no exista, tanto la rama STEPS2 como la rama
 *      ENGLISH agendan el mismo Speaking Assessment breve tipo 'English' (coincide con el
 *      diagrama: STEPS 2 -> Link English Speaking). Solo la rama OET agenda 'OET'.
 *
 * @param {{
 *   grammar: {ceilingLevel:string},
 *   listening: {ceilingLevel:string, oetUnlockOverride?: boolean},
 *   writing: {cefrEstimate:string},
 *   reading: {ceilingLevel:string}
 * }} subScores - listening.oetUnlockOverride es el resultado de computeListeningOetOverride()
 *   (ver más arriba) -- true cuando el patrón de listening quedó inconsistente pero la
 *   banda B2 llegó a LISTENING_B2_RESCUE_THRESHOLD.
 * @param {{minLevelOet?: string, minLevelSteps2?: string}} [thresholds]
 * @returns {{
 *   assignedRoute: 'OET' | 'STEPS2' | 'ENGLISH' | null,  // null = Nivel 1 todavía incompleto
 *   oetUnlocked: boolean,
 *   steps2Unlocked: boolean,        // true solo cuando assignedRoute === 'STEPS2'
 *   steps2Ok: boolean | null,       // ¿reading llega a minLevelSteps2? null = aún no se sabe
 *   speakingAssessmentType: 'OET' | 'English' | null,
 *   speakingAssessmentUnlocked: boolean,
 *   detail: {grammarOk: boolean, listeningOk: boolean, writingOk: boolean, readingOk: boolean, steps2Ok: boolean | null}
 * }}
 */
export function decideUnlocks(subScores, thresholds = {}) {
  const minLevelOet = thresholds.minLevelOet ?? MIN_LEVEL_FOR_OET;
  const minLevelSteps2 = thresholds.minLevelSteps2 ?? MIN_LEVEL_FOR_STEPS2;

  const meetsLevel = (level, minLevel) => {
    if (!level) return false;
    const idx = CEFR_ORDER.indexOf(level);
    const minIdx = CEFR_ORDER.indexOf(minLevel);
    return idx >= 0 && minIdx >= 0 && idx >= minIdx;
  };

  const grammarLevel = subScores.grammar?.ceilingLevel ?? null;
  const listeningLevel = subScores.listening?.ceilingLevel ?? null;
  const writingLevel = subScores.writing?.cefrEstimate ?? null;
  const readingLevel = subScores.reading?.ceilingLevel ?? null;

  // OJO: un módulo puede estar COMPLETO con un nivel null (el estudiante no superó ni
  // la banda A1 -- un resultado legítimo, no "todavía no lo rindió"). Por eso
  // "completo" se determina por la PRESENCIA del objeto sub-score (subScores.grammar,
  // etc.), nunca por si el nivel extraído es truthy -- confundir esto es un bug real
  // (un estudiante por debajo de A1 se quedaría sin ruta asignada para siempre). Debe
  // mantenerse igual que recomputeRouteAndPersist en submit-response/submit-writing.
  const nivel1Complete =
    subScores.grammar != null && subScores.listening != null && subScores.writing != null && subScores.reading != null;

  const grammarOk = meetsLevel(grammarLevel, minLevelOet);
  // v (24/08/2026, pedido de Diana): listening puede quedar "Ok" para OET por el rescate
  // de LISTENING_B2_RESCUE_THRESHOLD aunque su ceiling no llegue a minLevelOet -- ver
  // computeListeningOetOverride más arriba.
  const listeningOetOverride = subScores.listening?.oetUnlockOverride === true;
  const listeningOk = meetsLevel(listeningLevel, minLevelOet) || listeningOetOverride;
  const writingOk = meetsLevel(writingLevel, minLevelOet);
  const readingOk = meetsLevel(readingLevel, minLevelOet);

  // steps2Ok: ¿reading llega al umbral de STEPS 2? Solo se puede afirmar/negar una vez
  // que el Nivel 1 está completo; null = aún no se sabe.
  const steps2Ok = nivel1Complete ? meetsLevel(readingLevel, minLevelSteps2) : null;

  let assignedRoute = null;
  if (nivel1Complete) {
    const allFourOk = grammarOk && listeningOk && writingOk && readingOk;
    assignedRoute = allFourOk ? 'OET' : (steps2Ok ? 'STEPS2' : 'ENGLISH');
  }

  const oetUnlocked = assignedRoute === 'OET';
  const steps2Unlocked = assignedRoute === 'STEPS2';
  const speakingAssessmentType = assignedRoute == null ? null : (assignedRoute === 'OET' ? 'OET' : 'English');

  return {
    assignedRoute,
    oetUnlocked,
    steps2Unlocked,
    steps2Ok,
    speakingAssessmentType,
    speakingAssessmentUnlocked: speakingAssessmentType !== null,
    detail: { grammarOk, listeningOk, writingOk, readingOk, steps2Ok },
  };
}

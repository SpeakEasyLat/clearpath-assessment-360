/**
 * scoring.js
 * Lógica pura (sin dependencias de UI ni de red) para:
 *   1. Determinar el nivel CEFR alcanzado en un módulo tipo "escalera" (grammar, listening
 *      y reading del Nivel 1, todos calificados por ceiling de bandas CEFR).
 *   2. Calcular el % de acierto de un sub-score (grammar / listening / writing / reading).
 *   3. Decidir la ruta del estudiante al terminar el Nivel 1, según el flujo validado por
 *      Diana el 26/07/2026 (ver claude/flujo-objetivo.md), ampliado con Reading el
 *      05/08/2026 (tarea 1.3/1.4) y AJUSTADO el 31/08/2026 (caso de Luis Padilla):
 *        "El Nivel 1 tiene CUATRO sub-scores: grammar, listening, writing y reading.
 *         La decisión se toma recién cuando los cuatro existen.
 *           - Si al menos TRES de los cuatro llegan a B2 (usando el nivel "efectivo" de
 *             cada destreza, ver highestPassingBand más abajo) Y el cuarto no queda por
 *             debajo de B1 -> módulo OET -> Speaking Assessment tipo 'OET'.
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
export const MIN_LEVEL_FOR_OET = 'B2'; // nivel CEFR mínimo (ceiling efectivo) para contar como "en B2" a efectos de OET
export const MIN_LEVEL_FOR_STEPS2 = 'B2'; // nivel CEFR mínimo (ceiling de reading + vocab médico) para considerar "capacitado para STEPS 2"
// v (31/08/2026, pedido de Diana, caso de Luis Padilla): mínimo absoluto para la destreza
// "floja" cuando se abre OET por la regla de 3-de-4 (ver decideUnlocks más abajo) -- nunca
// deja pasar una destreza genuinamente A1/A2 solo porque las otras tres compensan. Debe
// mantenerse sincronizado con MIN_LEVEL_FLOOR_FOR_OET en submit-response.ts /
// submit-writing.ts.
export const MIN_LEVEL_FLOOR_FOR_OET = 'B1';

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
 * donde se le cortó la racha. Es solo diagnóstico (nunca cambia el ceiling en sí). Debe
 * mantenerse sincronizada con detectPatternInconsistency en submit-response.ts.
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
 * v (31/08/2026, pedido de Diana, caso de Luis Padilla): REEMPLAZA a
 * computeListeningOetOverride (que solo rescataba listening, y solo cuando la banda B2
 * específicamente llegaba a un 75% fijo). A diferencia de computeGrammarCefr (que se
 * DETIENE en la primera banda reprobada, aunque una banda más arriba se haya aprobado),
 * esta función recorre TODAS las bandas de A1 a C1 y devuelve la MÁS ALTA que haya
 * superado el umbral -- sin cortar en el primer traspié. Cuando no hay ningún traspié de
 * por medio, da exactamente el mismo resultado que el ceiling normal (porque todas las
 * bandas por debajo del ceiling, por construcción, ya lo superaron). Cuando SÍ hay un
 * traspié puntual (ej. aprobó A1/A2/B1/C1 pero falló B2), devuelve el nivel más alto real
 * (C1 en ese ejemplo) -- ese es el "beneficio de la duda" que pidió Diana: si aprobó
 * todos los niveles salvo un traspié puntual en una banda intermedia, hay consistencia
 * suficiente como para darle el nivel más alto que sacó. Se usa SOLO para decidir
 * elegibilidad a OET/STEPS2 (ver decideUnlocks más abajo) -- el ceilingLevel que se
 * muestra en el reporte sigue siendo el de computeGrammarCefr(), sin cambios. Aplica por
 * igual a grammar, listening y reading (antes el rescate era exclusivo de listening).
 * Debe mantenerse sincronizada con highestPassingBand() en submit-response.ts /
 * submit-writing.ts.
 *
 * @param {Record<string, {correct:number, total:number, percent:number}>} perBand
 * @returns {string|null}
 */
export function highestPassingBand(perBand) {
  let best = null;
  for (const level of CEFR_ORDER) {
    const band = perBand[level];
    if (band && band.total > 0 && band.percent >= PERCENT_THRESHOLD) {
      best = level;
    }
  }
  return best;
}

/**
 * Decide la ruta del estudiante (OET / STEPS2 / ENGLISH) al terminar el Nivel 1, en base
 * a los CUATRO sub-scores (grammar, listening, writing, reading). Debe mantenerse
 * sincronizada con la misma lógica en las Edge Functions submit-response y submit-writing.
 *
 * Reglas (flujo validado por Diana, ver claude/flujo-objetivo.md; AJUSTADO 31/08/2026,
 * caso de Luis Padilla):
 *   1. La decisión NO se toma hasta que existan los cuatro sub-scores. Mientras falte
 *      alguno, assignedRoute queda en null ("pendiente") -- no se inventa un resultado.
 *   2. Para cada destreza se usa su nivel "efectivo": el más alto entre su ceiling normal
 *      y highestPassingBand() (el beneficio de la duda cuando hubo un traspié puntual).
 *      Writing no tiene bandas (rúbrica IA holística), así que su nivel efectivo es
 *      directamente su cefrEstimate.
 *   3. Si AL MENOS TRES de las cuatro destrezas llegan a minLevelOet (por defecto B2) en
 *      su nivel efectivo, Y la restante no queda por debajo de minLevelFloorOet (por
 *      defecto B1) -> assignedRoute = 'OET' -> Speaking Assessment tipo 'OET'. Ya NO
 *      hace falta que las CUATRO lleguen a B2 -- antes de este ajuste sí, con un rescate
 *      booleano exclusivo de listening.
 *   4. Si no, pero reading solo (sin importar los otros tres) llega a minLevelSteps2
 *      (por defecto B2) -> assignedRoute = 'STEPS2'. "El reading es la llave de STEPS 2."
 *   5. Si reading tampoco llega -> assignedRoute = 'ENGLISH'.
 *   6. Mientras el módulo STEPS 2 (Fase 3) no exista, tanto la rama STEPS2 como la rama
 *      ENGLISH agendan el mismo Speaking Assessment breve tipo 'English' (coincide con el
 *      diagrama: STEPS 2 -> Link English Speaking). Solo la rama OET agenda 'OET'.
 *
 * @param {{
 *   grammar: {ceilingLevel:string, oetEffectiveLevel?: string},
 *   listening: {ceilingLevel:string, oetEffectiveLevel?: string},
 *   writing: {cefrEstimate:string},
 *   reading: {ceilingLevel:string, oetEffectiveLevel?: string}
 * }} subScores - oetEffectiveLevel es el resultado de highestPassingBand() (ver más
 *   arriba) para esa destreza -- cuando no se provee, se usa ceilingLevel tal cual (sin
 *   beneficio de la duda).
 * @param {{minLevelOet?: string, minLevelSteps2?: string, minLevelFloorOet?: string}} [thresholds]
 * @returns {{
 *   assignedRoute: 'OET' | 'STEPS2' | 'ENGLISH' | null,  // null = Nivel 1 todavía incompleto
 *   oetUnlocked: boolean,
 *   steps2Unlocked: boolean,        // true solo cuando assignedRoute === 'STEPS2'
 *   steps2Ok: boolean | null,       // ¿reading llega a minLevelSteps2? null = aún no se sabe
 *   speakingAssessmentType: 'OET' | 'English' | null,
 *   speakingAssessmentUnlocked: boolean,
 *   detail: {grammarOk: boolean, listeningOk: boolean, writingOk: boolean, readingOk: boolean, countB2Plus: number, steps2Ok: boolean | null}
 * }}
 */
export function decideUnlocks(subScores, thresholds = {}) {
  const minLevelOet = thresholds.minLevelOet ?? MIN_LEVEL_FOR_OET;
  const minLevelSteps2 = thresholds.minLevelSteps2 ?? MIN_LEVEL_FOR_STEPS2;
  const minLevelFloorOet = thresholds.minLevelFloorOet ?? MIN_LEVEL_FLOOR_FOR_OET;

  const meetsLevel = (level, minLevel) => {
    if (!level) return false;
    const idx = CEFR_ORDER.indexOf(level);
    const minIdx = CEFR_ORDER.indexOf(minLevel);
    return idx >= 0 && minIdx >= 0 && idx >= minIdx;
  };

  // Nivel "efectivo" por destreza -- el más alto entre el ceiling normal y el beneficio
  // de la duda de highestPassingBand(), cuando el caller lo haya provisto. Writing no
  // tiene bandas: su nivel efectivo es directamente su cefrEstimate.
  const effectiveOf = (skillScore) => {
    if (!skillScore) return null;
    return skillScore.oetEffectiveLevel ?? skillScore.ceilingLevel ?? null;
  };
  const grammarLevel = effectiveOf(subScores.grammar);
  const listeningLevel = effectiveOf(subScores.listening);
  const writingLevel = subScores.writing?.cefrEstimate ?? null;
  const readingLevel = effectiveOf(subScores.reading);

  // OJO: un módulo puede estar COMPLETO con un nivel null (el estudiante no superó ni
  // la banda A1 -- un resultado legítimo, no "todavía no lo rindió"). Por eso
  // "completo" se determina por la PRESENCIA del objeto sub-score (subScores.grammar,
  // etc.), nunca por si el nivel extraído es truthy -- confundir esto es un bug real
  // (un estudiante por debajo de A1 se quedaría sin ruta asignada para siempre). Debe
  // mantenerse igual que recomputeRouteAndPersist en submit-response/submit-writing.
  const nivel1Complete =
    subScores.grammar != null && subScores.listening != null && subScores.writing != null && subScores.reading != null;

  const grammarOk = meetsLevel(grammarLevel, minLevelOet);
  const listeningOk = meetsLevel(listeningLevel, minLevelOet);
  const writingOk = meetsLevel(writingLevel, minLevelOet);
  const readingOk = meetsLevel(readingLevel, minLevelOet);

  // steps2Ok: ¿reading llega al umbral de STEPS 2? Solo se puede afirmar/negar una vez
  // que el Nivel 1 está completo; null = aún no se sabe.
  const steps2Ok = nivel1Complete ? meetsLevel(readingLevel, minLevelSteps2) : null;

  // v (31/08/2026, pedido de Diana, caso de Luis Padilla): 3 de 4 destrezas en B2+ (en
  // su nivel efectivo), con la 4ta en al menos minLevelFloorOet -- ya no hace falta que
  // sean las CUATRO. Antes: allFourOk exigía meetsLevel(..., B2) en las 4 destrezas (con
  // un override booleano solo para listening).
  const countB2Plus = [grammarOk, listeningOk, writingOk, readingOk].filter(Boolean).length;
  const allAtLeastFloor = [grammarLevel, listeningLevel, writingLevel, readingLevel].every((l) =>
    meetsLevel(l, minLevelFloorOet),
  );
  const allFourOk = countB2Plus >= 3 && allAtLeastFloor;

  let assignedRoute = null;
  if (nivel1Complete) {
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
    detail: { grammarOk, listeningOk, writingOk, readingOk, countB2Plus, steps2Ok },
  };
}

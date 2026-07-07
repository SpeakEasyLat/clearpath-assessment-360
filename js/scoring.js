/**
 * scoring.js
 * Lógica pura (sin dependencias de UI ni de red) para:
 *   1. Determinar el nivel CEFR alcanzado en un módulo tipo "escalera" (grammar Nivel 1,
 *      y más adelante también el reading + vocabulario médico de STEPS 2).
 *   2. Calcular el % de acierto de un sub-score (grammar / listening / writing / steps2_reading).
 *   3. Decidir el desbloqueo de OET y de la sesión en vivo de Speaking Assessment según
 *      la regla que definió Diana:
 *        "Si el estudiante está apto para OET (grammar, listening y writing del Nivel 1
 *         superan el umbral de B1 alto), se desbloquea agendar el Speaking Assessment
 *         de tipo OET (el roleplay). Si NO está listo para OET y además el ceiling de
 *         reading + vocabulario médico de STEPS 2 tampoco llega a B2 (sin importar
 *         writing, speaking ni grammar fuera de textos médicos), el estudiante queda
 *         en English Level y se desbloquea un Speaking Assessment breve de tipo English
 *         en su lugar. Si no está listo para OET pero SÍ tiene el nivel de STEPS 2,
 *         simplemente continúa en STEPS 2, sin sesión en vivo por ahora."
 *
 * OJO / decisión pendiente de confirmar con Diana:
 *   "B1 alto" no es un sub-nivel oficial del CEFR (el CEFR estándar es A1/A2/B1/B2/C1/C2).
 *   Acá lo modelamos como DOS condiciones combinadas, configurables:
 *     a) el nivel CEFR alcanzado (ceiling) debe ser >= MIN_LEVEL_FOR_OET (por defecto 'B2',
 *        para capturar la idea de "B1 alto/casi B2"), Y
 *     b) el % de acierto en la banda B1 debe ser >= PERCENT_THRESHOLD (por defecto 70%).
 *   Estos dos valores son fácilmente ajustables acá abajo sin tocar el resto del código.
 *
 *   El umbral de STEPS 2 (MIN_LEVEL_FOR_STEPS2) usa el mismo mecanismo de ceiling CEFR,
 *   pero aplicado SOLO al sub-score de reading + vocabulario médico de STEPS 2 -- todavía
 *   no existe el módulo STEPS 2 en la app (está en el backlog), así que por ahora
 *   `subScores.steps2` llega como null/undefined y la función lo trata como "aún no se sabe"
 *   en vez de asumir que falla.
 */

export const CEFR_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1'];

// --- Umbrales ajustables ----------------------------------------------------
export const PERCENT_THRESHOLD = 70; // % mínimo de acierto en una banda para "aprobarla"
export const MIN_LEVEL_FOR_OET = 'B2'; // nivel CEFR mínimo (ceiling) para considerar "B1 alto"
export const MIN_LEVEL_FOR_STEPS2 = 'B2'; // nivel CEFR mínimo (ceiling de reading + vocab médico) para considerar "capacitado para STEPS 2"

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
 * Decide el desbloqueo de OET y de la sesión en vivo de Speaking Assessment, en base a:
 *   - los 3 sub-scores del Nivel 1 (grammar, listening, writing) para el gate de OET, y
 *   - el sub-score de STEPS 2 (reading + vocabulario médico) para decidir si, cuando NO
 *     se alcanza OET, el estudiante todavía tiene nivel para STEPS 2 o si queda en
 *     English Level y se le agenda un Speaking Assessment breve en su lugar.
 *
 * Reglas (definidas por Diana):
 *   1. Si grammar Y listening Y writing (Nivel 1) superan el umbral de "B1 alto"
 *      (>= minLevelOet) -> OET se desbloquea -> Speaking Assessment tipo 'OET'
 *      (agendar el roleplay OET en vivo).
 *   2. Si NO se cumple lo anterior, se mira el ceiling de reading + vocabulario médico
 *      de STEPS 2 (ignora writing, speaking y grammar fuera de textos médicos):
 *        a) si ese ceiling >= minLevelSteps2 -> el estudiante sigue en STEPS 2, sin
 *           sesión en vivo por ahora (speakingAssessmentType = null).
 *        b) si ese ceiling < minLevelSteps2 -> el estudiante queda en English Level
 *           (ni OET ni STEPS 2) -> se desbloquea un Speaking Assessment breve tipo
 *           'English' en su lugar.
 *   3. Si todavía no existe el sub-score de STEPS 2 (subScores.steps2 es null/undefined,
 *      porque ese módulo aún no está construido), no se puede decidir 2a/2b -- se deja
 *      steps2Ok en null y speakingAssessmentType en null ("pendiente", no se inventa
 *      un resultado que la app todavía no puede calcular de verdad).
 *
 * @param {{
 *   grammar: {ceilingLevel:string},
 *   listening: {ceilingLevel:string},
 *   writing: {cefrEstimate:string},
 *   steps2: {ceilingLevel:string} | null | undefined
 * }} subScores
 * @param {{minLevelOet?: string, minLevelSteps2?: string}} [thresholds]
 * @returns {{
 *   steps2Unlocked: boolean,
 *   oetUnlocked: boolean,
 *   steps2Ok: boolean | null,       // null = todavía no se rindió/construyó STEPS 2
 *   speakingAssessmentType: 'OET' | 'English' | null,
 *   speakingAssessmentUnlocked: boolean,
 *   detail: {grammarOk: boolean, listeningOk: boolean, writingOk: boolean, steps2Ok: boolean | null}
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

  const grammarOk = meetsLevel(subScores.grammar?.ceilingLevel, minLevelOet);
  const listeningOk = meetsLevel(subScores.listening?.ceilingLevel, minLevelOet);
  const writingOk = meetsLevel(subScores.writing?.cefrEstimate, minLevelOet);

  const oetUnlocked = grammarOk && listeningOk && writingOk;

  // steps2Ok: true/false solo si ya tenemos el sub-score de STEPS 2; null = aún no se sabe.
  const steps2Level = subScores.steps2?.ceilingLevel;
  const steps2Ok = steps2Level == null ? null : meetsLevel(steps2Level, minLevelSteps2);

  let speakingAssessmentType = null;
  if (oetUnlocked) {
    speakingAssessmentType = 'OET';
  } else if (steps2Ok === false) {
    speakingAssessmentType = 'English';
  }

  return {
    steps2Unlocked: true, // el módulo STEPS 2 en sí es obligatorio y secuencial para todos, sin condición
    oetUnlocked,
    steps2Ok,
    speakingAssessmentType,
    speakingAssessmentUnlocked: speakingAssessmentType !== null,
    detail: { grammarOk, listeningOk, writingOk, steps2Ok },
  };
}

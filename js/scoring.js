/**
 * scoring.js
 * Lógica pura (sin dependencias de UI ni de red) para:
 *   1. Determinar el nivel CEFR alcanzado en un módulo tipo "escalera" (grammar Nivel 1).
 *   2. Calcular el % de acierto de un sub-score (grammar / listening / writing / steps2_reading).
 *   3. Decidir el desbloqueo de OET y Roleplay según la regla que definió Diana:
 *        "OET se desbloquea solo si grammar, listening y writing (Nivel 1) superan
 *         el umbral de B1 alto -- si falla alguno, el estudiante queda en STEPS 2."
 *
 * OJO / decisión pendiente de confirmar con Diana:
 *   "B1 alto" no es un sub-nivel oficial del CEFR (el CEFR estándar es A1/A2/B1/B2/C1/C2).
 *   Acá lo modelamos como DOS condiciones combinadas, configurables:
 *     a) el nivel CEFR alcanzado (ceiling) debe ser >= MIN_LEVEL_FOR_OET (por defecto 'B2',
 *        para capturar la idea de "B1 alto/casi B2"), Y
 *     b) el % de acierto en la banda B1 debe ser >= PERCENT_THRESHOLD (por defecto 70%).
 *   Estos dos valores son fácilmente ajustables acá abajo sin tocar el resto del código.
 */

export const CEFR_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1'];

// --- Umbrales ajustables ----------------------------------------------------
export const PERCENT_THRESHOLD = 70; // % mínimo de acierto en una banda para "aprobarla"
export const MIN_LEVEL_FOR_OET = 'B2'; // nivel CEFR mínimo (ceiling) para considerar "B1 alto"

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
 * Decide si se desbloquea OET (y por lo tanto el Roleplay) en base a los 3 sub-scores
 * del Nivel 1: grammar, listening, writing. Los tres deben cumplir el criterio de "B1 alto".
 *
 * @param {{grammar: {ceilingLevel:string}, listening: {ceilingLevel:string}, writing: {cefrEstimate:string}}} subScores
 */
export function decideUnlocks(subScores, minLevel = MIN_LEVEL_FOR_OET) {
  const minIndex = CEFR_ORDER.indexOf(minLevel);

  const meetsThreshold = (level) => {
    if (!level) return false;
    const idx = CEFR_ORDER.indexOf(level);
    return idx >= 0 && idx >= minIndex;
  };

  const grammarOk = meetsThreshold(subScores.grammar?.ceilingLevel);
  const listeningOk = meetsThreshold(subScores.listening?.ceilingLevel);
  const writingOk = meetsThreshold(subScores.writing?.cefrEstimate);

  const oetUnlocked = grammarOk && listeningOk && writingOk;

  return {
    steps2Unlocked: true, // obligatorio y secuencial para todos, sin condición
    oetUnlocked,
    roleplayUnlocked: oetUnlocked, // depende del mismo gate que OET
    detail: { grammarOk, listeningOk, writingOk },
  };
}

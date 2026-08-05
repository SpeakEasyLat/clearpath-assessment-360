import assert from 'node:assert/strict';
import { computeGrammarCefr, decideUnlocks } from './scoring.js';
import cefrRanges_ from '../data/nivel1-grammar.json' with { type: 'json' };

const grammarData = cefrRanges_;
const questions = grammarData.questions.map((q) => ({ id: q.id }));
// Asignar cefrLevel a cada pregunta según los rangos (solo para dejar la fixture completa,
// aunque computeGrammarCefr en realidad solo usa los ids + rangos).
for (const band of grammarData.cefrRanges) {
  const [start, end] = band.range;
  for (const q of questions) {
    if (q.id >= start && q.id <= end) q.cefrLevel = band.level;
  }
}

function allCorrectUpTo(maxId) {
  const responses = new Map();
  for (const q of questions) {
    responses.set(q.id, q.id <= maxId);
  }
  return responses;
}

// Caso 1: estudiante que responde bien todo hasta B1 (id 24) y falla todo lo demás
{
  const responses = allCorrectUpTo(24);
  const result = computeGrammarCefr(questions, responses, grammarData.cefrRanges);
  assert.equal(result.ceilingLevel, 'B1', `esperaba B1, dio ${result.ceilingLevel}`);
  assert.equal(result.perBand.B2.passed, false);
  console.log('Caso 1 OK: ceiling =', result.ceilingLevel, 'overall% =', result.overallPercent);
}

// Caso 2: estudiante que responde absolutamente todo bien -> C1
{
  const responses = allCorrectUpTo(44);
  const result = computeGrammarCefr(questions, responses, grammarData.cefrRanges);
  assert.equal(result.ceilingLevel, 'C1');
  assert.equal(result.overallPercent, 100);
  console.log('Caso 2 OK: ceiling =', result.ceilingLevel, 'overall% =', result.overallPercent);
}

// Caso 3: "hueco" -- falla toda la banda B1 pero acierta bien B2/C1 (poco realista pero
// prueba que el ceiling NO debe premiar aciertos sueltos después de un hueco)
{
  const responses = new Map();
  for (const q of questions) {
    const failB1 = q.id >= 13 && q.id <= 24;
    responses.set(q.id, !failB1);
  }
  const result = computeGrammarCefr(questions, responses, grammarData.cefrRanges);
  assert.equal(result.ceilingLevel, 'A2', `esperaba A2 (se corta en el hueco de B1), dio ${result.ceilingLevel}`);
  console.log('Caso 3 OK: ceiling =', result.ceilingLevel, '(correctamente se corta en el hueco de B1)');
}

// Caso 4: decideUnlocks -- los 4 sub-scores del Nivel 1 (grammar/listening/writing/
// reading) llegan a B2 -> ruta OET, y el Speaking Assessment queda tipo 'OET'
{
  const subScores = {
    grammar: { ceilingLevel: 'B2' },
    listening: { ceilingLevel: 'B2' },
    writing: { cefrEstimate: 'B2' },
    reading: { ceilingLevel: 'B2' },
  };
  const unlocks = decideUnlocks(subScores);
  assert.equal(unlocks.assignedRoute, 'OET');
  assert.equal(unlocks.oetUnlocked, true);
  assert.equal(unlocks.speakingAssessmentType, 'OET');
  assert.equal(unlocks.speakingAssessmentUnlocked, true);
  assert.equal(unlocks.steps2Unlocked, false, 'la ruta OET no es la ruta STEPS2');
  console.log("Caso 4 OK: ruta OET cuando los 4 sub-scores del Nivel 1 llegan a B2");
}

// Caso 5a: grammar y listening en B2 pero writing se queda en B1 -> OET NO se desbloquea.
// Reading (la llave de STEPS 2) SÍ llega a B2 -> ruta STEPS2.
{
  const subScores = {
    grammar: { ceilingLevel: 'B2' },
    listening: { ceilingLevel: 'B2' },
    writing: { cefrEstimate: 'B1' },
    reading: { ceilingLevel: 'B2' },
  };
  const unlocks = decideUnlocks(subScores);
  assert.equal(unlocks.oetUnlocked, false, 'writing en B1 debe bloquear OET aunque los otros tres estén bien');
  assert.equal(unlocks.assignedRoute, 'STEPS2');
  assert.equal(unlocks.steps2Ok, true);
  assert.equal(unlocks.steps2Unlocked, true);
  assert.equal(unlocks.speakingAssessmentType, 'English', 'mientras STEPS 2 no exista como módulo, agenda el Speaking Assessment breve English');
  console.log('Caso 5a OK: writing insuficiente bloquea OET, pero reading alcanza B2 -> ruta STEPS2');
}

// Caso 5b: igual que 5a, pero reading tampoco llega a B2 -> ruta ENGLISH
{
  const subScores = {
    grammar: { ceilingLevel: 'B2' },
    listening: { ceilingLevel: 'B2' },
    writing: { cefrEstimate: 'B1' },
    reading: { ceilingLevel: 'A2' },
  };
  const unlocks = decideUnlocks(subScores);
  assert.equal(unlocks.oetUnlocked, false);
  assert.equal(unlocks.assignedRoute, 'ENGLISH');
  assert.equal(unlocks.steps2Ok, false);
  assert.equal(unlocks.steps2Unlocked, false);
  assert.equal(unlocks.speakingAssessmentType, 'English', 'ni OET ni STEPS2 -> Speaking Assessment breve (English)');
  assert.equal(unlocks.speakingAssessmentUnlocked, true);
  console.log("Caso 5b OK: reading tampoco alcanza B2 -> ruta ENGLISH, Speaking Assessment tipo 'English'");
}

// Caso 6: todavía faltan sub-scores del Nivel 1 (reading no existe) -> no se debe
// inventar un resultado; assignedRoute, steps2Ok y speakingAssessmentType quedan en
// null ("pendiente") hasta que existan los cuatro sub-scores
{
  const subScores = {
    grammar: { ceilingLevel: 'B1' },
    listening: null,
    writing: null,
    reading: null,
  };
  const unlocks = decideUnlocks(subScores);
  assert.equal(unlocks.assignedRoute, null, 'con el Nivel 1 incompleto no se puede asignar ruta todavía');
  assert.equal(unlocks.oetUnlocked, false);
  assert.equal(unlocks.steps2Ok, null, 'sin los 4 sub-scores no se puede afirmar que sí ni que no');
  assert.equal(unlocks.speakingAssessmentType, null, 'no se debe simular un Speaking Assessment sin datos reales');
  console.log('Caso 6 OK: con el Nivel 1 incompleto, el resultado queda pendiente (null) en vez de simulado');
}

// Caso 7: los 4 módulos están COMPLETOS pero reading no superó ni la banda A1 -- el
// ceiling real es null (no "todavía no rindió"). Este es exactamente el bug encontrado
// en la prueba end-to-end del 05/08/2026: antes, un ceiling null se confundía con
// "módulo no completado" y assignedRoute se quedaba en null para siempre. Debe asignar
// ENGLISH igual que si reading hubiera dado A2 (Caso 5b).
{
  const subScores = {
    grammar: { ceilingLevel: 'B2' },
    listening: { ceilingLevel: 'B2' },
    writing: { cefrEstimate: 'B2' },
    reading: { ceilingLevel: null },
  };
  const unlocks = decideUnlocks(subScores);
  assert.equal(unlocks.assignedRoute, 'ENGLISH', 'reading con ceiling null (completo, pero por debajo de A1) debe rutear a ENGLISH, no quedar pendiente');
  assert.equal(unlocks.oetUnlocked, false);
  assert.equal(unlocks.steps2Ok, false);
  assert.equal(unlocks.speakingAssessmentType, 'English');
  console.log('Caso 7 OK: reading completo con ceiling null (por debajo de A1) rutea a ENGLISH en vez de quedar pendiente');
}

console.log('\nTodos los casos de prueba pasaron.');

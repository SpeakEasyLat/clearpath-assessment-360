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

// Caso 4: decideUnlocks -- los 3 sub-scores llegan a B2 -> OET se desbloquea y el
// Speaking Assessment queda tipo 'OET' (agendar el roleplay)
{
  const subScores = {
    grammar: { ceilingLevel: 'B2' },
    listening: { ceilingLevel: 'B2' },
    writing: { cefrEstimate: 'B2' },
  };
  const unlocks = decideUnlocks(subScores);
  assert.equal(unlocks.oetUnlocked, true);
  assert.equal(unlocks.speakingAssessmentType, 'OET');
  assert.equal(unlocks.speakingAssessmentUnlocked, true);
  assert.equal(unlocks.steps2Unlocked, true);
  console.log("Caso 4 OK: OET desbloqueado y Speaking Assessment tipo 'OET' cuando los 3 sub-scores llegan a B2");
}

// Caso 5a: grammar y listening en B2 pero writing se queda en B1 -> OET NO se desbloquea.
// STEPS 2 (reading + vocab médico) SÍ llega a B2 -> sigue en STEPS 2, sin sesión en vivo.
{
  const subScores = {
    grammar: { ceilingLevel: 'B2' },
    listening: { ceilingLevel: 'B2' },
    writing: { cefrEstimate: 'B1' },
    steps2: { ceilingLevel: 'B2' },
  };
  const unlocks = decideUnlocks(subScores);
  assert.equal(unlocks.oetUnlocked, false, 'writing en B1 (no llega a B1 alto) debe bloquear OET');
  assert.equal(unlocks.steps2Ok, true);
  assert.equal(unlocks.speakingAssessmentType, null, 'si STEPS 2 sí alcanza, no corresponde Speaking Assessment todavía');
  assert.equal(unlocks.steps2Unlocked, true, 'STEPS 2 siempre debe quedar disponible');
  console.log('Caso 5a OK: writing insuficiente bloquea OET, pero STEPS 2 alcanza -> sigue en STEPS 2 sin sesión en vivo');
}

// Caso 5b: igual que 5a, pero el ceiling de STEPS 2 (reading + vocab médico) tampoco
// llega a B2 -> el estudiante queda en English Level -> Speaking Assessment tipo 'English'
{
  const subScores = {
    grammar: { ceilingLevel: 'B2' },
    listening: { ceilingLevel: 'B2' },
    writing: { cefrEstimate: 'B1' },
    steps2: { ceilingLevel: 'A2' },
  };
  const unlocks = decideUnlocks(subScores);
  assert.equal(unlocks.oetUnlocked, false);
  assert.equal(unlocks.steps2Ok, false);
  assert.equal(unlocks.speakingAssessmentType, 'English', 'si ni OET ni STEPS 2 se alcanzan, corresponde el Speaking Assessment breve (English)');
  assert.equal(unlocks.speakingAssessmentUnlocked, true);
  console.log("Caso 5b OK: ni OET ni STEPS 2 se alcanzan -> Speaking Assessment tipo 'English' desbloqueado");
}

// Caso 6: STEPS 2 todavía no existe como módulo (subScores.steps2 llega null) -> no se
// debe inventar un resultado; steps2Ok y speakingAssessmentType quedan en null ("pendiente")
{
  const subScores = {
    grammar: { ceilingLevel: 'B1' },
    listening: null,
    writing: null,
    steps2: null,
  };
  const unlocks = decideUnlocks(subScores);
  assert.equal(unlocks.oetUnlocked, false);
  assert.equal(unlocks.steps2Ok, null, 'sin datos de STEPS 2 no se puede afirmar que sí ni que no');
  assert.equal(unlocks.speakingAssessmentType, null, 'no se debe simular un Speaking Assessment sin datos reales');
  console.log('Caso 6 OK: sin sub-score de STEPS 2 todavía, el resultado queda pendiente (null) en vez de simulado');
}

console.log('\nTodos los casos de prueba pasaron.');

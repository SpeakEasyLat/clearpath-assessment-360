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

// Caso 4: decideUnlocks -- los 3 sub-scores llegan a B2 -> OET y Roleplay se desbloquean
{
  const subScores = {
    grammar: { ceilingLevel: 'B2' },
    listening: { ceilingLevel: 'B2' },
    writing: { cefrEstimate: 'B2' },
  };
  const unlocks = decideUnlocks(subScores);
  assert.equal(unlocks.oetUnlocked, true);
  assert.equal(unlocks.roleplayUnlocked, true);
  assert.equal(unlocks.steps2Unlocked, true);
  console.log('Caso 4 OK: OET y Roleplay desbloqueados cuando los 3 sub-scores llegan a B2');
}

// Caso 5: grammar y listening en B2 pero writing se queda en B1 -> OET NO se desbloquea
{
  const subScores = {
    grammar: { ceilingLevel: 'B2' },
    listening: { ceilingLevel: 'B2' },
    writing: { cefrEstimate: 'B1' },
  };
  const unlocks = decideUnlocks(subScores);
  assert.equal(unlocks.oetUnlocked, false, 'writing en B1 (no llega a B1 alto) debe bloquear OET');
  assert.equal(unlocks.roleplayUnlocked, false);
  assert.equal(unlocks.steps2Unlocked, true, 'STEPS 2 siempre debe quedar disponible');
  console.log('Caso 5 OK: writing insuficiente bloquea OET (y roleplay), STEPS 2 sigue disponible');
}

console.log('\nTodos los casos de prueba pasaron.');

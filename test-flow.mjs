import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const grammarData = JSON.parse(readFileSync(new URL('./data/nivel1-grammar.json', import.meta.url)));
const questions = grammarData.questions;

const consoleErrors = [];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

await page.goto('http://localhost:8899/index.html');
await page.fill('#fullName', 'Estudiante de Prueba');
await page.fill('#accessCode', 'TEST-0001');
await page.click('#startBtn');

await page.waitForURL('**/nivel1.html');
await page.waitForSelector('.question-card');

console.log('Pregunta 1 visible:', await page.textContent('.q-text'));

for (let i = 0; i < questions.length; i++) {
  const q = questions[i];
  const pickCorrect = i % 3 !== 0; // ~2/3 correctas para probar un ceiling intermedio
  const targetText = pickCorrect ? q.correct : "I don't know the answer.";

  const options = await page.$$('.option');
  let clicked = false;
  for (const opt of options) {
    const text = (await opt.textContent()).trim();
    if (text === targetText) {
      await opt.click();
      clicked = true;
      break;
    }
  }
  if (!clicked) throw new Error(`No encontré la opción "${targetText}" para la pregunta id ${q.id}`);

  const nextBtn = await page.$('#nextBtn');
  await nextBtn.click();
  await page.waitForTimeout(15);
}

await page.waitForSelector('#resultArea');
const resultText = await page.textContent('#resultArea');
console.log('\n--- RESULT AREA ---\n', resultText.replace(/\s+/g, ' ').trim());

console.log('\n--- CONSOLE ERRORS ---');
console.log(consoleErrors.length ? consoleErrors : 'Ninguno');

await browser.close();
process.exit(consoleErrors.length ? 1 : 0);

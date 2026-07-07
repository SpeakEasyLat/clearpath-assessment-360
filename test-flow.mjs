// Test local (Playwright) del flujo login -> intake, que hoy corre contra los
// Edge Functions reales (login, submit-intake). Todavia no prueba Nivel 1:
// esa parte sigue corrigiendo del lado del cliente con datos que ya no estan
// en el JSON publico (ver nota en index.html), asi que ese test se reescribe
// cuando conectemos nivel1.html al Edge Function submit-response.
//
// Requiere: un estudiante de prueba con access_code = 'TEST-0001' cargado en
// Supabase, y el sitio sirviendose localmente en http://localhost:8899.
import { chromium } from 'playwright';
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
await page.waitForURL('**/intake.html');
console.log('Login OK -- llego a intake.html');
console.log('\n--- CONSOLE ERRORS ---');
console.log(consoleErrors.length ? consoleErrors : 'Ninguno');
await browser.close();
process.exit(consoleErrors.length ? 1 : 0);

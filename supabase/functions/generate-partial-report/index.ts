// Edge Function: generate-partial-report
//
// Genera un "reporte PARCIAL de resultados" (PDF) de un attempt y lo manda por correo a
// Diana (info@speakeasy.lat) vía Resend, apenas el estudiante termina la parte ESCRITA
// del assessment (Nivel 1 + STEP CK 2 / OET si corresponde) -- es decir, exactamente el
// momento en que attempts.status pasa a 'completed' (ver checkAndMarkAttemptComplete en
// submit-response.ts / submit-writing.ts). Todavía NO incluye Speaking, porque en ese
// momento el estudiante todavía no lo rindió.
//
// Es HERMANA de generate-report (el reporte FINAL, que sí espera e incluye Speaking) --
// comparte casi todo el armado del PDF (mismo HTML/CSS, misma lógica de bloques por
// destreza), pero:
//   - Se dispara con attempts.status === 'completed' en vez de esperar el
//     evaluator_score de Speaking.
//   - Nunca arma el bloque de Speaking ni sus skillLevels.
//   - Usa su propia columna de idempotencia (attempts.partial_report_sent_at) --
//     totalmente independiente de report_sent_at (el reporte final se sigue mandando
//     igual, sin que este reporte parcial interfiera).
//   - Opcionalmente sube el PDF a una carpeta de Google Drive compartida con una cuenta
//     de servicio (ver uploadPdfToDrive) -- si los secrets GOOGLE_SERVICE_ACCOUNT_JSON /
//     GOOGLE_DRIVE_FOLDER_ID todavía no están cargados, se omite el upload sin fallar el
//     envío del correo (queda activo solo, sin redeploy, en cuanto Diana los cargue).
//
// Se llama de dos formas, igual que generate-report:
//   1. Automáticamente, fire-and-forget, desde checkAndMarkAttemptComplete en
//      submit-response.ts y submit-writing.ts, justo cuando marcan attempts.status =
//      'completed'.
//   2. Manualmente, con POST { attempt_id: "..." } directo a esta función -- útil para
//      pruebas o para regenerar un reporte parcial a pedido.
//
// v9 (03/09/2026, pedido de Diana): se saca la nota chiquita debajo del puntaje en los
// chips de "Resultados por destreza" (ej. "puntaje OET real, calculado a partir de los 9
// criterios cargados por Diana", "puntaje OET aproximado") -- espejo exacto del mismo
// cambio en generate-report.ts v20.
//
// v7 (01/09/2026, reportado por Diana): OET Writing no mostraba ni el ensayo ni su
// evaluación en el reporte -- se armaba con el mismo template que oet_listening/
// oet_reading (preguntas de opción múltiple), así que salía como "OET Writing 3/10 --
// Resultado informativo: 30% de respuestas correctas" sin texto, sin comentario de la
// IA y sin correcciones. Se le da a oet_writing el mismo tratamiento que ya tenía
// Writing de Nivel 1 (tarjeta con el ensayo, el comentario de la IA y "Correcciones
// para llegar a B2"), y se agrega además una "Evaluación por criterio" con las 6
// dimensiones que ya calculaba submit-writing (topic_development, clarity_of_purpose,
// organization, language_control, accuracy, range) pero que ningún reporte mostraba --
// ni siquiera el de Nivel 1, que también las gana con este cambio. De paso se corrige
// un bug de datos: la consulta a writing_submissions no traía el módulo del prompt, así
// que el bloque "Writing" de Nivel 1 mostraba TODAS las writing_submissions del attempt
// sin filtrar -- para un estudiante en la ruta OET, el ensayo de OET aparecía mezclado
// ahí también. Ahora se filtra explícitamente por module (nivel1_writing / oet_writing).
//
// v6 (31/08/2026, pedido de Diana): la nota de rescate OET (band_detail.oet_unlock_note)
// ya NO es exclusiva de listening -- desde submit-response.ts v21 puede venir de
// grammar, listening o reading (ver highestPassingBand allá). Antes esta función solo
// mostraba la nota cuando sk === "listening", así que un rescate en grammar o reading
// quedaba calculado pero invisible en el reporte. Se generaliza a cualquier destreza.
//
// v5 (28/08/2026, pedido de Diana): orden de las secciones/destrezas en el reporte.
// El orden de bloques ya era el correcto (Nivel 1, y después STEP CK 2 u OET según la
// ruta asignada -- un estudiante solo tiene una de las dos, nunca ambas). Lo que estaba
// mal era el orden DENTRO del bloque Nivel 1: nivel1Skills tenía "writing" antes que
// "reading" por error. Se corrige a grammar, listening, reading, writing (como estaba
// antes). Dentro de OET ya estaba bien: listening, reading, writing.
//
// v4 (28/08/2026, pedido de Diana): CASO REAL -- un estudiante llega a completar su
// ruta original (ENGLISH o STEPS2), recibe su reporte parcial normalmente, y DESPUÉS
// Diana le da acceso manual a continuar por la ruta OET (edita a mano assigned_route /
// oet_unlocked en unlock_state y vuelve a poner attempts.status en 'in_progress' para
// que get-unlock-state lo mande a oet-listening.html). Cuando ese estudiante termina
// oet_listening + oet_reading + oet_writing, checkAndMarkAttemptComplete lo vuelve a
// marcar 'completed' y dispara este reporte de nuevo -- pero como partial_report_sent_at
// ya tenía valor del primer envío, el guard de idempotencia lo bloqueaba silenciosamente
// y Diana nunca veía los resultados de OET en ningún reporte parcial.
//
// Fix: se agrega una columna de idempotencia SEPARADA, attempts.oet_partial_report_sent_at
// (migración partial_report_oet_resend_column), que solo se usa cuando la ruta asignada
// en el momento del envío es 'OET'. El guard de idempotencia ahora depende de la ruta:
//   - assigned_route === 'OET'  -> bloquea solo si oet_partial_report_sent_at ya tiene
//     valor (nunca por partial_report_sent_at, aunque ya exista de un envío anterior con
//     otra ruta).
//   - cualquier otra ruta (o null) -> se mantiene el comportamiento de siempre, bloquea
//     por partial_report_sent_at.
// Al enviar con éxito se actualizan AMBAS columnas cuando la ruta es OET (deja
// partial_report_sent_at como "fecha del último envío" y oet_partial_report_sent_at como
// el guard específico de OET); para las demás rutas se sigue actualizando solo
// partial_report_sent_at, como antes. Esto NO afecta el flujo normal de un estudiante que
// entra a OET desde el principio (ahí ambas columnas quedan null hasta el único envío, y
// se setean juntas en ese momento -- ningún comportamiento nuevo para ese caso).
//
// v3 (24/08/2026, pedido de Diana): skillCommentFromBandDetail y los mensajes de STEP CK 2
// estaban redactados en tercera persona ("Alcanzó...", "Aprobó con...") mientras el resto
// del reporte (y ahora también oet_unlock_note, ver submit-response.ts v21) está en tuteo
// -- quedaba una mezcla de tonos dentro del mismo comentario de una destreza. Se pasan a
// segunda persona ("Alcanzaste...", "Aprobaste con...", "No alcanzaste..."), igual criterio
// que v4 de generate-report: nada de lenguaje que no sea directo al estudiante.
//
// v2 (24/08/2026, pedido de Diana): si listening tuvo el rescate de OET por inconsistencia
// de patrón (ver LISTENING_B2_RESCUE_THRESHOLD en submit-response.ts / submit-writing.ts),
// la nota explicativa guardada en sub_scores.band_detail.oet_unlock_note ahora se agrega al
// comentario de Listening en este reporte.
//
// v1 (24/08/2026, pedido de Diana).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

const NOTIFY_EMAIL = "info@speakeasy.lat";
const NOTIFY_FROM = "ClearPath Assessment <notificaciones@speakeasy.lat>";

// --- Branding (mismos tokens que generate-report / css/style.css) --------------
const LOGO_GENERIC_URL = "https://assessment.speakeasy.lat/assets/logo-speakeasy.png";
const LOGO_CLEARPATH_URL = "https://assessment.speakeasy.lat/assets/logo-speakeasy-clearpath.png";

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type QaItem = {
  questionText: string;
  selectedAnswer: string | null;
  correctAnswer: string;
  isCorrect: boolean;
};

type WritingCorrection = {
  error: string;
  correccion: string;
  explicacion: string;
};

type WritingDimension = {
  label: string;
  text: string;
};

type WritingTask = {
  title: string;
  essayText: string;
  comment: string;
  correccionesParaB2: WritingCorrection[];
  dimensions: WritingDimension[];
  // v (01/09/2026): OET Writing usa un encabezado distinto para esta lista -- ya no son
  // "correcciones para llegar a B2" (ese umbral es de Nivel 1), son correcciones
  // sugeridas contra los criterios oficiales de OET. Opcional: si no se pasa, se usa el
  // encabezado de siempre (Nivel 1).
  correccionesHeading?: string;
};

function qaItemHtml(qa: QaItem): string {
  const mark = qa.isCorrect ? "✓" : "✗";
  const selected = qa.selectedAnswer && qa.selectedAnswer.trim() ? qa.selectedAnswer : "(sin responder)";
  const answerLine = qa.isCorrect
    ? `<div class="qa-answer">Tu respuesta: <strong>${escapeHtml(selected)}</strong></div>`
    : `<div class="qa-answer">Tu respuesta: <strong>${escapeHtml(selected)}</strong> · Respuesta correcta: <strong>${escapeHtml(qa.correctAnswer)}</strong></div>`;
  return `
    <div class="qa-item ${qa.isCorrect ? "correct" : "incorrect"}">
      <div class="qa-question"><span class="qa-mark">${mark}</span>${escapeHtml(qa.questionText)}</div>
      ${answerLine}
    </div>`;
}

function writingCorrectionHtml(c: WritingCorrection): string {
  return `
    <div class="wcorr-item">
      <div class="wcorr-error">"${escapeHtml(c.error)}"</div>
      <div class="wcorr-fix">→ ${escapeHtml(c.correccion)}</div>
      <div class="wcorr-exp">${escapeHtml(c.explicacion)}</div>
    </div>`;
}

function writingTaskHtml(t: WritingTask): string {
  // v (01/09/2026, pedido de Diana): agrega la evaluación por criterio (las 6
  // "dimensions" que ya calcula submit-writing pero que ningún reporte mostraba antes).
  const dimensionsHtml =
    t.dimensions && t.dimensions.length > 0
      ? `
      <div class="skill-bullets">
        <div class="skill-bullets-heading">Evaluación por criterio</div>
        <ul>${t.dimensions.map((d) => `<li><strong>${escapeHtml(d.label)}:</strong> ${escapeHtml(d.text)}</li>`).join("")}</ul>
      </div>`
      : "";
  const correccionesHtml =
    t.correccionesParaB2 && t.correccionesParaB2.length > 0
      ? `
      <div class="wcorr-block">
        <div class="wcorr-heading">${escapeHtml(t.correccionesHeading || "Correcciones para llegar a B2")}</div>
        ${t.correccionesParaB2.map(writingCorrectionHtml).join("")}
      </div>`
      : "";
  return `
    <div class="writing-task">
      <div class="writing-task-title">${escapeHtml(t.title)}</div>
      <div class="writing-essay">${escapeHtml(t.essayText || "(no se guardó el texto de esta respuesta)")}</div>
      <p class="skill-comment">${escapeHtml(t.comment)}</p>
      ${dimensionsHtml}
      ${correccionesHtml}
    </div>`;
}

function skillRowHtml(s: {
  name: string;
  raw: number | null;
  max: number | null;
  cefr: string | null;
  comment: string;
  flag?: string | null;
  extraNote?: string | null;
  bulletGroups?: Array<{ heading: string; items: string[] }>;
  qaList?: QaItem[];
  writingTasks?: WritingTask[];
}): string {
  const scoreHtml =
    s.raw !== null && s.max !== null
      ? `<span class="skill-score">${s.raw}/${s.max}</span>`
      : "";
  const cefrHtml = s.cefr ? `<span class="skill-cefr">${escapeHtml(s.cefr)}</span>` : "";
  const flagHtml = s.flag ? `<div class="skill-flag">${escapeHtml(s.flag)}</div>` : "";
  const commentHtml = s.comment ? `<p class="skill-comment">${escapeHtml(s.comment)}</p>` : "";
  const extraNoteHtml = s.extraNote
    ? `<p class="skill-comment"><strong>Enfoque recomendado:</strong> ${escapeHtml(s.extraNote)}</p>`
    : "";
  const bulletGroupsHtml =
    s.bulletGroups && s.bulletGroups.length
      ? s.bulletGroups
          .filter((g) => g.items.length > 0)
          .map(
            (g) => `
      <div class="skill-bullets">
        <div class="skill-bullets-heading">${escapeHtml(g.heading)}</div>
        <ul>${g.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </div>`,
          )
          .join("\n")
      : "";
  const writingTasksHtml = s.writingTasks && s.writingTasks.length
    ? s.writingTasks.map(writingTaskHtml).join("\n")
    : "";
  const qaHtml = s.qaList && s.qaList.length
    ? `<div class="qa-list">${s.qaList.map(qaItemHtml).join("\n")}</div>`
    : "";
  return `
    <div class="skill-row">
      <div class="skill-row-header">
        <span class="skill-name">${escapeHtml(s.name)}</span>
        ${scoreHtml}
        ${cefrHtml}
      </div>
      ${commentHtml}
      ${extraNoteHtml}
      ${flagHtml}
      ${bulletGroupsHtml}
      ${writingTasksHtml}
      ${qaHtml}
    </div>`;
}

function buildReportHtml(params: {
  studentName: string;
  assessmentLabel: string;
  logoUrl: string;
  reportDate: string;
  overallCefr: string | null;
  overallNote: string;
  skillLevels: Array<{ label: string; value: string; note?: string | null }>;
  blocks: Array<{
    title: string;
    skills: Array<{
      name: string;
      raw: number | null;
      max: number | null;
      cefr: string | null;
      comment: string;
      flag?: string | null;
      extraNote?: string | null;
      bulletGroups?: Array<{ heading: string; items: string[] }>;
      qaList?: QaItem[];
      writingTasks?: WritingTask[];
    }>;
  }>;
  isResend?: boolean;
}): string {
  const reportTitle = `Reporte parcial de resultados — ${params.assessmentLabel}`;
  const skillLevelsHtml = params.skillLevels.length
    ? `
  <div class="skill-levels-title">Resultados por destreza</div>
  <div class="skill-levels-grid">
    ${params.skillLevels
      .map(
        (s) => `
    <div class="skill-level-chip">
      <span class="chip-label">${escapeHtml(s.label)}</span>
      <span class="chip-value">${escapeHtml(s.value)}</span>
    </div>`,
      )
      .join("\n")}
  </div>`
    : "";
  const blocksHtml = params.blocks
    .map(
      (block) => `
    <div class="section-title">${escapeHtml(block.title)}</div>
    ${block.skills.map(skillRowHtml).join("\n")}
  `,
    )
    .join("\n");

  // v4 (28/08/2026): cuando este envío es un reenvío tras continuar por la ruta OET
  // (ver nota grande al inicio del archivo), se aclara en el propio PDF que es una
  // versión actualizada -- para que Diana no confunda este archivo con el primer
  // parcial que ya había recibido.
  const resendBannerHtml = params.isResend
    ? `<p class="subtitle"><strong>Este reporte reemplaza al primer parcial:</strong> el estudiante continuó por la ruta OET después de su envío anterior, así que este incluye también esos resultados.</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Quicksand:wght@500;600;700&family=Nunito:wght@400;600;700&display=swap');

  :root {
    --charcoal-dark: #333333;
    --teal: #7fc8ce;
    --teal-dark: #4fa8af;
    --teal-light: #eaf7f8;
    --gray-100: #faf9f7;
    --gray-300: #e2e0dc;
    --gray-600: #767676;
    --bad: #c62828;
    --bad-bg: #fdecea;
    --good: #2e7d32;
    --good-bg: #eaf5ea;
    --amber: #b45309;
    --amber-bg: #fef3e0;
    --radius: 14px;
    --font-heading: 'Quicksand', sans-serif;
    --font-body: 'Nunito', sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--font-body);
    color: var(--charcoal-dark);
    background: #ffffff;
    margin: 0;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 3px solid var(--teal);
    padding-bottom: 16px;
    margin-bottom: 24px;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .header img { height: 52px; }
  .header .meta { text-align: right; font-size: 12.5px; color: var(--gray-600); }
  .header .meta strong {
    color: var(--charcoal-dark);
    font-family: var(--font-heading);
    font-size: 14px;
  }
  h1 {
    font-family: var(--font-heading);
    font-weight: 700;
    font-size: 20px;
    color: var(--charcoal-dark);
    margin: 0 0 4px;
  }
  .subtitle { color: var(--gray-600); font-size: 13px; margin: 0 0 12px; }
  .partial-banner {
    display: inline-block;
    font-family: var(--font-heading);
    font-weight: 700;
    font-size: 11.5px;
    color: var(--amber);
    background: var(--amber-bg);
    border: 1px solid var(--amber);
    padding: 4px 12px;
    border-radius: 999px;
    margin-bottom: 18px;
  }
  .skill-levels-title {
    font-family: var(--font-heading);
    font-weight: 600;
    font-size: 12px;
    color: var(--gray-600);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    margin: 0 0 8px;
  }
  .skill-levels-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 18px;
  }
  .skill-level-chip {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    background: var(--gray-100);
    border: 1px solid var(--gray-300);
    border-radius: 10px;
    padding: 8px 12px;
    min-width: 90px;
  }
  .skill-level-chip .chip-label {
    font-size: 10.5px;
    color: var(--gray-600);
    font-weight: 600;
  }
  .skill-level-chip .chip-value {
    font-family: var(--font-heading);
    font-weight: 700;
    font-size: 14px;
    color: var(--teal-dark);
    white-space: nowrap;
  }
  .skill-level-chip .chip-note {
    font-size: 9.5px;
    color: var(--gray-600);
  }
  .overall-box {
    background: var(--teal-light);
    border: 1px solid var(--teal);
    border-radius: var(--radius);
    padding: 18px 22px;
    display: flex;
    align-items: center;
    gap: 22px;
    margin-bottom: 26px;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .overall-cefr {
    font-family: var(--font-heading);
    font-weight: 700;
    font-size: 32px;
    color: var(--teal-dark);
    line-height: 1;
    white-space: nowrap;
  }
  .overall-text { font-size: 13px; color: var(--charcoal-dark); }
  .overall-text .label {
    font-family: var(--font-heading);
    font-weight: 600;
    font-size: 13px;
    color: var(--charcoal-dark);
    display: block;
    margin-bottom: 3px;
  }
  .section-title {
    font-family: var(--font-heading);
    font-weight: 600;
    font-size: 14px;
    color: var(--charcoal-dark);
    margin: 22px 0 12px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    page-break-after: avoid;
    break-after: avoid;
  }
  .section-title:first-of-type { margin-top: 0; }
  .skill-row {
    border: 1px solid var(--gray-300);
    border-radius: var(--radius);
    padding: 14px 18px;
    margin-bottom: 12px;
    background: var(--gray-100);
  }
  .skill-row-header { display: flex; align-items: baseline; gap: 14px; margin-bottom: 6px; }
  .skill-name {
    font-family: var(--font-heading);
    font-weight: 700;
    font-size: 15px;
    color: var(--charcoal-dark);
    flex: 1;
  }
  .skill-score { font-size: 13px; color: var(--gray-600); font-weight: 600; }
  .skill-cefr {
    font-family: var(--font-heading);
    font-weight: 700;
    font-size: 13px;
    color: #fff;
    background: var(--teal-dark);
    padding: 2px 10px;
    border-radius: 999px;
  }
  .skill-comment { font-size: 12.5px; line-height: 1.5; color: var(--charcoal-dark); margin: 0; }
  .skill-flag {
    display: inline-block;
    margin-top: 8px;
    font-size: 11px;
    font-weight: 700;
    color: var(--bad);
    background: #fdecea;
    border: 1px solid var(--bad);
    padding: 3px 9px;
    border-radius: 999px;
  }
  .skill-bullets { margin-top: 8px; }
  .skill-bullets-heading {
    font-family: var(--font-heading);
    font-weight: 700;
    font-size: 11px;
    color: var(--teal-dark);
    text-transform: uppercase;
    letter-spacing: 0.02em;
    margin: 8px 0 3px;
  }
  .skill-bullets ul { margin: 0; padding-left: 18px; }
  .skill-bullets li {
    font-size: 12px;
    line-height: 1.5;
    color: var(--charcoal-dark);
    margin-bottom: 2px;
  }
  .footer {
    margin-top: 28px;
    padding-top: 14px;
    border-top: 1px solid var(--gray-300);
    font-size: 10.5px;
    color: var(--gray-600);
    text-align: center;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .writing-task { margin-top: 4px; }
  .writing-task + .writing-task {
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px dashed var(--gray-300);
  }
  .writing-task-title {
    font-family: var(--font-heading);
    font-weight: 700;
    font-size: 12.5px;
    color: var(--charcoal-dark);
    margin-bottom: 6px;
  }
  .writing-essay {
    white-space: pre-wrap;
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--charcoal-dark);
    background: #fff;
    border: 1px solid var(--gray-300);
    border-radius: 10px;
    padding: 10px 14px;
    margin-bottom: 8px;
  }
  .wcorr-block {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--gray-300);
  }
  .wcorr-heading {
    font-family: var(--font-heading);
    font-weight: 700;
    font-size: 11.5px;
    color: var(--teal-dark);
    margin-bottom: 6px;
  }
  .wcorr-item {
    border-left: 3px solid var(--teal-dark);
    background: var(--gray-100);
    border-radius: 0 8px 8px 0;
    padding: 6px 10px;
    margin-bottom: 6px;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .wcorr-error { font-size: 11px; color: var(--bad); }
  .wcorr-fix { font-size: 11px; color: var(--good); margin-top: 2px; }
  .wcorr-exp { font-size: 10.5px; color: var(--gray-600); line-height: 1.4; margin-top: 3px; }
  .qa-list { margin-top: 10px; }
  .qa-item {
    font-size: 11.5px;
    line-height: 1.45;
    border-radius: 8px;
    padding: 7px 10px;
    margin-bottom: 6px;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .qa-item.correct { background: var(--good-bg); }
  .qa-item.incorrect { background: var(--bad-bg); }
  .qa-question { font-weight: 600; }
  .qa-mark { display: inline-block; width: 14px; }
  .qa-item.correct .qa-mark { color: var(--good); }
  .qa-item.incorrect .qa-mark { color: var(--bad); }
  .qa-answer { color: var(--gray-600); margin-top: 2px; }
  .qa-answer strong { color: var(--charcoal-dark); }
</style>
</head>
<body>
  <div class="header">
    <img src="${params.logoUrl}" alt="Speak Easy">
    <div class="meta">
      <strong>${escapeHtml(params.studentName)}</strong><br>
      ${escapeHtml(params.assessmentLabel)}<br>
      Fecha: ${escapeHtml(params.reportDate)}
    </div>
  </div>

  <h1>${escapeHtml(reportTitle)}</h1>
  <div class="partial-banner">Parcial — falta Speaking</div>
  <p class="subtitle">Detalle de desempeño hasta la parte escrita. El Speaking Assessment todavía está pendiente y se agrega al reporte final.</p>
  ${resendBannerHtml}

  ${skillLevelsHtml}

  <div class="overall-box">
    <div class="overall-cefr">${params.overallCefr ? escapeHtml(params.overallCefr) : "—"}</div>
    <div class="overall-text">
      <span class="label">Nivel funcional (parcial)</span>
      ${escapeHtml(params.overallNote)}
    </div>
  </div>

  ${blocksHtml}

  <div class="footer">
    ${escapeHtml(params.assessmentLabel)} · Speak Easy Online · Reporte parcial generado automáticamente
  </div>
</body>
</html>`;
}

const CEFR_ORDER = ["A1", "A2", "B1", "B2", "C1"];

// v9 de generate-report: rangos oficiales de puntaje OET (escala 0-500, vigente desde
// septiembre 2018) por grade. Verificados el 21/08/2026 contra geniusclass.co.uk/oet-calculator.
const OET_GRADE_RANGES: Record<string, string> = {
  "A": "450–500",
  "B": "350–440",
  "C+": "300–340",
  "C": "200–290",
  "D": "100–190",
  "E": "0–90",
};

function oetRangeFromPercent(percent: number): { grade: string; range: string } {
  const score = Math.round(percent * 5);
  if (score >= 450) return { grade: "A", range: OET_GRADE_RANGES["A"] };
  if (score >= 350) return { grade: "B", range: OET_GRADE_RANGES["B"] };
  if (score >= 300) return { grade: "C+", range: OET_GRADE_RANGES["C+"] };
  if (score >= 200) return { grade: "C", range: OET_GRADE_RANGES["C"] };
  if (score >= 100) return { grade: "D", range: OET_GRADE_RANGES["D"] };
  return { grade: "E", range: OET_GRADE_RANGES["E"] };
}

const CEFR_TO_OET_RANGE_APPROX: Record<string, { grade: string; range: string }> = {
  "C1": { grade: "B", range: OET_GRADE_RANGES["B"] },
  "B2": { grade: "C+", range: OET_GRADE_RANGES["C+"] },
  "B1": { grade: "D", range: OET_GRADE_RANGES["D"] },
  "A2": { grade: "E", range: OET_GRADE_RANGES["E"] },
  "A1": { grade: "E", range: OET_GRADE_RANGES["E"] },
};
function oetRangeFromCefrApprox(cefr: string | null): { grade: string; range: string } | null {
  if (!cefr) return null;
  return CEFR_TO_OET_RANGE_APPROX[cefr] || null;
}

// v (01/09/2026, pedido de Diana): desde submit-writing.ts v21, oet_writing guarda
// overall_grade + overall_score_500 (A/B/C+/C/D/E sobre 0-500, ya calculados en el
// servidor contra los 6 criterios oficiales de OET -- ver parseOetWritingGrading). Este
// es el dato real y debe preferirse siempre que exista; solo se cae a la aproximación
// vieja (oetRangeFromCefrApprox sobre el placeholder cefr_estimate) para submissions de
// antes de este cambio. Se usa tanto en la tarjeta de la tarea como en el chip de
// skillLevels del encabezado -- una sola función para no repetir la lógica dos veces.
function oetWritingGradeBadgeFromSubs(subs: any[]): string | null {
  const withGrade = (subs || []).find((w) => w?.ai_rubric_scores && typeof w.ai_rubric_scores.overall_grade === "string");
  if (!withGrade) return null;
  const grade = withGrade.ai_rubric_scores.overall_grade;
  const scaled = withGrade.ai_rubric_scores.overall_score_500;
  return typeof scaled === "number" ? `${grade} (${scaled}/500)` : grade;
}

// v3 (24/08/2026, pedido de Diana): antes decía "Alcanzó..." (tercera persona) -- pasa a
// "Alcanzaste..." para que coincida con el tono tuteo del resto del reporte (y del
// oet_unlock_note que se le agrega a continuación cuando aplica, ver más abajo).
function skillCommentFromBandDetail(skillName: string, raw: number, max: number, cefr: string | null): string {
  if (!cefr) {
    return `No se pudo determinar un nivel CEFR a partir de tus respuestas guardadas en ${skillName}.`;
  }
  return `Alcanzaste nivel ${cefr} en ${skillName} (${raw}/${max} respuestas correctas).`;
}

function writingCommentFromRubric(promptTitle: string, rubric: any, cefr: string | null): string {
  if (!rubric) {
    return `Sin calificación disponible para "${promptTitle}".`;
  }
  if (rubric.grading_failed) {
    return `Resultado de "${promptTitle}" pendiente de confirmación.`;
  }
  const overall = typeof rubric.overall_comment === "string" ? rubric.overall_comment : "";
  return overall || `Nivel estimado: ${cefr || "no determinado"}.`;
}

// v (01/09/2026, pedido de Diana): antes solo se leía "overall_comment" del rubric de
// Writing -- las 6 evaluaciones por criterio que la IA ya calcula en "dimensions"
// (desarrollo del tema, claridad de propósito, organización, control del lenguaje,
// precisión, rango; ver submit-writing.ts) se descartaban sin mostrarse en ningún
// reporte. Este helper las expone como "Evaluación por criterio" en la tarjeta de cada
// tarea de writing (Nivel 1 y, desde ahora, también OET).
const WRITING_DIMENSION_LABELS: Record<string, string> = {
  topic_development: "Desarrollo del tema",
  clarity_of_purpose: "Claridad de propósito",
  organization: "Organización",
  language_control: "Control del lenguaje",
  accuracy: "Precisión",
  range: "Rango",
  // v (01/09/2026, pedido de Diana): OET Writing ya no comparte el rubric CEFR de
  // arriba -- desde submit-writing.ts v21 se califica contra los 6 criterios oficiales
  // de OET (Purpose/Content/Conciseness & Clarity/Genre & Style/Organisation &
  // Layout/Language). Mismos nombres de key que usa parseOetWritingGrading allá.
  purpose: "Propósito",
  content: "Contenido",
  conciseness_clarity: "Concisión y claridad",
  genre_style: "Género y estilo",
  organisation_layout: "Organización y presentación",
  language: "Lenguaje",
};

function writingDimensionsFromRubric(rubric: any): WritingDimension[] {
  const dims = rubric?.dimensions;
  if (!dims || typeof dims !== "object") return [];
  return Object.entries(WRITING_DIMENSION_LABELS)
    .map(([key, label]) => {
      const text = dims[key];
      return typeof text === "string" && text.trim() ? { label, text } : null;
    })
    .filter((d): d is WritingDimension => d !== null);
}

async function htmlToPdf(html: string): Promise<Uint8Array> {
  const apiKey = Deno.env.get("PDFSHIFT_API_KEY");
  if (!apiKey) {
    throw new Error("Falta el secret PDFSHIFT_API_KEY en Supabase.");
  }
  const res = await fetch("https://api.pdfshift.io/v3/convert/pdf", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(`api:${apiKey}`)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: html,
      landscape: false,
      use_print: false,
      margin: { top: "30px", right: "35px", bottom: "30px", left: "35px" },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`PDFShift respondió ${res.status}: ${errText.slice(0, 500)}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

// --- Google Drive (opcional) -----------------------------------------------------
//
// Requiere 2 secrets en Supabase (Project Settings > Edge Functions > Secrets):
//   GOOGLE_SERVICE_ACCOUNT_JSON: el contenido completo del JSON de la cuenta de
//     servicio (client_email + private_key), tal cual lo descarga Google Cloud Console.
//   GOOGLE_DRIVE_FOLDER_ID: el ID de la carpeta de Drive (de la URL de la carpeta),
//     que debe estar COMPARTIDA como Editor con el client_email de la cuenta de
//     servicio -- si no, Drive devuelve 404/403 al intentar escribir ahí.
//
// Mientras estos 2 secrets no existan, uploadPdfToDrive() se auto-omite sin romper el
// envío del correo -- se activa solo, sin redeploy, en cuanto Diana los cargue.
async function getGoogleAccessToken(serviceAccountJson: string): Promise<string> {
  const creds = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  // v2 (24/08/2026, bug real encontrado en la primera prueba con Diana): las service
  // accounts NO tienen cuota de almacenamiento propia -- Drive devuelve 403
  // ("Service Accounts do not have storage quota") al intentar crear un archivo en una
  // carpeta compartida como Editor, por mas permiso de escritura que tenga. La solucion
  // es domain-wide delegation: la service account se hace pasar por un usuario real del
  // Workspace (Diana) via el claim "sub" del JWT -- asi el archivo se crea COMO ella y
  // cuenta contra su propia cuota. Esto requiere que Diana (super admin del Workspace)
  // autorice el Client ID de esta service account en admin.google.com > Seguridad >
  // Controles de API > Delegacion a nivel de dominio, con el scope de drive.file.
  // El secret GOOGLE_IMPERSONATE_EMAIL es opcional -- si no esta, cae a NOTIFY_EMAIL
  // (info@speakeasy.lat, la misma cuenta dueña de la carpeta).
  const impersonateEmail = Deno.env.get("GOOGLE_IMPERSONATE_EMAIL") || NOTIFY_EMAIL;
  const claimSet = {
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/drive.file",
    aud: "https://oauth2.googleapis.com/token",
    sub: impersonateEmail,
    exp: now + 3600,
    iat: now,
  };
  const encoder = new TextEncoder();
  const base64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const headerB64 = base64url(encoder.encode(JSON.stringify(header)));
  const claimB64 = base64url(encoder.encode(JSON.stringify(claimSet)));
  const signingInput = `${headerB64}.${claimB64}`;

  const pemBody = String(creds.private_key)
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binaryDer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    encoder.encode(signingInput),
  );
  const sigB64 = base64url(new Uint8Array(signature));
  const jwt = `${signingInput}.${sigB64}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google token endpoint respondió ${res.status}: ${errText.slice(0, 400)}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function uploadPdfToDrive(
  pdfBytes: Uint8Array,
  fileName: string,
): Promise<{ uploaded: boolean; reason?: string; fileId?: string; webViewLink?: string }> {
  const serviceAccountJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  const folderId = Deno.env.get("GOOGLE_DRIVE_FOLDER_ID");
  if (!serviceAccountJson || !folderId) {
    return { uploaded: false, reason: "Drive no configurado todavía (faltan los secrets)" };
  }
  try {
    const accessToken = await getGoogleAccessToken(serviceAccountJson);
    const metadata = { name: fileName, parents: [folderId] };
    const boundary = "reportboundary" + crypto.randomUUID().replace(/-/g, "");
    const encoder = new TextEncoder();
    const pre = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`;
    const post = `\r\n--${boundary}--`;
    const body = concatBytes([encoder.encode(pre), pdfBytes, encoder.encode(post)]);

    const res = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body,
      },
    );
    if (!res.ok) {
      const errText = await res.text();
      return { uploaded: false, reason: `Drive API respondió ${res.status}: ${errText.slice(0, 400)}` };
    }
    const data = await res.json();
    return { uploaded: true, fileId: data.id, webViewLink: data.webViewLink };
  } catch (err) {
    return { uploaded: false, reason: String(err) };
  }
}

async function sendPartialReportEmail(params: {
  studentName: string;
  assessmentLabel: string;
  pdfBytes: Uint8Array;
  fileName: string;
  driveLink?: string | null;
  isResend?: boolean;
}) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    throw new Error("Falta el secret RESEND_API_KEY en Supabase.");
  }
  const driveLine = params.driveLink ? `\n\nTambién se subió a Drive: ${params.driveLink}` : "";
  // v4 (28/08/2026): si es un reenvío por continuación a la ruta OET, se aclara en el
  // asunto y el cuerpo del correo -- ver nota grande al inicio del archivo.
  const subjectPrefix = params.isResend ? "Reporte PARCIAL ACTUALIZADO (ruta OET)" : "Reporte PARCIAL (antes de Speaking)";
  const bodyIntro = params.isResend
    ? `Adjunto el reporte PARCIAL ACTUALIZADO de resultados de ${params.studentName} (${params.assessmentLabel}). Este estudiante ya había recibido un primer reporte parcial, pero continuó por la ruta OET después de ese envío -- este reporte reemplaza al anterior e incluye también esos resultados.`
    : `Adjunto el reporte PARCIAL de resultados de ${params.studentName} (${params.assessmentLabel}), generado automáticamente al terminar la parte escrita del assessment.`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: NOTIFY_FROM,
      to: [NOTIFY_EMAIL],
      subject: `${subjectPrefix}: ${params.studentName} (${params.assessmentLabel})`,
      text: `${bodyIntro} Todavía falta el Speaking Assessment -- cuando se cargue, sale el reporte final completo por separado.${driveLine}`,
      attachments: [
        {
          filename: params.fileName,
          content: bytesToBase64(params.pdfBytes),
        },
      ],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend respondió ${res.status}: ${errText.slice(0, 500)}`);
  }
}

async function buildAndSendPartialReport(
  supabase: ReturnType<typeof createClient>,
  attemptId: string,
): Promise<{ sent: boolean; reason?: string }> {
  const { data: attempt, error: attemptError } = await supabase
    .from("attempts")
    .select("id, track, status, partial_report_sent_at, oet_partial_report_sent_at, student_id")
    .eq("id", attemptId)
    .maybeSingle();

  if (attemptError || !attempt) {
    return { sent: false, reason: "attempt no encontrado" };
  }
  // El attempt pasa a 'completed' exactamente cuando termina la parte escrita (Nivel 1
  // + STEP CK 2 / OET si corresponde) -- ver checkAndMarkAttemptComplete. Ese chequeo
  // ya contempla las 3 rutas, así que acá alcanza con leer el status.
  if (attempt.status !== "completed") {
    return { sent: false, reason: "todavía no terminó la parte escrita del assessment" };
  }

  // v4 (28/08/2026): hay que conocer la ruta ANTES de aplicar el guard de idempotencia,
  // porque el guard depende de la ruta -- ver la nota grande al inicio del archivo.
  const { data: unlock } = await supabase
    .from("unlock_state")
    .select("assigned_route")
    .eq("attempt_id", attemptId)
    .maybeSingle();

  const assignedRoute = unlock ? unlock.assigned_route : null;
  const isOetRoute = assignedRoute === "OET";

  // Guard de idempotencia por ruta (v4, 28/08/2026):
  //   - Ruta OET: bloquea solo si YA se mandó un reporte parcial con la ruta OET
  //     completa (oet_partial_report_sent_at). Un envío previo con otra ruta
  //     (partial_report_sent_at) NO bloquea -- ese es justamente el caso que se quiere
  //     permitir: Diana le dio acceso a continuar a OET después del primer parcial.
  //   - Cualquier otra ruta (o null, todavía sin asignar): comportamiento de siempre,
  //     bloquea por partial_report_sent_at.
  const isResend = isOetRoute && !!attempt.partial_report_sent_at && !attempt.oet_partial_report_sent_at;
  if (isOetRoute) {
    if (attempt.oet_partial_report_sent_at) {
      return { sent: false, reason: "ya se había enviado el reporte parcial de la ruta OET" };
    }
  } else if (attempt.partial_report_sent_at) {
    return { sent: false, reason: "ya se había enviado antes" };
  }

  const track = attempt.track === "NIVEL1_ONLY" ? "NIVEL1_ONLY" : "FULL_360";

  const { data: student, error: studentError } = await supabase
    .from("students")
    .select("full_name, email")
    .eq("id", attempt.student_id)
    .maybeSingle();

  if (studentError || !student) {
    return { sent: false, reason: "student no encontrado" };
  }

  const { data: subScores, error: subScoresError } = await supabase
    .from("sub_scores")
    .select("skill, raw_score, max_score, cefr_estimate, band_detail")
    .eq("attempt_id", attemptId);

  if (subScoresError) {
    return { sent: false, reason: "error leyendo sub_scores" };
  }
  const byskill = Object.fromEntries((subScores || []).map((s: any) => [s.skill, s]));
  // v5 (28/08/2026, pedido de Diana): orden fijo de destrezas dentro del bloque Nivel 1,
  // igual que antes -- grammar, listening, reading, writing (writing había quedado antes
  // de reading por error).
  const nivel1Skills = ["grammar", "listening", "reading", "writing"];
  const nivel1Complete = nivel1Skills.every((sk) => byskill[sk]);

  if (!nivel1Complete) {
    return { sent: false, reason: "Nivel 1 todavía no está completo" };
  }

  const skillLabels: Record<string, string> = {
    grammar: "Grammar",
    listening: "Listening",
    reading: "Reading",
    writing: "Writing",
    steps2_reading: "STEP CK 2",
    oet_listening: "OET Listening",
    oet_reading: "OET Reading",
    oet_writing: "OET Writing",
  };

  // v (01/09/2026): se agrega "module" al join -- hace falta para separar el ensayo de
  // Nivel 1 (nivel1_writing) del de OET (oet_writing) más abajo. Antes esta consulta no
  // lo traía y el bloque de Nivel 1 mostraba TODAS las writing_submissions del attempt
  // sin filtrar, mezclando el ensayo de OET bajo "Writing" (Nivel 1).
  const { data: writingSubs } = await supabase
    .from("writing_submissions")
    .select("prompt_id, response_text, ai_rubric_scores, cefr_estimate, writing_prompts(title, module)")
    .eq("attempt_id", attemptId);

  const RESPONSE_MODULE_TO_SKILL: Record<string, string> = {
    nivel1_grammar: "grammar",
    nivel1_listening: "listening",
    nivel1_listening_general: "listening",
    nivel1_reading: "reading",
    nivel1_reading_general: "reading",
    steps2: "steps2_reading",
    oet_listening: "oet_listening",
    oet_reading: "oet_reading",
  };

  const { data: responseRows } = await supabase
    .from("student_responses")
    .select("selected_answer, is_correct, question_bank(module, position, question_text, correct_answer)")
    .eq("attempt_id", attemptId);

  const qaBySkill: Record<string, Array<QaItem & { position: number }>> = {};
  for (const r of (responseRows || []) as any[]) {
    const qb = r.question_bank;
    if (!qb) continue;
    const skill = RESPONSE_MODULE_TO_SKILL[qb.module];
    if (!skill) continue;
    if (!qaBySkill[skill]) qaBySkill[skill] = [];
    qaBySkill[skill].push({
      position: qb.position ?? 0,
      questionText: qb.question_text,
      selectedAnswer: r.selected_answer,
      correctAnswer: qb.correct_answer,
      isCorrect: r.is_correct === true,
    });
  }
  for (const skill of Object.keys(qaBySkill)) {
    qaBySkill[skill].sort((a, b) => a.position - b.position);
  }

  const nivel1Block = {
    title: "Nivel 1",
    skills: nivel1Skills.map((sk) => {
      const row = byskill[sk];
      if (sk === "writing") {
        // v (01/09/2026): filtra a nivel1_writing -- antes tomaba TODAS las
        // writing_submissions del attempt sin filtrar por módulo, así que el ensayo de
        // OET Writing (para un estudiante en esa ruta) aparecía mezclado acá, bajo
        // "Writing" (Nivel 1). oet_writing arma su propia tarjeta más abajo, dentro del
        // bloque OET.
        const subs = (writingSubs || []).filter((w: any) => w && w.writing_prompts?.module === "nivel1_writing");
        if (subs.length > 0) {
          const writingTasks: WritingTask[] = subs.map((w: any) => {
            const title = w.writing_prompts?.title || "Tarea";
            const correcciones = Array.isArray(w.ai_rubric_scores?.correcciones_para_b2)
              ? (w.ai_rubric_scores.correcciones_para_b2 as any[]).filter(
                  (c) => c && typeof c.error === "string" && typeof c.correccion === "string",
                )
              : [];
            return {
              title,
              essayText: w.response_text || "",
              comment: writingCommentFromRubric(title, w.ai_rubric_scores, w.cefr_estimate),
              correccionesParaB2: correcciones,
              dimensions: writingDimensionsFromRubric(w.ai_rubric_scores),
            };
          });
          return {
            name: skillLabels[sk],
            raw: row.raw_score,
            max: row.max_score,
            cefr: row.cefr_estimate,
            comment: "",
            writingTasks,
          };
        }
      }
      // v6 (31/08/2026, pedido de Diana): la nota de rescate OET
      // (band_detail.oet_unlock_note) ya no es exclusiva de listening -- desde
      // submit-response.ts v21 puede venir de grammar, listening o reading (ver
      // highestPassingBand allá). Antes esta línea la mostraba solo cuando
      // sk === "listening", así que un rescate en grammar o reading quedaba calculado
      // pero invisible en el reporte.
      const baseComment = skillCommentFromBandDetail(skillLabels[sk], row.raw_score, row.max_score, row.cefr_estimate);
      const oetUnlockNote = row.band_detail?.oet_unlock_note || null;
      const comment = oetUnlockNote ? `${baseComment} ${oetUnlockNote}` : baseComment;
      return {
        name: skillLabels[sk],
        raw: row.raw_score,
        max: row.max_score,
        cefr: row.cefr_estimate,
        comment,
        qaList: qaBySkill[sk] || [],
      };
    }),
  };

  const blocks = [nivel1Block];

  if (track === "FULL_360") {
    if (assignedRoute === "STEPS2") {
      const row = byskill["steps2_reading"];
      if (row) {
        const passed = row.band_detail?.passed === true;
        blocks.push({
          title: "STEP CK 2",
          skills: [
            {
              name: "STEP CK 2 Reading",
              raw: row.raw_score,
              max: row.max_score,
              cefr: null,
              comment: passed
                ? `Aprobaste con ${row.band_detail.percent}% (umbral mínimo ${row.band_detail.threshold}%).`
                : `No alcanzaste el umbral mínimo: ${row.band_detail.percent}% (se requiere ${row.band_detail.threshold}%).`,
              qaList: qaBySkill["steps2_reading"] || [],
            },
          ],
        });
      }
    } else if (assignedRoute === "OET") {
      const oetSkills = ["oet_listening", "oet_reading", "oet_writing"];
      if (oetSkills.every((sk) => byskill[sk])) {
        // v (01/09/2026, pedido de Diana): oet_writing es una tarea de escritura, no
        // opción múltiple -- antes se armaba con el mismo template que
        // oet_listening/oet_reading ("Resultado informativo: X% de respuestas
        // correctas"), así que nunca se veía el ensayo, el comentario de la IA, la
        // evaluación por criterio ni las correcciones para B2 (quedaba, además, un
        // qaList vacío porque oet_writing no tiene preguntas de opción múltiple). Se le
        // da el mismo tratamiento que ya tiene Writing de Nivel 1 más arriba.
        const oetWritingSubs = (writingSubs || []).filter(
          (w: any) => w && w.writing_prompts?.module === "oet_writing",
        );
        // v (01/09/2026, pedido de Diana): sub_scores.cefr_estimate para oet_writing es
        // SOLO un placeholder técnico (ver oetWritingPlaceholderCefr en
        // submit-writing.ts), nunca el dato real -- el badge de esta tarjeta debe
        // mostrar el overall_grade real (ver oetWritingGradeBadgeFromSubs arriba).
        const oetWritingGradeBadge = oetWritingGradeBadgeFromSubs(oetWritingSubs);
        blocks.push({
          title: "OET",
          skills: oetSkills.map((sk) => {
            const row = byskill[sk];
            if (sk === "oet_writing" && oetWritingSubs.length > 0) {
              const writingTasks: WritingTask[] = oetWritingSubs.map((w: any) => {
                const title = w.writing_prompts?.title || "OET Writing";
                const correcciones = Array.isArray(w.ai_rubric_scores?.correcciones_para_b2)
                  ? (w.ai_rubric_scores.correcciones_para_b2 as any[]).filter(
                      (c) => c && typeof c.error === "string" && typeof c.correccion === "string",
                    )
                  : [];
                return {
                  title,
                  essayText: w.response_text || "",
                  comment: writingCommentFromRubric(title, w.ai_rubric_scores, w.cefr_estimate),
                  correccionesParaB2: correcciones,
                  dimensions: writingDimensionsFromRubric(w.ai_rubric_scores),
                  correccionesHeading: "Correcciones sugeridas",
                };
              });
              return {
                name: skillLabels[sk],
                raw: row.raw_score,
                max: row.max_score,
                cefr: oetWritingGradeBadge || row.cefr_estimate,
                comment: "",
                writingTasks,
              };
            }
            return {
              name: skillLabels[sk],
              raw: row.raw_score,
              max: row.max_score,
              cefr: null,
              comment: `Resultado informativo: ${row.band_detail?.percent ?? Math.round((row.raw_score / row.max_score) * 100)}% de respuestas correctas.`,
              qaList: qaBySkill[sk] || [],
            };
          }),
        });
      }
    }
  }

  const skillLevels: Array<{ label: string; value: string; note?: string | null }> = [];
  for (const sk of nivel1Skills) {
    const row = byskill[sk];
    skillLevels.push({ label: skillLabels[sk], value: row?.cefr_estimate || "—" });
  }

  if (track === "FULL_360" && assignedRoute === "OET") {
    for (const sk of ["oet_listening", "oet_reading"]) {
      const row = byskill[sk];
      if (!row) continue;
      const percent = row.band_detail?.percent ?? Math.round((row.raw_score / row.max_score) * 100);
      const band = oetRangeFromPercent(percent);
      skillLevels.push({
        label: skillLabels[sk],
        value: `${band.grade} (${band.range})`,
        note: "puntaje OET aproximado",
      });
    }
    const writingRow = byskill["oet_writing"];
    if (writingRow) {
      // v (01/09/2026): preferir el overall_grade real (ver oetWritingGradeBadgeFromSubs)
      // sobre la aproximación CEFR vieja, que solo se conserva como fallback para
      // submissions de antes de este cambio.
      const realBadge = oetWritingGradeBadgeFromSubs(
        (writingSubs || []).filter((w: any) => w && w.writing_prompts?.module === "oet_writing"),
      );
      const band = oetRangeFromCefrApprox(writingRow.cefr_estimate);
      skillLevels.push({
        label: "OET Writing",
        value: realBadge || (band ? `${band.grade} (${band.range})` : (writingRow.cefr_estimate || "—")),
        note: realBadge ? "puntaje OET real, calculado a partir de los 6 criterios oficiales" : "puntaje OET aproximado",
      });
    }
  }

  if (track === "FULL_360" && assignedRoute === "STEPS2") {
    const row = byskill["steps2_reading"];
    if (row) {
      const percent = row.band_detail?.percent ?? Math.round((row.raw_score / row.max_score) * 100);
      skillLevels.push({ label: "STEP CK 2", value: `${percent}%` });
    }
  }

  const nivel1CefrsSorted = nivel1Skills
    .map((sk) => byskill[sk]?.cefr_estimate)
    .filter(Boolean)
    .sort((a: string, b: string) => CEFR_ORDER.indexOf(a) - CEFR_ORDER.indexOf(b)) as string[];
  const lowestCefr = nivel1CefrsSorted[0] ?? null;
  const secondLowestCefr = nivel1CefrsSorted[1] ?? null;
  const overallCefr = !lowestCefr
    ? null
    : secondLowestCefr && secondLowestCefr !== lowestCefr
      ? `${lowestCefr}-${secondLowestCefr}`
      : lowestCefr;
  const otherScalesNote =
    track === "FULL_360" && (assignedRoute === "OET" || assignedRoute === "STEPS2")
      ? " OET y STEP CK 2 se reportan aparte, con su propia escala."
      : "";
  const overallNote = !lowestCefr
    ? "Todavía no hay suficientes resultados de Nivel 1 para calcular un nivel funcional."
    : secondLowestCefr && secondLowestCefr !== lowestCefr
      ? `Tu nivel funcional resume tus dos resultados más bajos de Nivel 1 (${lowestCefr} y ${secondLowestCefr}): la destreza más débil es la que limita la comunicación real, aunque tengas otras más altas.${otherScalesNote}`
      : `Tu nivel funcional resume tu resultado más bajo de Nivel 1 (${lowestCefr}): la destreza más débil es la que limita la comunicación real, aunque tengas otras más altas.${otherScalesNote}`;

  const assessmentLabel = track === "NIVEL1_ONLY" ? "Assessment Speak Easy" : "Assessment 360";
  const logoUrl = track === "NIVEL1_ONLY" ? LOGO_GENERIC_URL : LOGO_CLEARPATH_URL;
  const reportDate = new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" });

  const html = buildReportHtml({
    studentName: student.full_name || "Estudiante",
    assessmentLabel,
    logoUrl,
    reportDate,
    overallCefr,
    overallNote,
    skillLevels,
    blocks,
    isResend,
  });

  const pdfBytes = await htmlToPdf(html);
  const fileName = `Reporte parcial - ${(student.full_name || "estudiante").replace(/[^a-zA-Z0-9 ]/g, "")}.pdf`;

  const driveResult = await uploadPdfToDrive(pdfBytes, fileName);
  if (!driveResult.uploaded) {
    console.log(`generate-partial-report: Drive omitido (${driveResult.reason})`);
  }

  await sendPartialReportEmail({
    studentName: student.full_name || "Estudiante",
    assessmentLabel,
    pdfBytes,
    fileName,
    driveLink: driveResult.uploaded ? driveResult.webViewLink : null,
    isResend,
  });

  // v4 (28/08/2026): partial_report_sent_at se actualiza siempre (queda como "fecha del
  // último envío"). oet_partial_report_sent_at SOLO se setea cuando la ruta es OET -- es
  // el guard específico que permite este reenvío una sola vez, sin volver a bloquear los
  // envíos normales de otras rutas ni permitir un tercer envío para el mismo attempt.
  const nowIso = new Date().toISOString();
  const updatePayload: Record<string, string> = { partial_report_sent_at: nowIso };
  if (isOetRoute) {
    updatePayload.oet_partial_report_sent_at = nowIso;
  }
  await supabase
    .from("attempts")
    .update(updatePayload)
    .eq("id", attemptId);

  return { sent: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Método no permitido." }, 405);
  }

  let body: { attempt_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body inválido." }, 400);
  }

  const attemptId = typeof body.attempt_id === "string" ? body.attempt_id.trim() : "";
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!attemptId || !UUID_RE.test(attemptId)) {
    return json({ error: "Falta o es inválido attempt_id." }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const result = await buildAndSendPartialReport(supabase, attemptId);
    return json(result);
  } catch (err) {
    console.error("generate-partial-report: error generando/enviando reporte parcial", err);
    return json({ error: "Error interno generando el reporte parcial.", detail: String(err) }, 500);
  }
});

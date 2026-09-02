# Lógica de calificación — Assessment 360 / Speak Easy

Última actualización: 02/09/2026. Este documento resume CÓMO se califica cada destreza, cómo se decide la ruta de cada estudiante, y en qué escala se muestra cada resultado. Es un resumen de lectura del código realmente desplegado en Supabase (no del repo de GitHub, que en varios casos está atrasado — ver la sección "Dónde vive cada cosa" al final).

## 1. Tracks y rutas — el mapa general

Un `attempt` tiene un `track` (fijo desde que el estudiante se registra) y, dentro de FULL_360, una `assigned_route` que se calcula sola al terminar Nivel 1.

- **`NIVEL1_ONLY`** ("Assessment Speak Easy", no clínico): rinde Nivel 1 (Grammar, Listening, Writing, Reading, con contenido NO clínico) y después un Speaking breve tipo English. Nunca pasa por STEPS2 ni por OET, sin importar el resultado.
- **`FULL_360`**: rinde Nivel 1 (con contenido clínico) y, según el resultado, cae en una de tres rutas:
  - **OET** — Listening + Reading + Writing de OET, y al final OET Speaking.
  - **STEPS2** — un módulo de lectura (STEP CK 2) y al final un Speaking tipo English.
  - **ENGLISH** — directo a un Speaking tipo English.

La decisión de ruta ocurre en `recomputeRouteAndPersist()`, duplicada byte a byte en `submit-response.ts` y `submit-writing.ts` (cualquiera de los dos puede ser el que complete el 4to sub_score de Nivel 1) — **hay que mantener los dos sincronizados**.

## 2. Nivel 1 — Grammar, Listening, Reading (multiple choice / note-completion)

Preguntas en `question_bank`, cada una con un `cefr_level` (A1/A2/B1/B2/C1). Corrección server-side en `submit-response.ts` (el navegador nunca ve `correct_answer`):

- **`multiple_choice`**: la respuesta debe matchear `correct_answer` (normalizado: minúsculas, espacios colapsados).
- **`note_completion`**: matchea contra cualquiera de `accepted_answers` (ej. "4" y "four" son ambas válidas).

**Algoritmo de "ceiling" CEFR** (`computeCeiling`, idéntico en `js/scoring.js` para la vista previa client-side):
1. Se agrupan las preguntas del módulo por banda (A1→C1) y se calcula el % de aciertos por banda.
2. Se recorre A1→A2→B1→B2→C1 en orden. El nivel CEFR asignado (`cefr_estimate`) es la última banda consecutiva donde el % de aciertos fue **≥ 70%** (`PERCENT_THRESHOLD`).
3. Ni bien una banda da menos de 70%, el recorrido se corta ahí — bandas más altas no se miran, aunque se hubiesen contestado bien (por eso "ceiling").

**`pattern_inconsistent`** (solo diagnóstico, nunca cambia el resultado): true si alguna banda POR ENCIMA del ceiling en realidad superó el 70% (ej. aprobó B2 pero falló B1). Diana lo puede auditar en `sub_scores.band_detail`, pero el ceiling y la ruta se calculan siempre automáticamente, sin bloqueo.

**Rescate / "nivel efectivo" para elegibilidad a OET** (`highestPassingBand`, agregado 31/08/2026 — caso Luis Padilla): recorre TODAS las bandas A1-C1 sin cortarse en el primer traspié, y devuelve la más alta que igual superó el 70%. Si es más alto que el ceiling normal, ese nivel "efectivo" (`band_detail.oet_effective_level`) es el que se usa para decidir si abre OET/STEPS2 — **el `cefr_estimate` que se muestra en el reporte NUNCA cambia**, sigue siendo el ceiling de siempre. Se deja una nota (`oet_unlock_note`) visible en el reporte para cualquier destreza que se haya beneficiado de esto.

**Dos bancos según track** (mismo algoritmo, distinto contenido):
- `nivel1_grammar`, `nivel1_listening`, `nivel1_reading` → FULL_360 (temática clínica).
- `nivel1_listening_general`, `nivel1_reading_general` → NIVEL1_ONLY (sin temática clínica). No hay "grammar_general" separado — Grammar es el mismo banco para ambos tracks.
- Reading: 28 preguntas por banco (A1=4, A2=4, B1=4, B2=8, C1=8), timer 25 min.

**Nivel CEFR general mostrado en el reporte**: NO es un solo nivel — es el RANGO entre las 2 destrezas de Nivel 1 con el resultado más bajo (ej. "A1–A2"). Si las dos más bajas coinciden, se muestra un solo nivel.

## 3. Nivel 1 — Writing (rúbrica de IA, CEFR-anchored)

`submit-writing.ts`, módulo `nivel1_writing`. La IA (Claude, vía Anthropic API) recibe un prompt anclado a los descriptores oficiales CEFR y devuelve:
- `placement_band`: entero 0-10 (juicio holístico sobre 6 cualidades: desarrollo del tema, claridad, organización, control del lenguaje, precisión, rango).
- `cefr_estimate`: A1-C1, anclado a los descriptores.
- `dimensions`: 6 oraciones (una por cualidad) — se muestran en el reporte como "Evaluación por criterio".
- `overall_comment`: el único texto que llega al estudiante.
- `correcciones_para_b2`: hasta 7 errores concretos del propio texto, con corrección y explicación (no aplica el tope de palabras sugerido en la consigna como criterio de calificación).

**Regla de frontera B1/B2** (la que decide el ingreso a OET): B2 solo si las 3 son ciertas (formas complejas controladas, errores NO sistemáticos, discurso coherente); si no, B1. **"La duda favorece al estudiante"**: si la IA marca el resultado como borderline entre dos niveles, el código (no la IA) fuerza el nivel ALTO de los dos, y dejó una nota visible en el comentario.

Writing no tiene "banda" como Grammar/Listening/Reading (es un juicio holístico único), así que no participa del rescate de `highestPassingBand` — su "nivel efectivo" para la ruta es directamente su `cefr_estimate`.

## 4. La ruta de FULL_360 — reglas exactas

Se calcula solo cuando existen los 4 sub_scores de Nivel 1 (grammar, listening, writing, reading). Usa el **nivel efectivo** de cada destreza (el rescate de la sección 2, o el `cefr_estimate` normal si no aplicó rescate):

```
countB2Plus = cuántas de las 4 destrezas llegan a B2 o más (nivel efectivo)
allAtLeastFloor = las 4 destrezas están en B1 o más (nivel efectivo) -- ninguna en A1/A2
allFourOk = countB2Plus >= 3 Y allAtLeastFloor

si track == NIVEL1_ONLY:           ruta = ENGLISH (siempre, sin mirar niveles)
si no, si allFourOk:               ruta = OET
si no, si reading (efectivo) >= B2: ruta = STEPS2   ("el reading es la llave de STEPS2")
si no:                              ruta = ENGLISH
```

`allFourOk` cambió el 31/08/2026 (caso Luis Padilla): antes exigía las 4 destrezas en B2+; ahora alcanza con 3 de 4, siempre que la 4ta no sea inferior a B1 (piso `MIN_LEVEL_FLOOR_FOR_OET`) — para que ninguna destreza genuinamente floja (A1/A2) cuele a alguien a OET solo porque las otras tres compensan.

`speaking_assessment_type` (qué botón de agendar Speaking le aparece al estudiante): `"OET"` si la ruta es OET; `"English"` en cualquier otro caso — STEPS2 todavía no tiene su propio Speaking, agenda el mismo English.

## 5. STEPS2 — módulo único, pass/fail

Módulo `steps2` en `question_bank` (sin `cefr_level`, no hay bandas). 16 preguntas de comprensión lectora (gist + vocabulario en contexto, nivel C1-C2 de dificultad) sobre 8 viñetas clínicas — rediseñado el 24/08/2026 (antes eran 8 preguntas de conocimiento médico tipo USMLE, que no medían inglés).

**Aprobación**: `% de aciertos ≥ 75` (`STEPS2_PASS_THRESHOLD`). Simple pass/fail, sin nivel CEFR — se guarda `cefr_estimate: null` y el detalle (`correct`, `total`, `percent`, `passed`) en `band_detail`. No recalcula la ruta (la ruta de Nivel 1 ya quedó fija); solo le sirve a `get-unlock-state` para saber si el estudiante ya lo rindió y mandarlo a Speaking.

## 6. OET Listening y OET Reading — informativo, escala 0-500 aproximada

Módulos `oet_listening` / `oet_reading`. Los estudiantes que llegan acá ya calificaron para OET en Nivel 1, así que estos dos módulos **no tienen banda CEFR ni aprobar/reprobar** — solo se guarda `raw_score`/`max_score` y el % de aciertos (`band_detail.type: "informational"`). No recalculan ruta.

En el reporte, ese % se escala linealmente a la escala oficial OET 0-500 (`oetRangeFromPercent`: `score = percent * 5`) y se muestra el grade (A/B/C+/C/D/E) de esa banda — ver tabla en la sección 8. Esto es una **aproximación explícita** (nuestro banco no está calibrado por IRT como el banco oficial de OET), no un puntaje oficial.

## 7. OET Writing — rúbrica OFICIAL de OET (NUEVO 01/09/2026)

Módulo `oet_writing`. Hasta el 01/09/2026 usaba el MISMO rubric CEFR-anchored que Nivel 1 Writing (sección 3) — Diana lo reportó como un error real (no se estaba evaluando contra los criterios que OET usa de verdad) y se reemplazó por un rubric propio, anclado a los 6 criterios oficiales de OET (fuente: "Writing sub-test: Assessment criteria and level descriptors", documento oficial de OET):

| Criterio | Rango |
|---|---|
| Purpose | 0–3 |
| Content | 0–7 |
| Conciseness & Clarity | 0–7 |
| Genre & Style | 0–7 |
| Organisation & Layout | 0–7 |
| Language | 0–7 |
| **Total máximo** | **38** |

La IA recibe los descriptores oficiales banda por banda (las bandas pares — 2, 4, 6 — "comparten features" de las impares vecinas, no tienen descriptor propio) y devuelve los 6 puntajes + 6 comentarios (uno por criterio, mostrados en el reporte como "Evaluación por criterio") + `overall_comment` + `correcciones_para_b2` (acá tituladas "Correcciones sugeridas", no "para llegar a B2" — ese umbral es de Nivel 1, no aplica a OET).

**El grade final se calcula EN EL SERVIDOR, nunca se confía en lo que devuelva la IA** (mismo criterio que OET Speaking, sección 9):
```
scaled500 = round((suma de los 6 puntajes / 38) * 100 * 5)
grade = A si scaled500>=450, B si >=350, C+ si >=300, C si >=200, D si >=100, si no E
```

**Detalle técnico interno** (nunca mostrado a Diana ni al estudiante): `sub_scores.cefr_estimate` para `oet_writing` sigue existiendo como un placeholder técnico (`oetWritingPlaceholderCefr`, una conversión aproximada por %) — solo para no romper el gate de "módulo completo" que exige un `cefr_estimate` no vacío. El dato real que se usa en todos lados es `ai_rubric_scores.overall_grade` / `overall_score_500`.

**Pendiente sin resolver:** los `oet_writing` calificados ANTES del 01/09/2026 quedaron con el rubric CEFR viejo — no se recalculan solos (se regrabaron a mano, con la rúbrica nueva, los de Ana Castro y Paula Hernández Quiroz el 01-02/09/2026; puede haber otros casos sin identificar).

## 8. Escala OET 0-500 — tabla de grades

Vigente desde sept. 2018 (verificada contra geniusclass.co.uk/oet-calculator), usada en los 4 lugares de arriba/abajo que se expresan en esta escala (Listening/Reading aproximado, Writing real, Speaking real):

| Grade | Rango 0-500 |
|---|---|
| A | 450–500 |
| B | 350–440 |
| C+ | 300–340 |
| C | 200–290 |
| D | 100–190 |
| E | 0–90 |

## 9. Speaking — English vs OET (evaluado en vivo por Diana/Liza, cargado en `admin-speaking-score.html`)

No hay IA acá — Diana (o Liza, mismos permisos) evalúa en vivo y carga el resultado vía `submit-speaking-score`.

**English** (track NIVEL1_ONLY, o rutas STEPS2/ENGLISH de FULL_360):
- `cefr_sublevel`: uno de 12 escalones (A1.1…C1.2), elegido por la evaluadora.
- `cefr_estimate`: se deriva automáticamente cortando el sufijo (ej. "B2.2" → "B2") — nunca se confía en lo que mande el frontend para este campo.
- `pronunciation_checklist`: 17 ítems (1-5 cada uno) del "Reading & Pronunciation Diagnostic Checklist". En el reporte se resumen en 3 grupos neutros (nivel nativo / en desarrollo / a reforzar), no como alertas rojas.
- `pronunciation_notes` + `comment`: texto libre.

**OET** (ruta OET):
- 4 criterios lingüísticos (Intelligibility, Fluency, Appropriateness of Language, Resources of Grammar and Expression), 0-6 cada uno → máx 24.
- 5 criterios de comunicación clínica (Relationship Building, Understanding and Incorporating the Patient's Perspective, Providing Structure, Information Gathering, Information Giving), 0-3 cada uno → máx 15.
- Máx total: 39.
- **`overall_grade` y `overall_score_500` se calculan SIEMPRE en el servidor** (desde 24/08/2026 — antes Diana escribía el grade a mano; el frontend ya no tiene ese campo, solo una vista previa de solo lectura):
  ```
  scaled500 = round((suma de los 9 criterios / 39) * 100 * 5)
  grade = mismos umbrales de la tabla de la sección 8
  ```
- **Importante:** OET no publica la fórmula oficial de conversión de estos 9 criterios a grade (evaluadores certificados usan criterio profesional). Esto es una aproximación explícita, con el mismo método que se usa para Listening/Reading. Sanity check contra el único dato público (grade B ≈ "predominantemente 5/6 lingüístico + 2/3 clínico" = 30/39) da B con esta fórmula.

## 10. Dónde vive cada cosa (código) y estado de sincronía con GitHub

| Pieza | Archivo | Deployado (versión) | ¿En GitHub? |
|---|---|---|---|
| Grammar/Listening/Reading (Nivel 1), STEPS2, OET Listening/Reading, ruteo (1 de 2 copias) | `submit-response.ts` | v33 | Sí, `supabase/functions/submit-response/index.ts` (repo tiene además un `index_5.ts` viejo/duplicado sin limpiar) |
| Writing Nivel 1 y OET (rúbricas + ruteo, 2da copia) | `submit-writing.ts` | v36 | Sí, `supabase/functions/submit-writing/index.ts` (subido 02/09/2026) |
| Speaking (English/OET), grade autocalculado | `submit-speaking-score.ts` | v5 | No está en GitHub |
| Reporte final (post-Speaking) | `generate-report.ts` | v24 | Sí, `supabase/functions/generate-report` (sin extensión ni carpeta — subido 02/09/2026) |
| Reporte parcial (pre-Speaking) | `generate-partial-report.ts` | v11 | Sí, `supabase/functions/generate-partial-report/index.ts` (nuevo, subido 02/09/2026) |
| Vista previa client-side del ceiling CEFR | `js/scoring.js` | — | Sí, debe reflejar exactamente el mismo algoritmo que `submit-response.ts`/`submit-writing.ts` |

**Regla general:** cualquier cambio a la lógica de calificación o de ruteo tiene que aplicarse en `submit-response.ts` Y `submit-writing.ts` a la vez (el ruteo está duplicado en los dos), y lo que afecte el ceiling CEFR también debería reflejarse en `js/scoring.js` si esa vista previa sigue en uso. Antes de tocar algo, comparar `list_edge_functions` (con sus fechas) contra lo que hay en el repo — el código más nuevo suele vivir solo en Supabase.

Ver también, para el detalle histórico completo de cada decisión: `rubrica_y_unlock_oet.md`, `reporte_contenido.md`, `listening_calibracion.md`, `reading_calibracion.md`, `brief_readme_sync.md` (memoria del proyecto).

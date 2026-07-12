// Reintento automático para las llamadas a las Edge Functions de Supabase.
//
// Motivo: en el plan gratuito de Supabase, las funciones "arrancan en frío" tras un
// rato de inactividad. La primera petición (incluido el preflight OPTIONS que manda el
// navegador antes del POST) puede devolver 502/503/504 desde el gateway, o hacer que el
// fetch falle con "Failed to fetch". El estudiante veía "No pudimos conectar con el
// servidor" aunque no era su conexión. Este script reintenta en silencio esas fallas
// transitorias, con backoff, hasta que la función despierta.
//
// - Solo toca peticiones a *.supabase.co. Todo lo demás (data/*.json, assets) pasa igual.
// - Reintenta ante: fallo de red (fetch throw) o status 502/503/504.
// - NO reintenta ante 4xx (esos son errores reales de la petición, no arranque en frío).
// - Las Edge Functions son idempotentes (upserts con onConflict), así que reintentar es
//   seguro y no duplica datos.
// - Se debe incluir ANTES del script de la app en cada página.
(function () {
  if (window.__cpFetchRetryInstalled) return;
  window.__cpFetchRetryInstalled = true;

  const originalFetch = window.fetch.bind(window);
  const RETRY_STATUSES = [502, 503, 504];
  const MAX_RETRIES = 5;
  const BASE_DELAY_MS = 700;

  function isSupabase(url) {
    try {
      return new URL(url, window.location.href).hostname.endsWith('supabase.co');
    } catch (e) {
      return false;
    }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!isSupabase(url)) return originalFetch(input, init);

    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await originalFetch(input, init);
        if (RETRY_STATUSES.indexOf(res.status) !== -1 && attempt < MAX_RETRIES) {
          await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        return res;
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES) {
          await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  };
})();

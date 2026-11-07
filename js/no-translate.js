/* no-translate.js
 * Cargar en el <head> de TODAS las páginas del estudiante:
 *   <meta name="google" content="notranslate">
 *   <script src="js/no-translate.js"></script>
 *
 * 1) Pide al navegador no traducir la página (Chrome, Edge y similares).
 * 2) Si igual detecta traducción activa, muestra un aviso rojo fijo.
 * 3) En welcome.html agrega el aviso previo con instrucciones.
 */
(function () {
  "use strict";

  var root = document.documentElement;

  // 1) Orden de no traducir
  root.setAttribute("translate", "no");
  root.classList.add("notranslate");
  if (!document.querySelector('meta[name="google"][content="notranslate"]')) {
    var m = document.createElement("meta");
    m.name = "google";
    m.content = "notranslate";
    document.head.appendChild(m);
  }

  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  // 2) Detección de traducción activa (Chrome/Edge marcan <html> o insertan <font>)
  function isTranslated() {
    return (
      root.classList.contains("translated-ltr") ||
      root.classList.contains("translated-rtl") ||
      !!document.querySelector("body > .skiptranslate, font[style*='vertical-align: inherit']")
    );
  }

  var banner = null;
  function showBanner() {
    if (banner || !document.body) return;
    banner = document.createElement("div");
    banner.setAttribute("role", "alert");
    banner.className = "notranslate";
    banner.setAttribute("translate", "no");
    banner.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:99999;background:#b3261e;color:#fff;" +
      "padding:12px 16px;font:600 15px/1.4 Montserrat,Aptos,Arial,sans-serif;text-align:center;";
    banner.innerHTML =
      "Tu navegador está traduciendo esta página. Desactiva el traductor " +
      "(icono de traducción en la barra de direcciones &rarr; \"Mostrar original\" y \"Nunca traducir\") " +
      "y recarga. La prueba debe verse y responderse en inglés.";
    document.body.appendChild(banner);
  }
  function hideBanner() {
    if (banner) { banner.remove(); banner = null; }
  }
  function check() { isTranslated() ? showBanner() : hideBanner(); }

  ready(function () {
    check();
    new MutationObserver(check).observe(root, { attributes: true, attributeFilter: ["class", "lang"] });
    new MutationObserver(check).observe(document.body, { childList: true });

    // 3) Aviso en la welcome (solo si la página es welcome*.html)
    if (/welcome[^\/]*\.html$/i.test(location.pathname)) {
      var box = document.createElement("div");
      box.className = "notranslate";
      box.setAttribute("translate", "no");
      box.style.cssText =
        "border:2px solid #14504D;background:#D6EAEF;color:#14504D;border-radius:10px;" +
        "padding:14px 16px;margin:18px 0;font:500 15px/1.5 Montserrat,Aptos,Arial,sans-serif;";
      box.innerHTML =
        "<strong>Importante: desactiva el traductor del navegador.</strong><br>" +
        "Las preguntas están en inglés a propósito y debes responder en inglés. " +
        "Si Chrome, Edge o Safari te ofrece \"Traducir esta página\", elige " +
        "<em>Mostrar original</em> y <em>Nunca traducir inglés</em>. " +
        "Si respondes en español, tendrás que repetir esa parte.";
      var btn = document.getElementById("continueBtn");
      var target = btn ? (btn.closest(".card") || btn) : null;
      if (target && target.parentNode) target.parentNode.insertBefore(box, target);
      else document.body.appendChild(box);
    }
  });
})();

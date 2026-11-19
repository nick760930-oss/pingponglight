/* Translates the static text of index.html. The first script at the end of <body>: the page above is parsed,
   and game.js has not touched it yet. See i18n.js. */
(function () {
  'use strict';
  var I = window.PPLI18N;
  if (!I) return;
  try { I.dom(document.body); } finally { I.shown(); }
})();

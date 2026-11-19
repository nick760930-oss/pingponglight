/* PingPongLight languages: 繁體中文 (the source language), English, 日本語.
   Loaded in <head> after lang-en.js / lang-ja.js and before everything else.

   How it works
   - The Chinese text in the code IS the key ("msgid"). In Chinese nothing is looked up, so the Chinese game is unchanged.
   - TX('第 {n} 關',{n:3})   one string; {name} placeholders are filled from the second argument.
     TXA(['簡單','普通'])     an array of strings, translated once when it is defined.
     TXO({bump:'障礙'})       an object whose values are strings, translated once when it is defined.
     The first argument is always a plain single-quoted literal: tools/i18n.mjs reads the keys from the source text.
   - A key may end in "@@note" to tell two uses of the same Chinese words apart ('離線@@status'); the note is never shown.
   - A translation may be {one:'{n} vote',other:'{n} votes'}: the form is picked from the parameter called n.
   - The language is fixed for the life of the page: changing it saves the choice and reloads.
   - Static text in index.html is translated by PPLI18N.dom() (i18n-dom.js, the first script at the end of <body>):
     every text node / placeholder / aria-label / title whose trimmed text is a key gets replaced.
   - Song, achievement and cosmetic names stay Chinese inside the data (they are ids in places); PPLI18N.song(key),
     .ach(id) and .cos(id) give the fields to show instead, or undefined in Chinese. */
(function () {
  'use strict';
  var PACKS = window.PPLLANG || {};
  var LANGS = [{ id: 'zh', name: '繁體中文', html: 'zh-Hant' }, { id: 'en', name: 'English', html: 'en' }, { id: 'ja', name: '日本語', html: 'ja' }];
  var KEY = 'ppl-lang';
  var ok = function (v) { return LANGS.some(function (l) { return l.id === v; }); };

  function pick() {
    var q = '', dbg = false;
    try { var sp = new URLSearchParams(location.search); q = sp.get('lang') || ''; dbg = sp.get('i18n') === 'debug'; } catch (e) {}
    api.debug = dbg;
    if (ok(q)) { try { localStorage.setItem(KEY, q); } catch (e) {} return q; }   // a link such as /?lang=ja chooses and remembers
    try {
      var s = localStorage.getItem(KEY) || '';
      if (ok(s)) return s;
      // someone who already played before languages existed played in Chinese: keep it until they choose otherwise
      for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i) || ''; if (k !== KEY && (k.indexOf('ppl-') === 0 || k.indexOf('pmb6') === 0)) return 'zh'; }
    } catch (e) {}
    var nl = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
    for (var j = 0; j < nl.length; j++) {
      var x = String(nl[j]).toLowerCase();
      if (x.indexOf('zh') === 0) return 'zh';
      if (x.indexOf('ja') === 0) return 'ja';
      if (x.indexOf('en') === 0) return 'en';
    }
    return 'en';
  }

  var api = { langs: LANGS, debug: false, missing: {} };
  var L = pick();
  if (L !== 'zh' && !PACKS[L]) L = 'zh';   // the language file did not load: stay in the source language rather than show a mix
  var P = L === 'zh' ? null : PACKS[L], U = (P && P.ui) || {};
  var PR; try { PR = new Intl.PluralRules(L === 'zh' ? 'zh-Hant' : L); } catch (e) { PR = { select: function () { return 'other'; } }; }

  function fmt(s, p) {
    if (!p || typeof p !== 'object') return s;
    return s.replace(/\{(\w+)\}/g, function (m, k) { return Object.prototype.hasOwnProperty.call(p, k) ? p[k] : m; });
  }
  function bare(id) { var at = id.lastIndexOf('@@'); return at >= 0 ? id.slice(0, at) : id; }
  function TX(id, p) {
    id = String(id);
    if (!P) return fmt(bare(id), p);
    var v = U[id];
    if (v == null) { api.missing[id] = 1; v = bare(id); return fmt(api.debug ? '⟦' + v + '⟧' : v, p); }
    if (typeof v === 'object') v = v[PR.select(+(p && p.n))] || v.other || '';
    return fmt(v, p);
  }
  function TXA(a) { return a.map(function (s) { return TX(s); }); }
  function TXO(o) { var r = {}; for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = TX(o[k]); return r; }

  var CJK = /[㐀-鿿豈-﫿]/, ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
  function one(s) {   // the translation of a static string, keeping the white space around it; null when there is none
    var k = s.trim();
    if (!k || !CJK.test(k)) return null;
    var v = U[k];
    if (typeof v !== 'string') { api.missing[k] = 1; return api.debug ? s.replace(k, function () { return '⟦' + k + '⟧'; }) : null; }
    return s.replace(k, function () { return v; });
  }
  function dom(root) {
    if (!P || !root) return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT), n;
    while ((n = w.nextNode())) {
      if (n.nodeType === 3) {
        var pn = n.parentNode && n.parentNode.nodeName;
        if (pn === 'SCRIPT' || pn === 'STYLE') continue;
        var t = one(n.nodeValue); if (t != null) n.nodeValue = t;
      } else for (var i = 0; i < ATTRS.length; i++) {
        var a = n.getAttribute(ATTRS[i]); if (a) { var r = one(a); if (r != null) n.setAttribute(ATTRS[i], r); }
      }
    }
  }

  api.lang = L;
  api.t = TX;
  api.dom = dom;
  api.song = function (key) { return P && P.song ? P.song[key] : undefined; };
  api.ach = function (id) { return P && P.ach ? P.ach[id] : undefined; };
  api.cos = function (id) { return P && P.cos ? P.cos[id] : undefined; };
  // canvas text: the same family as before in Chinese and English, Japanese glyph shapes in Japanese
  api.font = L === 'ja' ? '"Noto Sans JP","Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Meiryo",sans-serif' : '"Noto Sans TC",sans-serif';
  api.set = function (id) {
    if (!ok(id) || id === L) return;
    try { localStorage.setItem(KEY, id); } catch (e) {}
    try { var u = new URL(location.href); u.searchParams.delete('lang'); location.replace(u.toString()); } catch (e) { location.reload(); }
  };

  var H = document.documentElement;
  H.lang = LANGS.filter(function (l) { return l.id === L; })[0].html;
  if (P) {   // hide the Chinese page until i18n-dom.js has translated it (never for longer than 3 s)
    H.classList.add('i18n-wait');
    api.shown = function () { H.classList.remove('i18n-wait'); };
    setTimeout(api.shown, 3000);
    document.addEventListener('DOMContentLoaded', api.shown);
  } else api.shown = function () {};

  window.PPLI18N = api; window.TX = TX; window.TXA = TXA; window.TXO = TXO;
})();

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
  var KEY = 'ppl-lang', AUTO = 'auto';
  var ok = function (v) { return LANGS.some(function (l) { return l.id === v; }); };

  // a language is offered to players only when its file loaded and nothing in it is missing (tools/i18n.mjs build sets ok)
  var ready = function (v) { return v === 'zh' || !!(PACKS[v] && PACKS[v].ok); };
  var save = function (v) { try { localStorage.setItem(KEY, v); return true; } catch (e) { return false; } };

  function pick() {
    var q = '', dbg = false;
    try { var sp = new URLSearchParams(location.search); q = sp.get('lang') || ''; dbg = sp.get('i18n') === 'debug'; } catch (e) {}
    api.debug = dbg;
    // a link such as /?lang=ja chooses and remembers (an unfinished language too: that is how it is tested);
    // when that language's file did not load at all, this visit is shown like any other chosen language that is missing
    if (ok(q)) { save(q); return q === 'zh' || PACKS[q] ? q : ready('en') ? 'en' : 'zh'; }
    var s = '', old = false;
    try {
      s = localStorage.getItem(KEY) || '';
      // someone who already played before languages existed played in Chinese: keep it until they choose otherwise
      // ('auto' is not such a player: see below)
      if (!ok(s) && s !== AUTO) for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i) || ''; if (k !== KEY && (k.indexOf('ppl-') === 0 || k.indexOf('pmb6') === 0)) { old = true; break; } }
    } catch (e) {}
    // a chosen language whose file is missing this time: this visit only, in English when there is English (the choice is kept)
    if (ok(s)) return ready(s) ? s : ready('en') ? 'en' : 'zh';
    if (old) { save('zh'); return 'zh'; }
    var r = '', fell = false, nl = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
    for (var j = 0; j < nl.length; j++) {
      var x = String(nl[j]).toLowerCase().slice(0, 2);
      if (!ok(x)) continue;
      if (ready(x)) { r = x; break; }
      fell = true;   // a language this player reads exists but did not load, or is not finished
    }
    if (!r) { r = 'en'; if (!ready(r)) { r = 'zh'; fell = true; } }
    // Decided once and remembered: from now on the game's own save data would make this player look like "someone who played in Chinese".
    // A second-best result is not remembered as a choice: 'auto' means "decide again next time" (and skips the test for old players).
    save(fell ? AUTO : r);
    return r;
  }

  var api = { langs: [], debug: false, missing: {} };
  var L = pick();
  if (L !== 'zh' && !PACKS[L]) L = 'zh';   // the language file did not load: stay in the source language rather than show a mix
  // what the settings offer: the finished languages, and the one on screen (an unfinished language opened by a link)
  api.langs = LANGS.filter(function (l) { return ready(l.id) || l.id === L; });
  var P = L === 'zh' ? null : PACKS[L], U = (P && P.ui) || {};
  var PR; try { PR = new Intl.PluralRules(L === 'zh' ? 'zh-Hant' : L); } catch (e) { PR = { select: function () { return 'other'; } }; }

  function fmt(s, p) {
    if (!p || typeof p !== 'object') return s;
    return s.replace(/\{(\w+)\}/g, function (m, k) { return Object.prototype.hasOwnProperty.call(p, k) ? p[k] : m; });
  }
  function bare(id) { var at = id.lastIndexOf('@@'); return at >= 0 ? id.slice(0, at) : id; }
  function TX(id, p) {
    id = String(id);
    if (!P || !id) return fmt(bare(id), p);   // '' is an empty slot of an array, not a text
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
  // canvas text: the same family as before in Chinese; Japanese glyph shapes in Japanese; a Latin font first in English
  // (a Chinese font draws ’ “ ” … one full square wide). Keep in step with the html[lang] rules in index.html.
  api.font = L === 'ja' ? '"Noto Sans JP","Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Meiryo",sans-serif'
    : L === 'en' ? '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans TC",sans-serif' : '"Noto Sans TC",sans-serif';
  // dates: the Chinese game always wrote them the Taiwanese way; English follows the reader's own English locale
  api.locale = L === 'zh' ? 'zh-TW' : L === 'ja' ? 'ja-JP' : (/^en/i.test(navigator.language || '') ? navigator.language : 'en-US');
  api.set = function (id) {
    if (!ok(id)) return;
    var kept = save(id);   // when nothing can be stored the choice travels in the address instead
    var to = '';
    try { var u = new URL(location.href); if (kept) u.searchParams.delete('lang'); else u.searchParams.set('lang', id); to = u.toString(); } catch (e) {}
    if (id === L) {   // already shown (an automatic or stand-in language): now it is the player's choice, nothing to reload;
      // only the address is put right, where a ?lang= left behind would choose again on the next load
      try { if (to && to !== location.href) history.replaceState(history.state, '', to); } catch (e) {}
      return;
    }
    var go = function () { if (to && to !== location.href) location.replace(to); else location.reload(); };   // the same address with a #part would not load again
    // the page fades out before it loads again, and the new one fades in (see 'back' below): no flash of another screen in between
    H.classList.add('i18n-out');
    setTimeout(function () { try { go(); } catch (e) {} }, FADE ? 160 : 0);
    // a load that never replaces this page (stopped by the player, refused): the page comes back rather than staying blank and dead
    setTimeout(function () { H.classList.remove('i18n-out'); }, 6000);
  };

  var H = document.documentElement;
  var FADE = true; try { FADE = !matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  H.lang = LANGS.filter(function (l) { return l.id === L; })[0].html;
  // back: this load comes from choosing a language in the settings (game.js set 'ppl-reopen' and puts the settings back at the end of
  // its script). Until then the page would show the home screen for a moment, so it stays hidden in every language until game.js says
  // so (api.back(); DOMContentLoaded comes after game.js, and 3 s at most).
  var back = false; try { back = !!sessionStorage.getItem('ppl-reopen'); } catch (e) {}
  api.shown = function () {};
  if (P || back) {   // hide the Chinese page until i18n-dom.js has translated it (or, back, until game.js has put the settings back)
    H.classList.add('i18n-wait');
    var show = function () { if (!H.classList.contains('i18n-wait')) return; H.classList.remove('i18n-wait'); if (back && FADE) H.classList.add('i18n-in'); };
    api.shown = function () { if (!back) show(); };
    api.back = show;
    setTimeout(show, 3000);
    document.addEventListener('DOMContentLoaded', show);
  }
  if (!api.back) api.back = function () {};

  window.PPLI18N = api; window.TX = TX; window.TXA = TXA; window.TXO = TXO;
})();

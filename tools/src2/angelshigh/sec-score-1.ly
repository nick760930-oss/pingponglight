\header { tagline = ##f arranger = "arr.: Edward Shippen Barnes" }
\layout { indent = 0 \context { \Score \remove "Bar_number_engraver" } }
global = { \key f \major \time 4/4 }

verse = \lyricmode {
  An -- gels we have heard on high
  Sweet -- ly sing -- ing o'er the plains,
  \repeat volta 2 { Glo -- ri -- a in ex -- cel -- sis } \alternative { { De -- o! } { De -- o! } }
}
verseR = \lyricmode {
  And the moun -- tains in re -- ply
  E -- cho -- ing their joy -- ous strains.
}
soprano = \relative c'' { \global \set midiInstrument = "flute" \voiceOne
  \repeat volta 2 { a4 a a c | c4. bes8 a2
    a4 g a c | a4. g8 f2 | }
  \repeat volta 2 { c'2 (d8 c bes a |bes2 c8 bes a g | a2 bes8 a g f | g4.) c,8 c2 |
    f4 g a bes | } \alternative { { a2 g | } { a2 (g) | f1 \bar "|." } }
}

alto = \relative c' { \global \set midiInstrument = "flute" \voiceTwo
  \repeat volta 2 { \stemUp f4 f e e | \stemDown g e f2 |
    \stemUp f4 e f f | \stemDown f e f2 | }
  \repeat volta 2 { f4 (a8 g f2~ | f4 g8 f e2~ | e4 f8 e d2 | c4.) c8 c2 |
    \stemUp c4 e f g | } \alternative { { f2 e | } { f2 (e) | c1 \bar "|." } }
}

tenor = \relative c' { \global \set midiInstrument = "clarinet"
  \repeat volta 2 { c4 c c c | d c c2 |
    c4 c c c | c4. bes8 a2 | }
  \repeat volta 2 { a2 (d~ | d c~ | c bes | g4) f e2 |
    f4 c' c d | } \alternative { { c2 c } { c2. (bes4) | a1 \bar "|." } }
}

bass = \relative c { \global \set midiInstrument = "clarinet"
  \repeat volta 2 { f4 f a a | d, e f2 |
    f4 c f a,8 bes | c4 c a2 | }
  \repeat volta 2 { f'2 (d4 f | g2 c,4 e | f2 bes,4 d | e) d c (bes) |
    a c f bes, | } \alternative { { c2 c } { c1 | f1 \bar "|." } }
}

\score {
  \new ChoirStaff <<
    \new Staff
    <<
      \new Voice \soprano
      \addlyrics \verse
      \addlyrics \verseR
      \alto
    >>
    \new Staff
    <<
      \clef bass
      \partCombine \tenor \bass
    >>
  >>
  \layout { }
}
\score { \unfoldRepeats { << \soprano \\ \alto \\ \tenor \\ \bass >> }
  \midi { \tempo 4=120
    \context { \Staff \remove "Staff_performer" }
    \context { \Voice \consists "Staff_performer" }
  }
}
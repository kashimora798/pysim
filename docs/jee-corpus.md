# The p3xx corpus: JEE-level and book-level problems as engine verification

The p3xx problems exist to stress the engines against the hardest problem *types* in
the Indian JEE (Joint Entrance Examination) syllabus and standard textbooks — at full
exam strength, not diluted. Each one is posed from a published problem type, then
**rewritten in our own words with transposed values** (see each file's `source:` line;
nothing is reproduced verbatim — exam and textbook text stays with its owners).

## Where the types came from

- **JEEBench** (DAIR, IIT Delhi; EMNLP 2023) — 515 JEE Advanced 2016–2023 problems
  with gold answers, github.com/dair-iitd/jeebench. We scanned its 123 physics items
  for types our engines can lawfully reach, and used its gold answers as an external
  check (the alpha/sulfur ion-radius ratio, gold = 4).
- **HC Verma, Concepts of Physics Vol. 2** chapter problem types (capacitors, current
  electricity, charged-particle deflection) — posed fresh with our own values.
- JEE Main-style Kirchhoff networks, designed for this corpus so that Engine B is the
  *only* lawful route.

## What each kind proves

| Kind | Problems | Verified claim |
| --- | --- | --- |
| Cavity electrostatics (JEE Advanced 2015 type) | p301, p302 | E = ρa/3ε₀ uniform in the cavity; a charge crossing it is an exact projectile (Engine A chain + Engine C trajectory agree at 2 cm) |
| Charged-particle projectile in a uniform field | p303 | Parabolic deflection y = ½(eE/m)t² = 4.40 mm over 4 cm plates; trajectory is a true parabola (quarter-drop at half-time) |
| Ion orbits after acceleration (JEE Advanced ratio type) | p304, p305 | r ∝ √(m/q) at fixed V: r_S/r_α = **4.0**, the JEEBench gold answer, from two independent derivations; Engine C orbits reproduce Engine A radii |
| Capacitor networks (book type) | p306, p307 | Series reduces (1.2 µF → 8.64e-5 J), parallel adds (10 µF → 2.0e-3 J) |
| Unbalanced Kirchhoff networks (JEE Main type) | p308, p309 | Chain provably returns nothing; Engine B nodal assembly gives −1/13 A (sign = real direction) and 48/215 A |
| Current division (book type) | p310 | Branch current travels down the reduction tree: 4.0 A through the 3 Ω branch |
| Cyclotron period (JEE Main type) | p311 | T = 2πm/qB speed-independent; the animated orbit closes on itself |

## The three-way verification

1. **Analytic**: every `expect:` value was computed by hand (closed form / exact
   fractions) *before* the kernel saw the problem, and is recorded in the file.
2. **Kernel audit**: `ff audit` re-derives every answer through the chain/system
   engines and asserts agreement — 37/37.
3. **Relational tests** (`tests/test_jee_corpus.py`): the ratio, the parabola shape,
   orbit closure and Engine A↔C agreement — properties no single expected value can
   express. 97 tests pass in total.

Six of the eleven carry Engine C trajectories, so they animate in the XR bench: the
cavity crossing, the plate parabola, and three full cyclotron orbits.

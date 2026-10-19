# Architecture

## The pipeline

```
problem text ──(LLM, boundary)──▶ Scene ──▶ [ VALIDATE ] ──▶ rejected, shown to the user
                                                 │ passes
                     ┌───────────────────────────┴──────────────────────┐
                     │              PHYSICS KERNEL (no AI)              │
                     │   Engine A: chain  │  Engine B: system  │  C: ODE │
                     │           └──── cross-check must agree ───┘       │
                     │                     ▲                            │
                     │        MATHEMATICAL TOOLKIT (explicit calls)      │
                     │   differentiate · integrate · solve · quadrature  │
                     └───────────────────────────┬──────────────────────┘
                                                 │ Trace — ordered, every step cited
                                                 ▼
                                             SimSpec JSON
                                   ┌─────────────┼─────────────┐
                                 3D player   derivation      MCP tools
                                  (dumb)      (KaTeX)        (agents)
```

All three engines are built, over one knowledge base, and they cross-check each other.
`ff coverage` reports which engine answered each corpus problem.

## The one rule

**AI at the boundary, never in the kernel.** Nothing under `kernel/` makes a network call or
consults a model. An LLM may translate prose into a `Scene`; the kernel's job is then to *reject
or accept* that scene — by schema, dimension, rank and topology checks — and compute with zero AI.
A wrong extraction surfaces as an editable structured scene, never as a wrong number presented as
truth.

This is a deliberate softening of "no AI at runtime" as written in the research document. The
absolute version requires a deterministic prose parser, which that document itself calls the
hardest step, and which the competitive research already abandons. Every claim about lawfulness
survives the softening, because the *computation* is still AI-free.

## Property as the universal key

Everything links through properties. A property is a physical quantity with a canonical identity:

```yaml
em.electric_field:
  symbol: E
  dim: electric_field    # a 7-vector over kg m s A K mol cd
  rank: vector           # scalar | vector
  kind: field            # lumped | field | pair
  si_unit: V/m
```

`rank` and `kind` are additions to the research document's model, and both are load-bearing:

- **`rank`** — retrofitting vectors into a scalar-only property model is a rewrite, so it is in
  from the first row. It is also what catches `v * B` where `cross(v, B)` was meant.
- **`kind: field`** — a field is a function of position, not a value an object owns. This is why a
  bare `field_probe` is a legitimate component.
- **`kind: pair`** — a *separation* belongs to a pair of objects, not to either one.

### Two tables never reference each other

A formula never names a component. A component never names a formula. Both name only property
keys. `tests/test_validators.py::test_no_component_names_a_formula` enforces it.

That single discipline is why adding a chapter means adding rows, never changing the schema — and
why the cross-domain chain works. `lorentz.F_vec_electric` turns a charge and a field into a
force while knowing nothing about either electromagnetism or mechanics. It only knows property
keys.

## Relations carry properties

This is the main structural extension beyond the research document. A scene is instances *plus
relations*, and a relation owns properties of its own:

```yaml
relations:
  - kind: acts_on
    from: q1
    to: p1
    set: {geometry.separation: "30 cm"}
```

Coulomb's law then binds without a special case: `Q` from the source, `r` from the relation.
A formula declares where each binding comes from via its scope:

| scope | bindings come from | example |
|---|---|---|
| `self` | the instance being solved for | `K = m*v²/2` |
| `pair` | `self`, the other end (`role`), or the relation (`rel`) | `E = k_e·Q/r²` |
| `scene` | a uniquely identified instance elsewhere | — |

A `pair` formula's precondition is the relation itself, which is how
`shield.E_mag_inside_conductor_cavity` justifies a result with **no inputs at all**: being inside
a conductor's cavity is the entire argument.

## Tools are components

A measurement is placing an object and reading one of its observable properties. There is no
probe subsystem. `field_probe`, `voltmeter`, `ruler` and `stopwatch` are ordinary rows in
`data/kb/components/tools.yaml`, and a probe reading resolves through identical machinery to a
derived quantity.

## Givens, observables, and initial conditions

Component slots have roles: `intrinsic` (fixed by nature — an electron's mass), `settable` (the
problem states it), `observable` (solving produces it).

Setting an observable is refused: it would be asserting the answer. But an *initial condition* is
a legitimate given, so `kinematics.speed@initial: "0 m/s"` is allowed where
`kinematics.speed: ...` is not. States are per-binding (`initial` / `final`), never baked into
property keys.

## Engine A: the chain resolver

Backward chaining from the target. `KnowledgeBase.solvers` indexes formulas by what they produce,
so the resolver looks up a handful of candidates rather than scanning all of physics — the
research document's "components are the index" insight, made concrete as a dict lookup.

Memoised, cycle-detected by a visited set over `Ref`s, depth-capped.

### Multi-path, deduplicated by law

Enumerating every derivation tree is exponential and mostly produces noise. Two derivations count
as the same path when they invoke **the same set of laws**:

```python
def signature(self) -> frozenset[str]:
    return self.laws
```

Keying on formulas as well would let algebraic rearrangements pose as alternatives — taking a
magnitude before dividing by mass rather than after is the same physics twice. With law-set
keying, p003 correctly collapses to one path while p001, p009 and p011 keep two: *energy
conservation* versus *constant-acceleration kinematics*, which is a real choice a student
benefits from seeing.

The corpus asserts that all paths of a problem agree to within 1e-9, and that Engine A and
Engine B agree to within 1e-9 wherever both can answer. **Those cross-checks are the verification
story** — the visible trust machinery the research document asks for in §6.4. They are also what
catches a knowledge-base bug the moment one is introduced: two engines of different construction,
reading the same tables, cannot both be wrong in the same way by accident.

### What Engine A cannot do

Honestly scoped: it handles **algebraic chains**. It cannot do

- **simultaneous systems** — two cells of different emf in parallel have a terminal voltage no
  single row determines. That needs **Engine B** below;
- **time evolution** — the answer is a function, not a value. That needs **Engine C** below;
- **field integrals** over a distribution — the toolkit has them
  (`integrate`, `quadrature`), but nothing in the knowledge base asks for one yet.

Engine A is the special case of Engine B in which every strongly-connected component of the
dependency graph happens to hold one unknown. That is not a coincidence but the design: Engine B
causalises first, and only solves simultaneously where it must.

## Engine B: acausal assembly

`kernel/engine_system.py`. For the problems where no single law isolates any unknown: two cells
of different emf in parallel, a loaded bridge, any scene where the same quantity is both a cause
and a consequence.

Engine B does not flatten everything into one matrix. The knowledge base deliberately carries
several rearrangements of each law — `I = V/R`, `V = I*R`, `R = V/I` — because Engine A needs to
walk a chain in whichever direction the givens point. A naive flattening therefore assembles a
*structurally singular* system: rows that are the same relation, which leaves unknowns free while
still letting a numeric solver return a number. Three guards prevent that.

**1. One producer per unknown, chosen by fewest new unknowns.** Working backwards from the
target, each unknown gets the cheapest law that could produce it. This makes the dependency graph
the *smallest* graph that could answer the question.

**2. Tarjan over that graph.** Components emerge with every dependency already emitted, so
anything triangular stays a chain — Engine A's territory, reached through the same rows — and
only a genuine cycle becomes a simultaneous block.

**3. Structural rank, then the rank at the answer.** A block is accepted only when its equations
are independent enough to determine its unknowns. If they are not, the law that removes the most
freedom is added and the block grows. Two subtleties the guards exist for:

* the generic rank of a Jacobian can exceed its rank *on the solution set* — the determinant can
  be a multiple of one of the equations — so uniqueness is re-tested at the answer, not just at a
  random point;
* a square subset chosen generically can still collapse, so when a subset yields a family rather
  than a number, the solver's own free variable is used to fetch a law for exactly that quantity,
  and failing that, the whole over-determined block is solved as assembled.

If the knowledge base runs out of laws first, Engine B says so — "under-determined, these
equations leave one degree of freedom" — rather than returning a root it converged on.

### A law must say what it is a law of

Building Engine B exposed a real modelling bug. `ohm.I_from_V_R` was unrestricted, so the
assembler applied Ohm's law across a *battery's* terminals, where it is false: a source obeys
`V = emf - I*r`. The assembled system then had no solution at all, because the physics had been
contradicted rather than under-specified.

Formula rows may now declare `applies_to: [battery]`, `[resistor, lamp]`, `[circuit_loop]`. An
empty list means universal — `P = I*V` holds for a battery as much as for a resistor, and
pretending otherwise would invent a restriction. Only the rows that are *not* universal have to
say so. The browser port of the resolver honours the same field, so the exported bundle and the
kernel that produced it cannot disagree.

## Engine C: time evolution

`kernel/engine_ode.py`. For answers that are functions: a capacitor charging, a projectile
flying, anything where "what is it?" is the wrong question and "what does it do?" is the right
one.

The physics still comes from the same tables. Engine C adds three declarations — this property is
the derivative of that one, here is the initial condition, here is the integrator — and then
samples. Methods are named on the result (`euler`, `rk4`, `rk45` via SciPy when installed),
because *the answer depends on the method* is exactly what a physics engine must say out loud.

The engine's first duty after integrating is to check itself. Where algebra has an answer —
constant acceleration, exponential RC charging — the tests hold the integrator to it, and `ff ode`
prints the closed form next to the sampled one. RK4 is exact for constant acceleration to machine
precision; Euler visibly is not, and the difference is recorded rather than hidden.

Vector state is supported (three components per vector variable), and a trajectory exports to
SimSpec-shaped beats, so a renderer can play back a curve without a separate animation format.

`corpus/trajectories/` is Engine C's counterpart to the algebraic corpus: each entry declares a
builder, its arguments, the integration settings, and the closed-form value the sampled answer
must reach. `ff trajectories` runs all of them and reports which agree. The tolerance is looser
than the algebraic corpus's on purpose — an integrator has a truncation error that belongs to the
method and the step size, not to a mistake — and the method and `dt` are recorded alongside it.

## The mathematical toolkit

`kernel/math_tools.py`. Differentiation, integration, limits, series, gradient, divergence, curl,
Laplacian, rearrangement, symbolic and linear system solving, determinants, inverses, quadrature
and numerical differentiation — plus the ODE integrator itself.

The design point is that these are **explicit, callable tools**, not machinery buried inside a
solver. Every one is registered by name and reachable three ways:

```python
from kernel.math_tools import differentiate, call, TOOLS
differentiate("x**2", "x", dims={"x": Dim.of(m=1)})     # -> 2*x  [m]
call("rearrange", "V - I*R", "I")                        # -> V/R
sorted(TOOLS)                                            # the whole registry
```

and from the command line as `ff math list` / `ff math rearrange "V - I*R" I`.

Three properties are enforced. **Nothing integrates by accident** — a caller names the tool, so a
trace can say "and here we integrated". **Dimensions are carried where they can be**:
differentiation divides by the variable's dimension, integration multiplies by it, a gradient's
components carry the field's dimension per length. **No tool invents physics** — they know nothing
of charge or circuits; the knowledge base decides what is lawful and this module only does
arithmetic.

A tool that cannot know the dimensions (a purely numerical quadrature over an expression already
in SI) says so: it returns a plain float and leaves the tagging to the caller.

## Trace is the storyboard

Derivation order *is* animation order. Each step becomes one beat; every beat carries a
`because`. There is no separate animation planner, and a renderer that cannot explain a frame
cannot draw it.

`SimSpec` is the kernel↔renderer contract. The kernel never imports a renderer and the renderer
never imports the kernel, so visual quality and physics correctness scale independently.

A `because` on a derived beat carries the formula key, the raw expression, the expression with
values substituted, the law key and its full statement, the assumptions, the citation, and every
input with its own provenance. See `out/p011.json` after running
`ff solve corpus/problems/p011.yaml --spec out/p011.json`.

## The compiler: six validators

Run by `ff audit`.

| # | check | severity | what it catches |
|---|---|---|---|
| 1 | `refs` | error | a property, law or component key that does not exist |
| 2 | `dims` | error | expression not dimensionally homogeneous, **or** inferred dimension ≠ declared |
| 3 | `rank` | error | scalar and vector silently interchanged |
| 4 | `units` | error | a property's `si_unit` disagrees with its declared dimension |
| 5 | `orphans` | warning | a property nothing can produce, or nothing consumes |
| 6 | `coverage` | error | a corpus problem that fails to resolve or reach its known answer — under *either* engine, or where both answer and disagree |

Checks 1–4 are hard failures: invalid physics cannot enter the building. Checks 5–6 report.

**Check 2 is the one that matters.** The research document quotes a builder on exactly this
failure: *"a simulation that looks correct but implements 1/r³ instead of 1/r² is worse than no
simulation at all — it's teaching wrong physics with the authority of interactive
visualization."* Dimensional inference alone does not catch it; the expression is internally
consistent. It is caught by comparing the **inferred** dimension against the **declared** one.
`tests/test_validators.py::test_inverse_cube_coulomb_is_rejected` asserts it.

A literal zero is admitted against any declared dimension, because the zero element belongs to
every dimension space. That is what lets the shielded-cavity formula be `expr: "0"`.

### Check 5 is the backlog

`ff audit` currently reports three properties nothing can produce: `em.electric_flux`,
`geometry.angle`, `geometry.length`. Those are not failures — they are the to-do list, printed.
The audit drives curation, exactly as the research document's §3.4 proposes.

## Expression safety

Formula bodies are parsed through a whitelist, not `eval`'d:

- the parser runs against a **sealed namespace** — SymPy's default globals are `from sympy import
  *`, which would shadow ordinary physics symbols (`Q` becomes sympy's assumptions object, `E`
  Euler's number, `S` the singleton registry, `N` numeric evaluation);
- `__builtins__` is emptied, **and** any source containing `__` is rejected outright, because
  emptying builtins is not sufficient on its own: `().__class__.__bases__[0].__subclasses__()`
  reaches 436 live classes by attribute access alone. Formula bodies never need an attribute;
- the parse result must be a `sympy.Expr`, since the parser can otherwise hand back a plain tuple;
- the parsed tree is walked and any function outside the whitelist is rejected.

## Vectors

`mag()`, `dot()`, `cross()` and `unit()` are explicit. `v * B` between two vectors is a rank
error that names the fix, because leaving it to coerce is how a dot product silently becomes a
cross product.

## What is missing

In rough order of value:

1. **The renderer** — a three.js / IWSDK player for SimSpec. The contract is ready and the
   precompiled traces are exported; the free-build bench still needs the resolver port finished
   (it mirrors Engine A in TypeScript).
2. **The LLM boundary** — prose → `Scene`, with the structured scene shown for editing.
3. **MCP server** — the `§6.2` tool surface over the kernel. The mathematical toolkit is already
   a named registry, which is the shape such a server wants.
4. **Field integrals in the corpus.** The toolkit can integrate; no knowledge-base row asks it
   to yet. A charged rod or disc solved by quadrature is the natural next flagship, and it would
   be the first problem only Engine B plus the toolkit can do.
5. **More corpus.** Twenty-six problems is a proof, not a product. The moat is a large corpus of
   machine-checked golden traces, and growing it is the work that compounds.

A note on #1: do not let a game physics engine (Rapier, cannon-es) integrate the motion. Those
are plausible, not lawful. The kernel computes the trajectory; the renderer only applies
transforms. Using a game integrator would quietly void the entire positioning.

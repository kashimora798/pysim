# Architecture

## The pipeline

```
problem text ──(LLM, boundary)──▶ Scene ──▶ [ VALIDATE ] ──▶ rejected, shown to the user
                                                 │ passes
                     ┌───────────────────────────┴──────────────────────┐
                     │              PHYSICS KERNEL (no AI)              │
                     │   Engine A: chain  │  Engine B: system  │  C: ODE │
                     │           └──── cross-check must agree ───┘       │
                     └───────────────────────────┬──────────────────────┘
                                                 │ Trace — ordered, every step cited
                                                 ▼
                                             SimSpec JSON
                                   ┌─────────────┼─────────────┐
                                 3D player   derivation      MCP tools
                                  (dumb)      (KaTeX)        (agents)
```

Engine A is built. Engine B (nodal assembly, `kernel/engine_system.py`) and Engine C (RK4 time
evolution, `kernel/engine_ode.py`) now exist as v1s — single-source resistive networks and
uniform-field/cyclotron dynamics — cross-checked against Engine A wherever both can reach.

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

The corpus asserts that all paths of a problem agree to within 1e-9. **That cross-check is the
verification story** — the visible trust machinery the research document asks for in §6.4. It is
also what will catch a knowledge-base bug when Engine B lands.

### What Engine A cannot do

Honestly scoped: it handles **algebraic chains**. It cannot do

- **simultaneous systems** — no formula solves for the current in a Wheatstone bridge in
  isolation; that needs assembling equations and solving a matrix;
- **time evolution** — the answer is a function, not a value;
- **field integrals** over a distribution.

Those need Engine B (acausal assembly) and Engine C (ODE/DAE). They are not written yet. Engine A
is the special case of Engine B where the system happens to be triangular — which is also why
they will be able to cross-check each other.

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
| 6 | `coverage` | error | a corpus problem that fails to resolve or reach its known answer |

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

1. **Engine B, generalised** — v1 (single-source resistive nodal assembly) is built and solves
   the Wheatstone bridge (p201); supernodes/multi-source, reactive branches and a TypeScript
   port for Free bench remain.
2. **Engine C, generalised** — v1 (constant-acceleration + cyclotron RK4, sampled into SimSpec
   `trajectory` and animated in XR) is built; position-dependent fields and RC transients remain.
3. **The renderer** — built: the IWSDK bench replays SimSpecs (Auto/Guided) and solves Free
   bench live. See `docs/xr-experience.md`. Modelled GLB parts are still outstanding.
4. **The LLM boundary** — built in TypeScript (`web/src/physics/extract.ts`); the editable
   scene-editor UI and a deployed proxy remain.
5. **MCP server** — the `§6.2` tool surface over the kernel. Still outstanding; now unblocked,
   since Engines B/C make the tool answers materially stronger.
6. **More corpus.** 26 problems (24 chain + Wheatstone + nodal cross-check) is still a proof,
   not a product. The moat is a large corpus of machine-checked golden traces.

A note on #3: do not let a game physics engine (Rapier, cannon-es) integrate the motion. Those
are plausible, not lawful. The kernel computes the trajectory; the renderer only applies
transforms. Using a game integrator would quietly void the entire positioning.

"""Engine A: the backward-chaining resolver.

Given a scene and a target property, work backwards: find formulas that produce the target, bind
their inputs, and recurse on whatever is not yet known. The output is not a number but a
**derivation** — an ordered list of steps, each citing the formula, the law and the source that
justify it.

Two things keep this tractable:

* **Components are the index.** The scene's instances fix which properties are even in play, and
  ``KnowledgeBase.solvers`` indexes formulas by what they produce. The resolver never scans all of
  physics; it looks up a handful of candidates per target.
* **Alternatives are deduplicated by law, not by shape.** Enumerating every algebraic
  rearrangement would explode and bore the reader. Two derivations count as genuinely different
  only if they invoke a different set of laws — the energy route versus the kinematics route, not
  ``V/d`` versus ``d\\V``.

What this engine is *for* is narration. It is honest about the class of problem it covers:
algebraic chains. Simultaneous systems and time evolution need the assembler and the integrator,
which share this knowledge base and must agree with it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import product

from . import exprs
from .kb import REL, SAME_STATE, SELF, Binding, Formula, KnowledgeBase
from .scene import Ref, Relation, Scene
from .units import Quantity, format_quantity

#: How deep a chain may go before we call it a loop we failed to detect.
MAX_DEPTH = 12

#: How many complete derivations to keep per target.
MAX_PATHS = 6


@dataclass(frozen=True, slots=True)
class Input:
    """One resolved input to a step: the symbol, where it came from, and its value."""

    symbol: str
    ref: Ref | None  # None for a constant
    const: str | None
    quantity: Quantity

    def describe(self) -> str:
        origin = self.const if self.const else str(self.ref)
        return f"{self.symbol} = {format_quantity(self.quantity)}  ({origin})"


@dataclass(frozen=True, slots=True)
class Step:
    """One justified move: either a given, or a formula application."""

    ref: Ref
    quantity: Quantity
    formula: Formula | None = None
    inputs: tuple[Input, ...] = ()
    #: Which instance each of the formula's roles bound to, for the trace and the storyboard.
    roles: tuple[tuple[str, str], ...] = ()

    @property
    def is_given(self) -> bool:
        return self.formula is None

    @property
    def role_instances(self) -> tuple[str, ...]:
        return tuple(inst for _, inst in self.roles)

    @property
    def law(self) -> str | None:
        return self.formula.law if self.formula else None

    @property
    def cite(self) -> str:
        return self.formula.cite if self.formula else "stated in the problem"

    def substituted(self) -> str:
        if self.formula is None:
            return format_quantity(self.quantity)
        # Engine B steps carry an assembled equation, not a substitutable expression:
        # show the equation form rather than the placeholder zero it is stored with.
        if self.formula.key.startswith("system."):
            return self.formula.expr_text
        env = {i.symbol: i.quantity for i in self.inputs}
        return exprs.substituted_text(self.formula.expr, env)


@dataclass
class Derivation:
    """A complete, ordered justification for one target value."""

    target: Ref
    steps: list[Step] = field(default_factory=list)

    @property
    def value(self) -> Quantity:
        return self.steps[-1].quantity

    @property
    def cost(self) -> int:
        return sum(1 if s.formula else 0 for s in self.steps)

    @property
    def laws(self) -> frozenset[str]:
        return frozenset(s.law for s in self.steps if s.law)

    @property
    def formulas(self) -> tuple[str, ...]:
        return tuple(s.formula.key for s in self.steps if s.formula)

    @property
    def assumptions(self) -> tuple[str, ...]:
        seen: dict[str, None] = {}
        for s in self.steps:
            if s.formula:
                for a in s.formula.assumes:
                    seen[a] = None
        return tuple(seen)

    @property
    def citations(self) -> tuple[str, ...]:
        seen: dict[str, None] = {}
        for s in self.steps:
            if s.formula and s.formula.cite:
                seen[s.formula.cite] = None
        return tuple(seen)

    def signature(self) -> frozenset[str]:
        """What makes two derivations the *same* path: the set of laws they invoke.

        Keying on formulas as well would let algebraic rearrangements masquerade as alternatives
        — taking a magnitude before dividing by mass rather than after is the same physics twice,
        and offering it as "another way to solve this" is noise. Two derivations are genuinely
        different only when they appeal to different laws: the energy route versus the kinematics
        route, not `F/m` reassociated.
        """
        return self.laws


@dataclass
class Failure:
    """Why a target could not be reached — the audit's most useful output."""

    ref: Ref
    reasons: list[str] = field(default_factory=list)

    def __str__(self) -> str:
        head = f"cannot resolve {self.ref}"
        if not self.reasons:
            return head + ": no formula in the knowledge base produces it"
        return head + ":\n  - " + "\n  - ".join(dict.fromkeys(self.reasons))


class Resolver:
    """Backward-chaining resolution over one scene."""

    def __init__(self, kb: KnowledgeBase, scene: Scene, *, max_paths: int = MAX_PATHS) -> None:
        self.kb = kb
        self.scene = scene
        self.max_paths = max_paths
        self._memo: dict[Ref, list[Derivation]] = {}
        self._notes: dict[Ref, list[str]] = {}

    # ------------------------------------------------------------------ public

    def resolve(self, target: Ref) -> list[Derivation]:
        """Every genuinely distinct derivation of ``target``, cheapest first."""
        found = self._resolve(target, visited=frozenset(), depth=0)
        unique: dict[tuple, Derivation] = {}
        for d in sorted(found, key=lambda d: (d.cost, d.formulas)):
            unique.setdefault(d.signature(), d)
        return list(unique.values())[: self.max_paths]

    def failure(self, target: Ref) -> Failure:
        return Failure(ref=target, reasons=list(self._notes.get(target, [])))

    # ------------------------------------------------------------------ internals

    def _note(self, ref: Ref, reason: str) -> None:
        self._notes.setdefault(ref, []).append(reason)

    def _resolve(self, ref: Ref, visited: frozenset[Ref], depth: int) -> list[Derivation]:
        if ref in self._memo:
            return self._memo[ref]
        if ref in visited:
            return []  # cycle: this branch cannot close
        if depth > MAX_DEPTH:
            self._note(ref, f"gave up past depth {MAX_DEPTH}")
            return []

        results: list[Derivation] = []

        given = self.scene.given(ref)
        if given is not None:
            results.append(Derivation(target=ref, steps=[Step(ref=ref, quantity=given)]))

        candidates = self.kb.solvers_for(ref.prop)
        if not candidates and given is None:
            self._note(ref, f"no formula in the knowledge base solves for {ref.prop}")

        for formula in candidates:
            if not self._state_matches(formula, ref):
                continue
            results.extend(
                self._apply(formula, ref, visited | {ref}, depth)
            )

        unique: dict[frozenset[str], Derivation] = {}
        for d in sorted(results, key=lambda d: (d.cost, d.formulas)):
            unique.setdefault(d.signature(), d)
        out = list(unique.values())[: self.max_paths]

        # Cache successes only. A failure here may be an artefact of `visited` rather than a real
        # dead end: once two properties are mutually derivable — a field vector from its magnitude
        # and the magnitude back from the vector — a branch that happens to recurse through the
        # pair gets cut by cycle detection and returns nothing. Caching that would poison the
        # memo, and a later branch that could legitimately resolve it would read the empty result
        # and fail. Recomputing a miss costs a little; remembering a false one is a wrong answer.
        if out:
            self._memo[ref] = out
        return out

    @staticmethod
    def _state_matches(formula: Formula, ref: Ref) -> bool:
        """A formula that declares ``produces_state`` only answers for that state."""
        if formula.produces_state is None:
            return True
        return ref.state == formula.produces_state

    def _apply(
        self, formula: Formula, ref: Ref, visited: frozenset[Ref], depth: int
    ) -> list[Derivation]:
        """Try one formula: bind its roles, resolve its inputs, build derivations."""
        out: list[Derivation] = []
        for binding_map in self._role_bindings(formula, ref):
            resolved = self._resolve_inputs(formula, ref, binding_map, visited, depth)
            if resolved is None:
                continue
            for combination in resolved:
                derivation = self._assemble(formula, ref, binding_map, combination)
                if derivation is not None:
                    out.append(derivation)
        return out

    def _role_bindings(
        self, formula: Formula, ref: Ref
    ) -> list[dict[str, tuple[str, Relation | None]]]:
        """Every way this formula's roles can be bound to instances in the scene.

        Returns one dict per combination, mapping role name to (instance id, relation). A formula
        with two roles yields the cartesian product, which is what lets a series pair find both of
        its members. A `self`-scope formula yields a single empty binding.

        For `pair` scope the relation must exist and the other end must match the role's declared
        kinds — which is the entire precondition for formulas like the shielded cavity that need no
        inputs at all.
        """
        if formula.scope == "self":
            return [{}]

        # Each role resolves by its own mode, so one formula can reach both a related object and
        # the scene-level environment. That is what lets Coulomb's law divide by the medium's
        # permittivity without a second formula.
        per_role: list[list[tuple[str, tuple[str, Relation | None]]]] = []
        for name, role in formula.roles.items():
            options: list[tuple[str, tuple[str, Relation | None]]] = []

            if role.scene or role.via is None:
                for iid, inst in self.scene.instances.items():
                    if not role.kinds or inst.kind in role.kinds:
                        options.append((name, (iid, None)))
                if not options:
                    self._note(
                        ref,
                        f"{formula.key}: the scene has no "
                        f"{' or '.join(role.kinds) or 'instance'} for role {name!r}",
                    )
                    return []
            else:
                for relation in self.scene.relations_from(ref.instance, role.via):
                    if self._kind_ok(relation.to, role.kinds):
                        options.append((name, (relation.to, relation)))
                for relation in self.scene.relations_into(ref.instance, role.via):
                    if self._kind_ok(relation.frm, role.kinds):
                        options.append((name, (relation.frm, relation)))
                if not options:
                    self._note(
                        ref,
                        f"{formula.key}: needs a {role.via!r} relation to a "
                        f"{' or '.join(role.kinds) or 'component'}",
                    )
                    return []

            per_role.append(options)

        combos = [dict(combo) for combo in product(*per_role)]
        # Two roles must not bind the same instance: a resistor is not in series with itself.
        return [c for c in combos if len({inst for inst, _ in c.values()}) == len(c)]

    def _kind_ok(self, iid: str, kinds: tuple[str, ...]) -> bool:
        if not kinds:
            return True
        return self.scene.instance(iid).kind in kinds

    def _resolve_inputs(
        self,
        formula: Formula,
        ref: Ref,
        binding_map: dict[str, tuple[str, Relation | None]],
        visited: frozenset[Ref],
        depth: int,
    ) -> list[list[Input]] | None:
        """Resolve every binding. Returns one list of Inputs per combination of sub-derivations,
        or None if any binding is unreachable."""
        per_binding: list[list[Input]] = []

        for binding in formula.bindings.values():
            options = self._resolve_binding(formula, binding, ref, binding_map, visited, depth)
            if not options:
                return None
            per_binding.append(options)

        if not per_binding:
            return [[]]  # a formula with no inputs, e.g. the shielded cavity
        return [list(combo) for combo in product(*per_binding)]

    def _resolve_binding(
        self,
        formula: Formula,
        binding: Binding,
        ref: Ref,
        binding_map: dict[str, tuple[str, Relation | None]],
        visited: frozenset[Ref],
        depth: int,
    ) -> list[Input]:
        if binding.is_const:
            constant = self.kb.ontology.constants.get(binding.const or "")
            if constant is None:
                self._note(ref, f"{formula.key}: unknown constant {binding.const!r}")
                return []
            return [
                Input(
                    symbol=binding.symbol,
                    ref=None,
                    const=constant.key,
                    quantity=constant.quantity,
                )
            ]

        assert binding.prop is not None

        rel_role = binding.relation_role
        if rel_role is not None:
            # `rel` is the single-role shorthand; `rel.<name>` names one explicitly.
            name = next(iter(binding_map)) if rel_role == REL else rel_role
            entry = binding_map.get(name)
            if entry is None or entry[1] is None:
                return []
            value = entry[1].get(binding.prop, binding.state)
            if value is None:
                self._note(
                    ref,
                    f"{formula.key}: the {entry[1].kind!r} relation does not state "
                    f"{binding.prop!r}",
                )
                return []
            return [Input(symbol=binding.symbol, ref=None, const=None, quantity=value)]

        if binding.frm == SELF:
            owner = ref.instance
        else:
            entry = binding_map.get(binding.frm)
            if entry is None:
                return []
            owner = entry[0]

        # `state: same` follows the target's instant, so asking for the speed at the end resolves
        # the velocity at the end rather than the state-agnostic default.
        state = ref.state if binding.state == SAME_STATE else binding.state
        sub_ref = Ref(owner, binding.prop, state)
        derivations = self._resolve(sub_ref, visited, depth + 1)
        if not derivations:
            self._note(ref, f"{formula.key}: could not resolve {sub_ref}")
            return []

        return [
            Input(symbol=binding.symbol, ref=sub_ref, const=None, quantity=d.value)
            for d in derivations
        ]

    def _assemble(
        self,
        formula: Formula,
        ref: Ref,
        binding_map: dict[str, tuple[str, Relation | None]],
        inputs: list[Input],
    ) -> Derivation | None:
        """Evaluate the formula and splice sub-derivations into one ordered trace."""
        env = {i.symbol: i.quantity for i in inputs}
        try:
            value = exprs.evaluate(formula.expr, env, where=formula.key)
        except ZeroDivisionError:
            self._note(ref, f"{formula.key}: division by zero with the given values")
            return None
        except Exception as exc:  # dimension, rank or arithmetic trouble
            self._note(ref, f"{formula.key}: {exc}")
            return None

        declared = self.kb.ontology.prop(formula.solves_for)
        if not formula.expr.is_zero:
            if value.dim != declared.dim or value.rank != declared.rank:
                self._note(
                    ref,
                    f"{formula.key}: produced {value.dim} ({value.rank}) but "
                    f"{formula.solves_for} is {declared.dim} ({declared.rank})",
                )
                return None
        else:
            value = Quantity(value=value.value, dim=declared.dim, rank=declared.rank)

        steps: list[Step] = []
        seen: set[Ref] = set()
        for inp in inputs:
            if inp.ref is None:
                continue
            for sub in self._memo.get(inp.ref, [])[:1]:
                for step in sub.steps:
                    if step.ref not in seen:
                        seen.add(step.ref)
                        steps.append(step)

        steps.append(
            Step(
                ref=ref,
                quantity=value,
                formula=formula,
                inputs=tuple(inputs),
                roles=tuple(sorted((name, inst) for name, (inst, _) in binding_map.items())),
            )
        )
        return Derivation(target=ref, steps=steps)

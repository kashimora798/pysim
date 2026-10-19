"""Engine B: acausal assembly — simultaneous systems.

Engine A handles *chains*: A → B → C, where every step can be taken on its own.
Engine B handles *systems*: no single law isolates any one unknown, so the
local laws of every element and junction are assembled and solved together.

The classic case is two cells of different emf in parallel. Each branch obeys
Kirchhoff's voltage law, ``I = (emf - V)/r``, but the terminal voltage ``V`` is
set by *both* branches at once, so no row in the knowledge base can be walked
backwards to find it. Engine A honestly fails there. Engine B writes one
equation per branch, one KCL equation at the node, one Ohm's law for the load,
and solves the block.

**Causalisation, then repair.**  Dumping every applicable row into one matrix
is easy and wrong. The knowledge base deliberately carries several
rearrangements of each law (``I = V/R``, ``V = I*R``, ``R = V/I``), because
Engine A needs to walk a chain in whichever direction the givens point. A naive
flattening therefore produces a system that is *structurally singular*: rows
that are algebraically the same relation, which leaves unknowns free while
still letting a numeric solver return a number. Three guards prevent that:

1. **One producer per unknown** while causalising, chosen by fewest new
   unknowns, so the dependency graph is the smallest graph that could answer
   the question;
2. **Tarjan** over that graph. Dependencies come out first, so anything
   triangular stays a chain — Engine A's territory, reached through the same
   rows. Only a genuine cycle becomes a simultaneous block.
3. **Structural rank** on every block. A block is accepted only when its
   equations are independent enough to determine its unknowns. If they are not,
   the cheapest unused row is added and the block grows, until either the rank
   is full or the knowledge base runs out — in which case Engine B says so
   rather than returning a root it happened to converge on.

Nothing here guesses: every equation is a knowledge-base row, every unknown is
a declared observable property, every block is checked for uniqueness before
its numbers are believed, and every solved value is re-tagged with the
dimension the ontology says the property has.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field, replace
from itertools import product

import sympy as sp

from . import exprs
from .dims import Dim
from .engine_chain import Derivation, Input, Resolver, Step
from .kb import REL, SAME_STATE, SELF, Binding, Formula, KnowledgeBase
from .scene import Ref, Relation, Scene
from .units import Quantity, format_quantity


class SystemError(RuntimeError):
    """Raised when a scene cannot be assembled, or its system is not determined."""


#: How many times a block may grow while hunting for full rank.
MAX_ROWS = 64


# --------------------------------------------------------------------------- assembly


@dataclass(frozen=True)
class GroundEquation:
    """One knowledge-base row bound to concrete instances of this scene.

    ``unknowns`` are the inputs still to be solved for; ``knowns`` are inputs
    already fixed by the problem statement, a constant or a relation.
    """

    formula: Formula
    target: Ref
    roles: tuple[tuple[str, str], ...]
    unknowns: tuple[Input, ...]
    knowns: tuple[Input, ...]

    @property
    def new_unknowns(self) -> tuple[Ref, ...]:
        return tuple(i.ref for i in self.unknowns if i.ref is not None)  # type: ignore[misc]

    @property
    def identity(self) -> tuple:
        return (self.target, self.formula.key, self.roles)

    def rank_key(self, known: set[Ref]) -> tuple[int, int, int, str]:
        """Preference when growing a block: fewest new unknowns first, then cost, then name."""
        fresh = len([u for u in self.new_unknowns if u not in known])
        return (fresh, len(self.unknowns), self.formula.cost, self.formula.key)

    def describe(self) -> str:
        return f"{self.formula.key} -> {self.target}"


@dataclass
class Block:
    """A strongly-connected component of the dependency graph, with the rows that pin it."""

    unknowns: tuple[Ref, ...]
    #: One row per unknown while causalising; more once the rank check starts growing the block.
    equations: tuple[GroundEquation, ...]

    @property
    def is_simultaneous(self) -> bool:
        """More than one unknown, or one unknown defined in terms of itself."""
        if len(self.unknowns) > 1:
            return True
        (only,) = self.unknowns
        return any(only in eq.new_unknowns for eq in self.equations)


@dataclass
class Plan:
    """The causalised assembly: blocks in the order they can be solved."""

    target: Ref
    blocks: list[Block]

    @property
    def simultaneous(self) -> list[Block]:
        return [b for b in self.blocks if b.is_simultaneous]

    def __str__(self) -> str:
        return f"{len(self.blocks)} block(s), {sum(len(b.unknowns) for b in self.blocks)} unknown(s)"


# --------------------------------------------------------------------------- solution


@dataclass
class SystemSolution:
    """What Engine B concluded, and every value it needed to get there."""

    target: Ref
    values: dict[Ref, Quantity]
    plan: Plan
    #: block index -> every law assembled into it, including the redundant rearrangements.
    block_equations: dict[int, tuple[GroundEquation, ...]] = field(default_factory=dict)
    #: block index -> the independent subset actually solved, which is what the trace shows.
    solved_equations: dict[int, tuple[GroundEquation, ...]] = field(default_factory=dict)
    #: Blocks that needed the system path at all — these are the genuinely simultaneous ones.
    system_blocks: set[int] = field(default_factory=set)
    method: str = "block"
    residual: float = 0.0

    @property
    def value(self) -> Quantity:
        return self.values[self.target]

    @property
    def simultaneous_blocks(self) -> int:
        return len(self.system_blocks)

    def to_derivation(self, kb: KnowledgeBase) -> Derivation:
        """Render as an Engine-A-shaped :class:`Derivation`, so trace and export work unchanged.

        Givens first, then one step per unknown citing the law that pinned it.
        Steps belonging to a simultaneous block carry the extra assumption that
        they were solved together, so no trace ever implies one of them could
        have been taken alone.
        """
        steps: list[Step] = []
        seen: set[Ref] = set()

        def given_step(ref: Ref, quantity: Quantity) -> None:
            if ref in seen:
                return
            seen.add(ref)
            steps.append(Step(ref=ref, quantity=quantity, formula=None, inputs=(), roles=()))

        for index in sorted(self.block_equations):
            rows = self.block_equations[index]
            for row in rows:
                for inp in row.knowns:
                    if inp.ref is not None:
                        given_step(inp.ref, inp.quantity)

        for index in sorted(self.solved_equations):
            rows = self.solved_equations[index]
            simultaneous = index in self.system_blocks
            solved_here = [eq for eq in rows if eq.target not in seen]
            for row in solved_here:
                unknown = row.target
                if unknown in seen:
                    continue
                seen.add(unknown)
                formula = row.formula
                if simultaneous:
                    others = len(solved_here) - 1
                    extra = [len(self.block_equations[index])] if self.block_equations.get(index) else []
                    formula = replace(
                        formula,
                        assumes=formula.assumes
                        + (
                            f"solved simultaneously with {others} other unknown(s)"
                            + (
                                f" in a block of {extra[0]} equation(s), all of them verified"
                                if extra
                                else ""
                            )
                            + " — no single law isolates this value (Engine B)",
                        ),
                    )
                inputs = tuple(row.knowns) + tuple(
                    replace(inp, quantity=self.values[inp.ref]) if inp.quantity is None else inp
                    for inp in row.unknowns
                )
                steps.append(
                    Step(
                        ref=unknown,
                        quantity=self.values[unknown],
                        formula=formula,
                        inputs=inputs,
                        roles=row.roles,
                    )
                )

        if steps and steps[-1].ref != self.target:
            for index, step in enumerate(steps):
                if step.ref == self.target:
                    steps.append(steps.pop(index))
                    break
        return Derivation(target=self.target, steps=steps)


# --------------------------------------------------------------------------- the engine


class SystemEngine:
    """Assemble a scene's local laws into the smallest system that answers one question.

    Typical use::

        engine = SystemEngine(kb, scene)
        solution = engine.solve(Ref("loop", "electric.current"))
        solution.values           # every unknown, dimensioned
        solution.plan.blocks      # the causalisation, for the trace
        engine.cross_check(ref)   # compares against Engine A where Engine A applies
    """

    def __init__(self, kb: KnowledgeBase, scene: Scene, *, max_unknowns: int = 48) -> None:
        self.kb = kb
        self.scene = scene
        self.max_unknowns = max_unknowns
        self._sym_of: dict[Ref, str] = {}
        self._candidate_cache: dict[Ref, list[GroundEquation]] = {}
        self._viable_cache: dict[Ref, bool] = {}

    # ---------------------------------------------------------------- public

    def plan(self, target: Ref) -> Plan:
        """Choose one producer per unknown, then group the mutually dependent ones."""
        chosen: dict[Ref, GroundEquation] = {}
        pending: list[Ref] = [target]

        while pending:
            ref = pending.pop(0)
            if ref in chosen or self.scene.given(ref) is not None:
                continue
            candidates = self.candidates(ref)
            if not candidates:
                raise SystemError(
                    f"no usable law produces {ref}: it is not given, and every row in the "
                    "knowledge base that could produce it either does not bind in this scene or "
                    "depends on something nothing can produce"
                )
            candidates.sort(key=lambda e: (len(e.unknowns), e.formula.cost, e.formula.key))
            best = candidates[0]
            chosen[ref] = best
            for unknown in best.new_unknowns:
                if unknown not in chosen and self.scene.given(unknown) is None:
                    pending.append(unknown)
            if len(chosen) > self.max_unknowns:
                raise SystemError(
                    f"assembly grew past {self.max_unknowns} unknowns solving for {target}"
                )

        if not chosen:
            return Plan(target=target, blocks=[])
        return Plan(target=target, blocks=self._strongly_connected(chosen))

    def solve(self, target: Ref) -> SystemSolution:
        """Causalise, then execute: chain steps directly, blocks simultaneously."""
        plan = self.plan(target)
        values: dict[Ref, Quantity] = {}
        block_equations: dict[int, tuple[GroundEquation, ...]] = {}
        solved_equations: dict[int, tuple[GroundEquation, ...]] = {}
        system_blocks: set[int] = set()
        used_system = False

        for index, block in enumerate(plan.blocks):
            if not block.is_simultaneous:
                row = block.equations[0]
                if all(self._available(inp.ref, values) for inp in row.unknowns):
                    values.update(self._evaluate(row, values))
                    block_equations[index] = block.equations
                    solved_equations[index] = block.equations
                    continue
            solved, rows, independent = self._solve_block(block, values)
            values.update(solved)
            block_equations[index] = rows
            solved_equations[index] = independent
            system_blocks.add(index)
            used_system = True

        if target not in values and self.scene.given(target) is None:
            raise SystemError(f"solved {len(values)} unknown(s) but not the target {target}")

        return SystemSolution(
            target=target,
            values=values,
            plan=plan,
            block_equations=block_equations,
            solved_equations=solved_equations,
            system_blocks=system_blocks,
            method="system" if used_system else "chain",
            residual=self._residual(block_equations, values),
        )

    def cross_check(self, target: Ref) -> dict:
        """Run Engine A on the same scene and compare, where Engine A applies at all."""
        chain = Resolver(self.kb, self.scene).resolve(target)
        system = self.solve(target)
        if not chain:
            return {
                "engines": ["system"],
                "value": system.value,
                "blocks": len(system.plan.blocks),
                "simultaneous": len(system.plan.simultaneous),
                "note": "Engine A cannot reach this target; the system is genuinely simultaneous",
            }
        a_value, b_value = chain[0].value, system.value
        a = a_value.magnitude if a_value.is_vector else float(a_value.value)  # type: ignore[arg-type]
        b = b_value.magnitude if b_value.is_vector else float(b_value.value)  # type: ignore[arg-type]
        scale = max(abs(a), 1e-30)
        return {
            "engines": ["chain", "system"],
            "chain": a_value,
            "system": b_value,
            "rel_error": abs(a - b) / scale,
            "agree": abs(a - b) / scale <= 1e-9,
            "chain_paths": len(chain),
            "system_blocks": len(system.plan.blocks),
            "simultaneous_blocks": len(system.plan.simultaneous),
        }

    def equations_text(self, rows) -> list[str]:
        """The assembled equations, as the lines a student would write down.

        Unknowns are named before the givens are inserted: a rendered value
        carries its unit, and ``1 V`` contains the very letter a later
        substitution would be looking for.
        """
        out: list[str] = []
        for row in rows:
            text = row.formula.expr_text
            for inp in row.unknowns:
                assert inp.ref is not None
                text = _sub_word(text, inp.symbol, str(inp.ref))
            for inp in row.knowns:
                text = _sub_word(text, inp.symbol, format_quantity(inp.quantity))
            out.append(f"{row.target} = {text}      [{row.formula.key}, {row.formula.law}]")
        return out

    # ------------------------------------------------------------- grounding

    def candidates(self, ref: Ref) -> list[GroundEquation]:
        """Every row that could produce ``ref`` here and whose own inputs are all producible.

        The viability filter is what keeps the assembly honest: a row that
        divides by a resistance nothing can produce is not a candidate, however
        algebraically tempting it looks.
        """
        if ref in self._candidate_cache:
            return self._candidate_cache[ref]
        rows: list[GroundEquation] = []
        component = self.scene.instances.get(ref.instance)
        for formula in self.kb.solvers_for(ref.prop):
            if not self._state_matches(formula, ref):
                continue
            # A row that names the components it is a law of is not a row for this instance
            # otherwise. Ohm's law is not true across a battery's terminals, and an assembly
            # that assumes it is will report a contradiction in the physics rather than a gap
            # in the knowledge base.
            if formula.applies_to and (
                component is None or component.kind not in formula.applies_to
            ):
                continue
            for binding_map in self._role_bindings(formula, ref):
                row = self._ground(formula, ref, binding_map)
                if row is not None and all(self._viable(u) for u in row.new_unknowns):
                    rows.append(row)
        self._candidate_cache[ref] = rows
        return rows

    def _viable(self, ref: Ref) -> bool:
        """Could this reference ever be produced? Cycles count as provisionally viable."""
        if self.scene.given(ref) is not None:
            return True
        if ref in self._viable_cache:
            return self._viable_cache[ref]
        self._viable_cache[ref] = True  # assume viable while inside the cycle
        ok = False
        for row in self.candidates(ref):
            if all(self._viable(u) for u in row.new_unknowns):
                ok = True
                break
        self._viable_cache[ref] = ok
        return ok

    @staticmethod
    def _state_matches(formula: Formula, ref: Ref) -> bool:
        return formula.produces_state is None or ref.state == formula.produces_state

    def _role_bindings(
        self, formula: Formula, ref: Ref
    ) -> list[dict[str, tuple[str, Relation | None]]]:
        if formula.scope == "self":
            return [{}]
        per_role: list[list[tuple[str, tuple[str, Relation | None]]]] = []
        for name, role in formula.roles.items():
            options: list[tuple[str, tuple[str, Relation | None]]] = []
            if role.scene or role.via is None:
                for iid, inst in self.scene.instances.items():
                    if not role.kinds or inst.kind in role.kinds:
                        options.append((name, (iid, None)))
            else:
                for relation in self.scene.relations_from(ref.instance, role.via):
                    if self._kind_ok(relation.to, role.kinds):
                        options.append((name, (relation.to, relation)))
                for relation in self.scene.relations_into(ref.instance, role.via):
                    if self._kind_ok(relation.frm, role.kinds):
                        options.append((name, (relation.frm, relation)))
            if not options:
                return []
            per_role.append(options)
        combos = [dict(combo) for combo in product(*per_role)]
        return [c for c in combos if len({inst for inst, _ in c.values()}) == len(c)]

    def _kind_ok(self, iid: str, kinds: tuple[str, ...]) -> bool:
        if not kinds:
            return True
        inst = self.scene.instances.get(iid)
        return inst is not None and inst.kind in kinds

    def _ground(
        self, formula: Formula, ref: Ref, binding_map: dict[str, tuple[str, Relation | None]]
    ) -> GroundEquation | None:
        unknowns: list[Input] = []
        knowns: list[Input] = []
        for symbol, binding in formula.bindings.items():
            resolved = self._bind(symbol, binding, ref, binding_map)
            if resolved is None:
                return None
            (unknowns if resolved.quantity is None else knowns).append(resolved)
        roles = tuple(sorted((name, inst) for name, (inst, _) in binding_map.items()))
        return GroundEquation(
            formula=formula,
            target=ref,
            roles=roles,
            unknowns=tuple(unknowns),
            knowns=tuple(knowns),
        )

    def _bind(
        self,
        symbol: str,
        binding: Binding,
        ref: Ref,
        binding_map: dict[str, tuple[str, Relation | None]],
    ) -> Input | None:
        if binding.is_const:
            constant = self.kb.ontology.constants.get(binding.const or "")
            if constant is None:
                return None
            return Input(symbol=symbol, ref=None, const=constant.key, quantity=constant.quantity)

        rel_role = binding.relation_role
        if rel_role is not None:
            name = next(iter(binding_map)) if rel_role == REL else rel_role
            entry = binding_map.get(name)
            if entry is None or entry[1] is None:
                return None
            relation = entry[1]
            assert binding.prop is not None
            value = relation.get(binding.prop, binding.state)
            if value is None:
                return None
            # A relation owns its property, so naming the relation is the honest provenance.
            return Input(symbol=symbol, ref=None, const=f"{relation.kind} relation", quantity=value)

        if binding.frm == SELF:
            owner = ref.instance
        else:
            entry = binding_map.get(binding.frm)
            if entry is None:
                return None
            owner = entry[0]

        assert binding.prop is not None
        state = ref.state if binding.state == SAME_STATE else binding.state
        source = Ref(owner, binding.prop, state)
        given = self.scene.given(source)
        if given is None:
            return Input(symbol=symbol, ref=source, const=None, quantity=None)  # type: ignore[arg-type]
        return Input(symbol=symbol, ref=source, const=None, quantity=given)

    # -------------------------------------------------------------- execution

    def _available(self, ref: Ref | None, values: dict[Ref, Quantity]) -> bool:
        return ref is not None and (ref in values or self.scene.given(ref) is not None)

    def _evaluate(self, row: GroundEquation, values: dict[Ref, Quantity]) -> dict[Ref, Quantity]:
        env: dict[str, Quantity] = {}
        for inp in row.knowns:
            env[inp.symbol] = inp.quantity
        for inp in row.unknowns:
            assert inp.ref is not None
            quantity = values.get(inp.ref) or self.scene.given(inp.ref)
            if quantity is None:
                raise SystemError(f"{row.formula.key}: {inp.ref} was never solved")
            env[inp.symbol] = quantity
        try:
            value = exprs.evaluate(row.formula.expr, env, where=row.formula.key)
        except ZeroDivisionError as exc:
            raise SystemError(f"{row.formula.key}: division by zero") from exc
        except Exception as exc:
            raise SystemError(f"{row.formula.key}: {exc}") from exc
        return {row.target: self._typed(row.target, value)}

    def _solve_block(
        self, block: Block, values: dict[Ref, Quantity]
    ) -> tuple[dict[Ref, Quantity], tuple[GroundEquation, ...], tuple[GroundEquation, ...]]:
        """Grow the block until its equations determine its unknowns, then solve it.

        The loop is driven by *degrees of freedom* — unknowns minus independent
        equations — rather than by a simple rank test, because a block is only
        finished when adding laws no longer reduces the freedom left in it.
        """
        rows: list[GroundEquation] = list(block.equations)
        unknowns: list[Ref] = self._closure(rows, list(block.unknowns), values)
        used: set[tuple] = {row.identity for row in rows}
        attempts = ""

        while True:
            if len(rows) > MAX_ROWS or len(unknowns) > self.max_unknowns:
                raise SystemError(
                    f"the block around {block.unknowns[0]} grew past {MAX_ROWS} equations without "
                    f"becoming determined — the scene is missing a law or a given.{attempts}"
                )
            dof = self._dof(rows, unknowns, values)
            if dof is not None and dof <= 0:
                unknowns = self._closure(rows, unknowns, values)
                independent = self._independent_subset(rows, unknowns, values)
                status, solutions, free = self._solve_square(independent, unknowns, values)
                if status == "unique" and solutions is not None:
                    if self._rank_at(rows, unknowns, solutions, values) >= len(unknowns):
                        residual = self._rows_residual(rows, unknowns, solutions, values)
                        if residual > 1e-6:
                            raise SystemError(
                                f"the assembled equations are inconsistent (worst residual "
                                f"{residual:.2e}); the scene over-constrains the physics"
                            )
                        return (
                            {
                                unknown: Quantity(
                                    value=solutions[unknown],
                                    dim=self._dim_of(unknown),
                                    rank=self._rank_of(unknown),
                                )
                                for unknown in unknowns
                            },
                            tuple(rows),
                            tuple(independent),
                        )
                if status in ("family", "none"):
                    # Over-determined is not a problem, it is redundancy: the same law written
                    # in two directions. A square subset can still collapse on the solution set,
                    # so before hunting for another law, try the whole block as assembled.
                    status_all, solutions_all, free_all = self._solve_square(rows, unknowns, values)
                    if status_all == "unique" and solutions_all is not None:
                        solutions, free, status = solutions_all, [], "unique"
                        if self._rank_at(rows, unknowns, solutions, values) >= len(unknowns):
                            residual = self._rows_residual(rows, unknowns, solutions, values)
                            if residual > 1e-6:
                                raise SystemError(
                                    f"the assembled equations are inconsistent (worst residual "
                                    f"{residual:.2e}); the scene over-constrains the physics"
                                )
                            return (
                                {
                                    unknown: Quantity(
                                        value=solutions[unknown],
                                        dim=self._dim_of(unknown),
                                        rank=self._rank_of(unknown),
                                    )
                                    for unknown in unknowns
                                },
                                tuple(rows),
                                tuple(self._independent_subset(rows, unknowns, values)),
                            )
                    free = free_all or free
                if status == "family":
                    # The solver named the quantity it could not pin down. That is a far better
                    # hint than a rank number: go and find a law for *that* quantity.
                    addition = self._addition_for(free, used, unknowns)
                    if addition is not None:
                        rows.append(addition)
                        used.add(addition.identity)
                        unknowns = self._closure(rows, unknowns, values)
                        continue
                attempts += (
                    f"\n  tried {len(rows)} equation(s) for {len(unknowns)} unknown(s): "
                    + (
                        f"a family, still free in {', '.join(str(f) for f in free)}"
                        if status == "family"
                        else "no unique real solution"
                    )
                )

            addition = self._best_addition(rows, unknowns, used, values)
            if addition is None:
                rendered = "\n  ".join(self.equations_text(rows))
                raise SystemError(
                    f"the system is under-determined: {len(rows)} equation(s) leave "
                    f"{max(self._dof(rows, unknowns, values) or 0, 0)} degree(s) of freedom in "
                    f"{len(unknowns)} unknown(s), and the knowledge base has no further law for "
                    f"them. Equations:\n  {rendered}{attempts}"
                )
            rows.append(addition)
            used.add(addition.identity)
            unknowns = self._closure(rows, unknowns, values)

    def _best_addition(
        self, rows: list[GroundEquation], unknowns: list[Ref], used: set[tuple], values
    ) -> GroundEquation | None:
        """The law that removes the most freedom, then the fewest new unknowns.

        Ranking by freedom removed is what keeps a block small: without it the
        loop cheerfully adds another rearrangement of a law it already has, and
        the trace fills up with the same equation written twice.
        """
        base = self._dof(rows, unknowns, values)
        best: tuple[tuple[int, int, int, str], GroundEquation] | None = None
        in_block = set(unknowns)
        for unknown in unknowns:
            for row in self.candidates(unknown):
                if row.identity in used:
                    continue
                after = self._dof(rows + [row], unknowns, values)
                freedom = (base if base is not None else 0) - (after if after is not None else 0)
                fresh = len([u for u in row.new_unknowns if u not in in_block])
                key = (-freedom, fresh, row.formula.cost, row.formula.key)
                if best is None or key < best[0]:
                    best = (key, row)
        return best[1] if best else None

    def _closure(
        self, rows, unknowns: list[Ref], values: dict[Ref, Quantity]
    ) -> list[Ref]:
        """Every unknown the block's equations actually mention.

        A row in the block may reach for something the causalisation never put in it —
        typically a quantity an ancestor block was going to get to later. It joins the
        block: solving it early is harmless, silently substituting a value that does not
        exist yet is not.
        """
        out = list(unknowns)
        changed = True
        while changed:
            changed = False
            for row in rows:
                for ref in row.new_unknowns:
                    if ref not in out and ref not in values and self.scene.given(ref) is None:
                        out.append(ref)
                        changed = True
        return out

    def _dof(self, rows, unknowns: list[Ref], values) -> int | None:
        """Degrees of freedom left in the block: unknowns minus independent equations."""
        closed = self._closure(rows, unknowns, values)
        rank = self._structural_rank(rows, closed, values)
        if rank is None:
            return None
        return len(closed) - rank

    # ------------------------------------------------------------ rank & solve

    def _residual_expressions(
        self, rows, unknowns, values: dict[Ref, Quantity]
    ) -> list[sp.Expr] | None:
        """``target - expression`` per row: knowns numeric, block unknowns symbolic.

        Substitution is done on the parsed tree, never on the text. Replacing a
        symbol inside a string looks safe and is not: the symbol ``V`` appears
        inside the rendered value ``1 V``, and one careless pass turns
        ``(emf - V)/r`` into ``(1*V - V)/r``.
        """
        block = set(unknowns)
        out: list[sp.Expr] = []
        for row in rows:
            subs: dict[sp.Symbol, sp.Expr] = {}
            for inp in row.knowns:
                subs[sp.Symbol(inp.symbol)] = _literal(inp.quantity)
            for inp in row.unknowns:
                assert inp.ref is not None
                if inp.ref in block:
                    subs[sp.Symbol(inp.symbol)] = sp.Symbol(self._symbol(inp.ref))
                else:
                    quantity = values.get(inp.ref) or self.scene.given(inp.ref)
                    if quantity is None:
                        raise SystemError(f"{row.formula.key}: {inp.ref} was never solved")
                    subs[sp.Symbol(inp.symbol)] = _literal(quantity)
            head = (
                sp.Symbol(self._symbol(row.target))
                if row.target in block
                else _literal(values.get(row.target) or self.scene.given(row.target))
            )
            expr = head - row.formula.expr.subs(subs)
            if expr.has(sp.zoo, sp.nan, sp.oo, -sp.oo):
                return None  # a division by a literal zero: this row is unusable here
            out.append(expr)
        return out

    def _structural_rank(self, rows, unknowns, values: dict[Ref, Quantity]) -> int | None:
        """Rank of the Jacobian at a random rational point: how much the rows really pin down.

        A random point is what makes this *structural* rather than accidental: two
        rearrangements of Ohm's law are dependent everywhere, and no unlucky
        choice of values can make them look independent.
        """
        residuals = self._residual_expressions(rows, unknowns, values)
        if residuals is None:
            return None
        syms = list(sp.ordered({s for e in residuals for s in e.free_symbols} & {
            sp.Symbol(self._symbol(u)) for u in unknowns
        }))
        if not syms:
            return 0
        jacobian = sp.Matrix([[sp.diff(e, s) for s in syms] for e in residuals])
        random.seed(20241118)  # fixed: the structural rank must not flicker between runs
        for _ in range(6):
            point = {s: sp.Rational(random.randint(2, 40), random.randint(1, 9)) for s in syms}
            try:
                numeric = jacobian.subs(point)
            except Exception:
                continue
            if numeric.has(sp.zoo, sp.nan, sp.oo, -sp.oo):
                continue
            try:
                return int(sp.Matrix(numeric).rank())
            except Exception:
                continue
        return 0

    def _independent_subset(self, rows, unknowns, values: dict[Ref, Quantity]):
        """A maximal independent subset: one equation per unknown, no redundancy.

        Solving a square system instead of an over-determined one is both faster
        and safer; every row left out is still checked afterwards through the
        residual, so dropping it here cannot hide an inconsistency.
        """
        residuals = self._residual_expressions(rows, unknowns, values)
        assert residuals is not None
        chosen: list[sp.Expr] = []
        chosen_rows: list[GroundEquation] = []
        covered: set[Ref] = set()
        for row, residual in zip(rows, residuals):
            if len(chosen_rows) == len(unknowns) and covered.issuperset(unknowns):
                break
            trial = chosen + [residual]
            if self._rank_of_rows(trial, unknowns) > len(chosen) or row.target not in covered:
                chosen.append(residual)
                chosen_rows.append(row)
                covered.add(row.target)
        # Every unknown must appear in the trace even when it is not needed for the rank: a
        # reader following the derivation should not find a quantity used but never derived.
        for row in rows:
            if row.target not in covered:
                chosen_rows.append(row)
                covered.add(row.target)
        return chosen_rows

    def _rank_at(self, rows, unknowns, solutions: dict[Ref, float], values) -> int:
        """Rank of the Jacobian *at the solution*: is this answer isolated, or one of a family?

        A block that is generically well-determined can still collapse on its own solution set —
        the determinant of the Jacobian can be a multiple of one of the equations. Checking at
        the answer is what catches that, and it is the difference between reporting a number and
        reporting a one-parameter family as if it were a number.
        """
        residuals = self._residual_expressions(rows, unknowns, values)
        if residuals is None:
            return 0
        syms = [sp.Symbol(self._symbol(u)) for u in unknowns]
        point = {s: sp.Float(v) for s, v in ((s, solutions[u]) for u, s in zip(unknowns, syms))}
        try:
            jacobian = sp.Matrix([[sp.diff(e, s) for s in syms] for e in residuals]).subs(point)
            if jacobian.has(sp.zoo, sp.nan, sp.oo, -sp.oo):
                return 0
            return int(sp.Matrix(jacobian).rank(iszerofunc=lambda x: abs(complex(x)) < 1e-9))
        except Exception:
            return 0

    def _rank_of_rows(self, residuals, unknowns) -> int:
        syms = [sp.Symbol(self._symbol(u)) for u in unknowns]
        if not residuals:
            return 0
        jacobian = sp.Matrix([[sp.diff(e, s) for s in syms] for e in residuals])
        random.seed(7919)
        point = {s: sp.Rational(random.randint(2, 40), random.randint(1, 9)) for s in syms}
        try:
            numeric = jacobian.subs(point)
            if numeric.has(sp.zoo, sp.nan, sp.oo, -sp.oo):
                return 0
            return int(sp.Matrix(numeric).rank())
        except Exception:
            return 0

    def _solve_square(
        self, rows, unknowns: list[Ref], values: dict[Ref, Quantity]
    ) -> tuple[str, dict[Ref, float] | None, list[Ref]]:
        """Solve a determined block, reporting what it could not determine.

        Returns ``(status, solution, free)``:

        ``unique``  every unknown has exactly one real value;
        ``family``  the equations hold for a range of values, and ``free`` names the
                    quantities left undetermined — the caller uses this to fetch another law;
        ``none``    no real solution at all.

        Two distinct real solutions are reported as ``none`` rather than picked between:
        a circuit with two operating points is a question for a physicist, not a coin toss.
        """
        residuals = self._residual_expressions(rows, unknowns, values)
        if residuals is None:
            return "none", None, []
        syms = [sp.Symbol(self._symbol(u)) for u in unknowns]
        equations = [sp.Eq(sp.together(e), 0) for e in residuals]

        candidates: list[list[float]] = []
        family: list[list] = []
        for attempt in ("linsolve", "solve"):
            if attempt == "linsolve":
                try:
                    solution_set = sp.linsolve([sp.expand(e.lhs) for e in equations], syms)
                    raw = [dict(zip(syms, tuple_solution)) for tuple_solution in solution_set]
                except Exception:
                    raw = []
            else:
                if candidates:
                    break
                try:
                    raw = sp.solve(equations, syms, dict=True)
                except Exception:
                    raw = []
                if isinstance(raw, dict):
                    raw = [raw]
            for candidate in raw:
                if not candidate:
                    continue
                # A family is recognised before the completeness check: sympy reports an
                # under-determined system by leaving the free quantity out of the dict
                # altogether, so a short dict is the normal shape of a family, not a discard.
                if any(value.free_symbols for value in candidate.values()):
                    family.append(candidate)
                    continue
                if len(candidate) != len(syms):
                    continue
                reals = _as_reals([candidate[s].evalf() for s in syms])
                if reals is not None:
                    candidates.append(reals)

        unique: list[list[float]] = []
        for candidate in candidates:
            if not any(_same(candidate, kept) for kept in unique):
                unique.append(candidate)
        if len(unique) == 1:
            return "unique", dict(zip(unknowns, unique[0])), []
        if family:
            free_symbols = {s for candidate in family for v in candidate.values() for s in v.free_symbols}
            name_to_ref = {name: ref for ref, name in self._sym_of.items()}
            free = [
                name_to_ref[s.name]
                for s in free_symbols
                if s.name in name_to_ref and name_to_ref[s.name] in unknowns
            ]
            return "family", None, free
        return "none", None, []

    def _addition_for(
        self, free: list[Ref], used: set[tuple], unknowns: list[Ref]
    ) -> GroundEquation | None:
        """The cheapest unused law for one of the quantities the solver left free."""
        best: tuple[tuple[int, int, str], GroundEquation] | None = None
        in_block = set(unknowns)
        for ref in free:
            for row in self.candidates(ref):
                if row.identity in used:
                    continue
                fresh = len([u for u in row.new_unknowns if u not in in_block])
                key = (fresh, row.formula.cost, row.formula.key)
                if best is None or key < best[0]:
                    best = (key, row)
        return best[1] if best else None

    def _rows_residual(
        self, rows, unknowns, solutions: dict[Ref, float], values: dict[Ref, Quantity]
    ) -> float:
        """Worst relative mismatch over *every* row in the block, including the dropped ones."""
        residuals = self._residual_expressions(rows, unknowns, values)
        if residuals is None:
            return float("inf")
        substitution = {
            sp.Symbol(self._symbol(u)): sp.Float(v) for u, v in solutions.items()
        }
        worst = 0.0
        for row, residual in zip(rows, residuals):
            try:
                value = complex(residual.subs(substitution).evalf())
            except Exception:
                return float("inf")
            if not abs(value.imag) < 1e-9:
                return float("inf")
            scale = max(abs(solutions.get(row.target, 0.0)), 1e-30)
            worst = max(worst, abs(value.real) / scale)
        return worst

    def _residual(
        self, block_equations: dict[int, tuple[GroundEquation, ...]], values: dict[Ref, Quantity]
    ) -> float:
        """Post-solution sanity check: re-evaluate every used row on the solved values."""
        worst = 0.0
        for rows in block_equations.values():
            for row in rows:
                env: dict[str, Quantity] = {}
                skip = False
                for inp in row.knowns:
                    env[inp.symbol] = inp.quantity
                for inp in row.unknowns:
                    assert inp.ref is not None
                    quantity = values.get(inp.ref) or self.scene.given(inp.ref)
                    if quantity is None:
                        skip = True
                        break
                    env[inp.symbol] = quantity
                if skip:
                    continue
                try:
                    evaluated = exprs.evaluate(row.formula.expr, env, where=row.formula.key)
                except Exception:
                    continue
                got = abs(float(evaluated.value)) if not evaluated.is_vector else evaluated.magnitude  # type: ignore[arg-type]
                want = values[row.target]
                want_value = abs(float(want.value)) if not want.is_vector else want.magnitude  # type: ignore[arg-type]
                worst = max(worst, abs(got - want_value) / max(want_value, 1e-30))
        return worst

    # ---------------------------------------------------------------- helpers

    def _symbol(self, ref: Ref) -> str:
        if ref not in self._sym_of:
            name = f"{ref.instance}__{ref.prop.replace('.', '_')}"
            if ref.state:
                name += f"__{ref.state}"
            self._sym_of[ref] = name
        return self._sym_of[ref]

    def _dim_of(self, ref: Ref) -> Dim:
        return self.kb.ontology.prop(ref.prop).dim

    def _rank_of(self, ref: Ref) -> str:
        return self.kb.ontology.prop(ref.prop).rank

    def _typed(self, ref: Ref, value: Quantity) -> Quantity:
        declared = self.kb.ontology.prop(ref.prop)
        # A literal zero belongs to every dimension space, exactly as it does in Engine A: the
        # shielded-cavity row is `0`, and it answers a question measured in V/m.
        if value.is_vector:
            is_zero = all(c == 0 for c in value.value)  # type: ignore[union-attr]
        else:
            is_zero = float(value.value) == 0.0  # type: ignore[arg-type]
        if is_zero:
            return Quantity(
                value=value.value, dim=declared.dim, rank=declared.rank, text=value.text
            )
        if value.dim != declared.dim or value.rank != declared.rank:
            raise SystemError(
                f"{ref}: computed {value.dim} ({value.rank}) but the property is "
                f"{declared.dim} ({declared.rank})"
            )
        return value

    # ---------------------------------------------------------- causalisation

    @staticmethod
    def _strongly_connected(chosen: dict[Ref, GroundEquation]) -> list[Block]:
        """Tarjan's algorithm over ``unknown -> the unknowns its row needs``.

        Components emerge with every dependency already emitted, which is solve
        order: the triangular part of a problem stays a chain of one-node
        blocks, and only a genuine cycle becomes a simultaneous block.
        """
        index_of: dict[Ref, int] = {}
        low: dict[Ref, int] = {}
        on_stack: dict[Ref, bool] = {}
        stack: list[Ref] = []
        components: list[list[Ref]] = []
        counter = 0

        def edges(ref: Ref) -> list[Ref]:
            return [u for u in chosen[ref].new_unknowns if u in chosen]

        def strongconnect(root: Ref) -> None:
            nonlocal counter
            work: list[tuple[Ref, int]] = [(root, 0)]
            while work:
                ref, child_index = work[-1]
                if child_index == 0:
                    index_of[ref] = low[ref] = counter
                    counter += 1
                    stack.append(ref)
                    on_stack[ref] = True
                recursed = False
                children = edges(ref)
                while child_index < len(children):
                    child = children[child_index]
                    child_index += 1
                    work[-1] = (ref, child_index)
                    if child not in index_of:
                        work.append((child, 0))
                        recursed = True
                        break
                    if on_stack.get(child):
                        low[ref] = min(low[ref], index_of[child])
                if recursed:
                    continue
                if low[ref] == index_of[ref]:
                    component: list[Ref] = []
                    while True:
                        member = stack.pop()
                        on_stack[member] = False
                        component.append(member)
                        if member == ref:
                            break
                    components.append(component)
                work.pop()
                if work:
                    parent, _ = work[-1]
                    low[parent] = min(low[parent], low[ref])

        for ref in chosen:
            if ref not in index_of:
                strongconnect(ref)

        return [
            Block(unknowns=tuple(sorted(c, key=str)), equations=tuple(chosen[u] for u in sorted(c, key=str)))
            for c in components
        ]


# --------------------------------------------------------------------------- utilities


def _as_reals(values: list) -> list[float] | None:
    """Accept a candidate solution only if every component is real to within round-off."""
    out: list[float] = []
    for value in values:
        try:
            as_complex = complex(value)
        except (TypeError, ValueError):
            return None
        if abs(as_complex.imag) > 1e-9 * max(1.0, abs(as_complex.real)):
            return None
        out.append(as_complex.real)
    return out


def _same(a: list[float], b: list[float], tol: float = 1e-9) -> bool:
    return all(abs(x - y) <= tol * max(1.0, abs(x), abs(y)) for x, y in zip(a, b))


def _literal(quantity: Quantity | None) -> sp.Expr:
    """A value as a sympy number. Vectors are not yet part of any assembled system."""
    if quantity is None:
        raise SystemError("a value the assembly needs was never solved")
    if quantity.is_vector:
        raise SystemError(
            f"Engine B cannot yet assemble a system over the vector value {quantity}; "
            "reduce it to its magnitude first"
        )
    return sp.Float(float(quantity.value), 20)  # type: ignore[arg-type]


def _sub_word(text: str, symbol: str, replacement: str) -> str:
    """Replace ``symbol`` as a whole word, so ``s`` never eats the ``s`` in ``sqrt``."""
    import re

    return re.sub(rf"\b{re.escape(symbol)}\b", replacement.replace("\\", "\\\\"), text)

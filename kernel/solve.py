"""Choosing an engine, and making the two of them check each other.

Engine A is fast and narrates beautifully, but it only walks chains. Engine B
assembles and solves. The honest thing is not to pick one, but to run A first
and fall back to B — and wherever both reach an answer, to compare them.

That comparison is the kernel's strongest verification story. Two engines of
different construction, reading the same knowledge base, arriving at the same
number to within 1e-9 is not a claim about being lawful; it is a measurement of
it. And when only one engine can answer at all, the answer still carries the
name of the engine that produced it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .engine_chain import Derivation, Resolver
from .engine_system import SystemEngine
from .kb import KnowledgeBase
from .scene import Problem

#: Relative agreement two engines must reach before the kernel believes either of them.
AGREEMENT_TOLERANCE = 1e-9


@dataclass
class SolveResult:
    """Every derivation of a problem's target, plus how they were reached and checked."""

    problem: Problem
    derivations: list[Derivation]
    engine: str                      # "chain" | "system"
    engines_tried: tuple[str, ...] = ()
    #: Where both engines answered: how far apart they were.
    cross_check: dict = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    @property
    def resolved(self) -> bool:
        return bool(self.derivations)

    @property
    def value(self):
        return self.derivations[0].value if self.derivations else None

    @property
    def agrees(self) -> bool:
        """False when both engines answered and they disagree — a real knowledge-base bug."""
        if not self.cross_check:
            return True
        return bool(self.cross_check.get("agree", True))


def _magnitude(quantity) -> float:
    return quantity.magnitude if quantity.is_vector else float(quantity.value)  # type: ignore[arg-type]


def solve_problem(kb: KnowledgeBase, problem: Problem, *, cross_check: bool = True) -> SolveResult:
    """Resolve ``problem`` with Engine A, falling back to Engine B, and compare where both can.

    Engine A first: it is the cheap one, and its derivations are the ones worth
    showing a student. Engine B only runs when A cannot reach the target at all
    — or, when ``cross_check`` is set, alongside it, purely to disagree loudly if
    the knowledge base has grown a contradiction.
    """
    resolver = Resolver(kb, problem.scene)
    derivations = resolver.resolve(problem.target)
    result = SolveResult(problem=problem, derivations=derivations, engine="chain")

    if derivations:
        result.engines_tried = ("chain",)
        if cross_check:
            try:
                system = SystemEngine(kb, problem.scene).solve(problem.target)
            except Exception as exc:  # Engine B declining is not an error in Engine A
                result.notes.append(f"Engine B could not cross-check this scene: {exc}")
                return result
            a, b = _magnitude(derivations[0].value), _magnitude(system.value)
            scale = max(abs(a), 1e-30)
            result.engines_tried = ("chain", "system")
            result.cross_check = {
                "chain": derivations[0].value,
                "system": system.value,
                "rel_error": abs(a - b) / scale,
                "agree": abs(a - b) / scale <= AGREEMENT_TOLERANCE,
                "system_blocks": len(system.plan.blocks),
                "simultaneous_blocks": system.simultaneous_blocks,
            }
        return result

    failure = str(resolver.failure(problem.target))
    try:
        system = SystemEngine(kb, problem.scene).solve(problem.target)
    except Exception as exc:
        result.notes.append(f"Engine A: {failure}")
        result.notes.append(f"Engine B: {exc}")
        return result

    result.derivations = [system.to_derivation(kb)]
    result.engine = "system"
    result.engines_tried = ("chain", "system")
    result.notes.append(f"Engine A: {failure}")
    result.notes.append(
        f"Engine B: solved {len(system.values)} unknown(s) in "
        f"{len(system.plan.blocks)} block(s), {system.simultaneous_blocks} of them simultaneous"
    )
    return result

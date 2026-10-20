"""One door into the engines: chain first, system second, agreement always.

Engine A (chain) is tried first — its derivations are the most legible. When the chain
cannot reach a target but the scene is a nodal circuit, Engine B (system assembly)
answers, and the SimSpec records which engine spoke. Where both can reach, the audit's
coverage check runs both and asserts agreement (the cross-engine cross-check).
"""

from __future__ import annotations

from .engine_chain import Derivation, Resolver
from .engine_system import SystemError, solve_system
from .kb import KnowledgeBase
from .scene import Problem


def resolve_problem(kb: KnowledgeBase, problem: Problem) -> tuple[list[Derivation], str]:
    """(derivations, engine) with engine "chain" | "system" | "" (unresolved)."""
    derivations = Resolver(kb, problem.scene).resolve(problem.target)
    if derivations:
        return derivations, "chain"
    try:
        system = solve_system(kb, problem.scene, problem.target)
    except SystemError:
        system = None
    if system is not None:
        return [system], "system"
    return [], ""


def cross_check(kb: KnowledgeBase, problem: Problem) -> str | None:
    """When both engines reach the target, return a disagreement message or None."""
    chain = Resolver(kb, problem.scene).resolve(problem.target)
    if not chain:
        return None
    try:
        system = solve_system(kb, problem.scene, problem.target)
    except SystemError:
        return None
    if system is None:
        return None
    a = chain[0].value
    b = system.value
    av = a.magnitude if a.is_vector else float(a.value)
    bv = b.magnitude if b.is_vector else float(b.value)
    if abs(av - bv) / max(abs(av), 1e-30) > 1e-9:
        return f"engines disagree: chain gives {av} but system gives {bv}"
    return None


def build_problem_spec(kb: KnowledgeBase, problem: Problem):
    """Resolve a problem and compile its SimSpec, attaching an Engine C trajectory
    when the problem declares `simulate:`. A failed trajectory never sinks the lesson:
    the algebraic spec stands, and tests assert the corpus trajectories exist."""
    from .trace import build_simspec

    derivations, engine = resolve_problem(kb, problem)
    trajectory = None
    if problem.simulate:
        from .engine_ode import ODEError, simulate

        try:
            trajectory = simulate(
                kb,
                problem.scene,
                str(problem.simulate.get("instance") or problem.target.instance),
                float(problem.simulate["duration"]),
                samples=int(problem.simulate.get("samples", 120)),
            )
        except (ODEError, KeyError, ValueError):
            trajectory = None
    spec = build_simspec(problem, derivations, kb, engine=engine or "chain", trajectory=trajectory)
    return spec, derivations, engine

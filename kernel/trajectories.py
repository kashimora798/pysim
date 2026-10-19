"""The trajectory corpus: time-evolution problems with known answers.

Engine C's proof, in the same shape as the rest of the project. A chain problem
is only believed because the corpus says what number it must reach; a
trajectory is only believed because this corpus says what curve it must follow.
Each entry declares a builder, its arguments, the integration settings, and the
closed-form value the sampled answer is held to.

The tolerance is looser than the algebraic corpus's, and deliberately so: an
integrator has a truncation error that is a property of the method and the step
size, not a mistake. Recording the method and ``dt`` next to the tolerance is
what keeps that honesty visible rather than hidden behind a passing test.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

from .dims import Dim
from .engine_ode import (
    ODEProblem,
    ODEVariable,
    constant_acceleration,
    projectile_in_gravity,
    rc_charging,
)
from .scene import Ref
from .units import Quantity, parse_quantity

TRAJECTORY_DIR = Path(__file__).resolve().parent.parent / "corpus" / "trajectories"


class TrajectoryCorpusError(ValueError):
    """Raised when a trajectory entry is malformed."""


#: The builders a trajectory file may name. Each takes the file's `args` plus the
#: integration settings and returns a ready ODEProblem.
BUILDERS = {
    "constant_acceleration": constant_acceleration,
    "rc_charging": rc_charging,
    "projectile_in_gravity": projectile_in_gravity,
}


@dataclass
class TrajectoryExpectation:
    value: float
    unit: str
    tol: float = 1e-4
    note: str = ""


@dataclass
class TrajectoryProblem:
    id: str
    title: str
    text: str
    problem: ODEProblem
    target: Ref
    expect: TrajectoryExpectation | None
    tags: tuple[str, ...] = ()
    source: str = ""
    path: Path | None = None


def _ref(spec: str) -> Ref:
    instance, _, rest = spec.partition(".")
    if not instance or not rest:
        raise TrajectoryCorpusError(f"a target ref looks like 'c1.em.potential_difference', got {spec!r}")
    prop, _, state = rest.partition("@")
    return Ref(instance, prop, state or None)


def load_trajectory(path: Path) -> TrajectoryProblem:
    """Read one trajectory entry."""
    doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    where = path.name

    builder_name = str(doc.get("problem") or "")
    if builder_name not in BUILDERS:
        raise TrajectoryCorpusError(
            f"{where}: unknown builder {builder_name!r}; choose one of {sorted(BUILDERS)}"
        )
    args = dict(doc.get("args") or {})
    settings = {
        "t_span": tuple(doc.get("t_span") or (0.0, 1.0)),
        "dt": float(doc.get("dt", 0.001)),
        "method": str(doc.get("method", "rk4")),
        "name": str(doc.get("title") or path.stem),
    }
    refs = {
        key: _ref(str(value)) for key, value in (doc.get("refs") or {}).items()
    }
    try:
        problem = BUILDERS[builder_name](**refs, **args, **settings)
    except TypeError as exc:
        raise TrajectoryCorpusError(f"{where}: {builder_name} did not accept these arguments: {exc}") from exc

    target = _ref(str((doc.get("target") or {}).get("ref") or ""))

    expect = None
    if doc.get("expect"):
        e = doc["expect"]
        expect = TrajectoryExpectation(
            value=float(e["value"]),
            unit=str(e.get("unit", "")),
            tol=float(e.get("tol", 1e-4)),
            note=str(e.get("note", "")),
        )

    return TrajectoryProblem(
        id=str(doc.get("id") or path.stem),
        title=str(doc.get("title", "")),
        text=str(doc.get("text", "")).strip(),
        problem=problem,
        target=target,
        expect=expect,
        tags=tuple(doc.get("tags") or ()),
        source=str(doc.get("source", "")),
        path=path,
    )


def load_trajectory_corpus(root: Path | None = None) -> list[TrajectoryProblem]:
    directory = root or TRAJECTORY_DIR
    if not directory.exists():
        return []
    return [load_trajectory(p) for p in sorted(directory.glob("*.yaml"))]


def check(entry: TrajectoryProblem, trajectory) -> tuple[bool, str]:
    """Does the sampled trajectory reach the value the closed form says it must?"""
    series = trajectory.y[entry.target]
    if not series:
        return False, "the trajectory has no samples"
    final = series[-1]
    got = (
        sum(component * component for component in final) ** 0.5
        if isinstance(final, tuple)
        else float(final)
    )
    if entry.expect is None:
        return True, f"{got:g}"
    want = parse_quantity(f"{entry.expect.value} {entry.expect.unit}")
    target = want.magnitude if want.is_vector else float(want.value)  # type: ignore[arg-type]
    scale = max(abs(target), 1e-30)
    return abs(got - target) / scale <= entry.expect.tol, f"got {got:.6g}, want {target:.6g}"

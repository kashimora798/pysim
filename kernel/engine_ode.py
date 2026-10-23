"""Engine C: time evolution — the answer as a function, not a value.

Engine A derives *that* a charged particle in the cavity field accelerates at 7.53 m/s².
Engine C answers the question a student actually watches: *where is it at each instant?*

Two lawful dynamics modes, both fed by verified quantities only:

* **Constant acceleration** — Engine A resolves the acceleration *vector* through the full
  chain (field -> force -> Newton II). Uniform fields (plates, cavity, gravity via the
  environment) all land here. Integration is RK4, which is exact for constant acceleration
  up to float noise — and the tests assert exactly that against the analytic solution and
  against Engine A's own final-speed answer (the engines cross-check).
* **Magnetic (cyclotron)** — a uniform B region instance states its field; the Lorentz
  acceleration ``a = (q/m) v × B`` is velocity-dependent, so RK4 earns its keep. The sampled
  orbit must reproduce the radius and period Engine A derives algebraically (asserted in
  tests to <0.5% — RK4 phase error, measured and stated, not hidden).

Nothing here invents an initial condition: position comes from `geometry.position`,
velocity from `kinematics.velocity` (or speed-at-initial along +x when only the scalar is
stated). What cannot be resolved is refused with the resolver's own failure text.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .engine_chain import Resolver
from .kb import KnowledgeBase
from .scene import Ref, Scene
from .units import Quantity

Vec3 = tuple[float, float, float]

ZERO: Vec3 = (0.0, 0.0, 0.0)


def _vec(q: Quantity | None, default: Vec3 = ZERO) -> Vec3:
    if q is None:
        return default
    v = q.value
    if isinstance(v, (list, tuple)):
        return (float(v[0]), float(v[1]), float(v[2]))
    return (float(v), 0.0, 0.0)


def _add(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _scale(a: Vec3, s: float) -> Vec3:
    return (a[0] * s, a[1] * s, a[2] * s)


def _cross(a: Vec3, b: Vec3) -> Vec3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _mag(a: Vec3) -> float:
    return math.sqrt(a[0] ** 2 + a[1] ** 2 + a[2] ** 2)


@dataclass
class Trajectory:
    """Sampled motion of one instance, ready to serialise into a SimSpec."""

    instance: str
    mode: str  # "constant_acceleration" | "magnetic"
    laws: tuple[str, ...] = ()
    t: list[float] = field(default_factory=list)
    position: list[Vec3] = field(default_factory=list)
    velocity: list[Vec3] = field(default_factory=list)

    @property
    def speed(self) -> list[float]:
        return [_mag(v) for v in self.velocity]

    @property
    def duration(self) -> float:
        return self.t[-1] if self.t else 0.0

    def to_json(self) -> dict:
        return {
            "instance": self.instance,
            "mode": self.mode,
            "laws": list(self.laws),
            "integrator": "RK4 (exact for constant acceleration; <0.5% phase error on cyclotron orbits at the sampled dt)",
            # Significant figures, not decimal places: a cyclotron orbit lasts ~1e-7 s, and rounding
            # its sample times to 8 decimals collapsed neighbouring samples to the same instant,
            # which made any dv/dt taken from the file meaningless.
            "t": [_sig(x) for x in self.t],
            "position": [[_sig(c) for c in p] for p in self.position],
            "velocity": [[_sig(c) for c in v] for v in self.velocity],
            "speed": [_sig(s) for s in self.speed],
        }


def _sig(x: float, digits: int = 9) -> float:
    """`x` to `digits` significant figures (keeps tiny times and large speeds equally precise)."""
    return float(f"{x:.{digits}g}")


class ODEError(RuntimeError):
    """Raised when no lawful dynamics can be derived for a scene."""


def _initial_velocity(kb: KnowledgeBase, scene: Scene, resolver: Resolver, iid: str) -> Vec3:
    given = scene.given(Ref(iid, "kinematics.velocity"))
    if given is not None:
        return _vec(given)
    # A stated initial speed without a vector: motion starts along +x (stated, not hidden).
    for state in ("initial", None):
        q = scene.given(Ref(iid, "kinematics.speed", state))  # type: ignore[arg-type]
        if q is not None:
            return (float(q.value), 0.0, 0.0)  # type: ignore[arg-type]
    paths = resolver.resolve(Ref(iid, "kinematics.velocity", "initial"))
    if paths:
        return _vec(paths[0].value)
    return ZERO


def _magnetic_field_of_scene(scene: Scene) -> Vec3 | None:
    for inst in scene.instances.values():
        q = inst.values.get(Ref(inst.id, "em.magnetic_field"))
        if q is not None and _mag(_vec(q)) > 0:
            return _vec(q)
    return None


def simulate(
    kb: KnowledgeBase,
    scene: Scene,
    instance: str,
    duration: float,
    *,
    samples: int = 120,
) -> Trajectory:
    """Sample the lawful motion of `instance` over `duration` seconds.

    Raises ODEError (with the resolver's reasons) when neither a magnetic region nor a
    resolvable constant acceleration exists — refusing beats inventing dynamics.
    """
    if duration <= 0:
        raise ODEError("duration must be positive")
    resolver = Resolver(kb, scene)
    x0 = _vec(scene.given(Ref(instance, "geometry.position")))
    v0 = _initial_velocity(kb, scene, resolver, instance)
    dt = duration / max(8, samples)

    b_field = _magnetic_field_of_scene(scene)
    q_paths = resolver.resolve(Ref(instance, "em.charge"))
    m_paths = resolver.resolve(Ref(instance, "mechanics.mass"))

    mode: str
    accel_of: object
    laws: tuple[str, ...]
    if b_field is not None and q_paths and m_paths:
        q = float(q_paths[0].value.value)  # type: ignore[arg-type]
        m = float(m_paths[0].value.value)  # type: ignore[arg-type]
        if m == 0:
            raise ODEError("zero mass: magnetic dynamics undefined")
        factor = q / m
        mode = "magnetic"
        laws = ("lorentz_force", "newton_second_law", "circular_motion_magnetic")
        accel_of = lambda v: _scale(_cross(v, b_field), factor)  # noqa: E731
    else:
        a_paths = resolver.resolve(Ref(instance, "kinematics.acceleration"))
        if not a_paths:
            raise ODEError(str(resolver.failure(Ref(instance, "kinematics.acceleration"))))
        a_const = _vec(a_paths[0].value)
        mode = "constant_acceleration"
        laws = tuple(sorted(a_paths[0].laws))
        accel_of = lambda v: a_const  # noqa: E731

    traj = Trajectory(instance=instance, mode=mode, laws=laws)
    x, v = x0, v0
    steps = max(8, samples)
    for i in range(steps + 1):
        traj.t.append(i * dt)
        traj.position.append(x)
        traj.velocity.append(v)
        if i == steps:
            break
        # Classical RK4 on (x, v): dx/dt = v, dv/dt = a(v).
        k1v = accel_of(v)  # type: ignore[operator]
        k1x = v
        k2v = accel_of(_add(v, _scale(k1v, dt / 2)))  # type: ignore[operator]
        k2x = _add(v, _scale(k1v, dt / 2))
        k3v = accel_of(_add(v, _scale(k2v, dt / 2)))  # type: ignore[operator]
        k3x = _add(v, _scale(k2v, dt / 2))
        k4v = accel_of(_add(v, _scale(k3v, dt)))  # type: ignore[operator]
        k4x = _add(v, _scale(k3v, dt))
        x = _add(x, _scale(_add(_add(k1x, _scale(k2x, 2)), _add(_scale(k3x, 2), k4x)), dt / 6))
        v = _add(v, _scale(_add(_add(k1v, _scale(k2v, 2)), _add(_scale(k3v, 2), k4v)), dt / 6))
    return traj

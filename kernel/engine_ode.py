"""Engine C: time evolution — the answers that are functions, not values.

Engines A and B both answer "what is this quantity?" Engine C answers "what
does this quantity *do*?" A charging capacitor, a projectile, a decaying
oscillator: the answer is a trajectory, and no algebraic rearrangement will
produce one.

The physics still comes from the same table. What Engine C adds is the
statement that some property is a *derivative* of another, plus an initial
condition to start from, plus an explicit integrator:

    dx/dt = v,  dv/dt = a,  x(0) = 0,  v(0) = 0,  integrate with RK4

The integrator invents nothing. It samples a path the laws already determine,
which is why the engine's first job after integrating is to *check*: where an
algebraic formula exists for the same quantity — constant acceleration, or
exponential RC charging — the two answers must agree, and the test suite
asserts that they do to within the integrator's own truncation error.

Three integration schemes are available and named: ``euler``, ``rk4`` and
``rk45`` (adaptive, via SciPy when installed). Which one produced a trajectory
is recorded on it, because "the answer depends on the method" is exactly the
kind of thing a physics engine must say out loud.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import sympy as sp

from .dims import Dim
from .exprs import parse
from .scene import Ref
from .units import Quantity

#: Integration schemes this engine knows, in ascending order of sophistication.
METHODS = ("euler", "rk4", "rk45")


class ODEError(RuntimeError):
    """Raised when a time-evolution problem is misstated or cannot be integrated."""


# --------------------------------------------------------------------------- problem


@dataclass
class ODEVariable:
    """One component of the state: a position, a velocity, a voltage, a temperature."""

    ref: Ref
    dim: Dim
    rank: str = "scalar"
    initial: Quantity | None = None

    @property
    def width(self) -> int:
        return 3 if self.rank == "vector" else 1


@dataclass
class ODEProblem:
    """A first-order system ``dy/dt = f(y, t)`` with initial conditions.

    ``derivatives`` maps each variable to the expression for its rate of change.
    A scalar variable takes one string; a vector variable takes three, one per
    spatial component, and inside them the variable is named ``<name>_x``,
    ``<name>_y``, ``<name>_z``. Variables are named ``<instance>_<property>``
    with dots turned into single underscores — the expression whitelist bans a
    double underscore outright, because attribute access is how a sandbox gets
    escaped, and that ban is worth more than a naming convention.

    Example — one-dimensional motion from rest under a constant acceleration::

        ODEProblem(
            variables=[x, v],
            derivatives={x.ref: "p_kinematics_velocity", v.ref: "2.0"},
            t_span=(0.0, 3.0), dt=0.01, method="rk4",
        )

    Every expression is parsed through the same whitelist the knowledge base
    uses, so a trajectory cannot smuggle in a function the validators would
    have rejected.
    """

    variables: list[ODEVariable]
    derivatives: dict[Ref, str | tuple[str, str, str]]
    t_span: tuple[float, float] = (0.0, 1.0)
    dt: float = 0.001
    method: str = "rk4"
    name: str = "trajectory"
    #: What the derivative expressions mean, for the trace.
    law: str = "time_evolution"

    def __post_init__(self) -> None:
        if self.method not in METHODS:
            raise ODEError(f"unknown method {self.method!r}; choose one of {METHODS}")
        missing = [
            str(v.ref) for v in self.variables if v.ref not in self.derivatives
        ]
        if missing:
            raise ODEError(f"no derivative given for {', '.join(missing)}")
        for variable in self.variables:
            derivative = self.derivatives[variable.ref]
            width = 3 if isinstance(derivative, tuple) else 1
            if width != variable.width:
                raise ODEError(
                    f"{variable.ref} is a {variable.rank} and needs "
                    f"{'three derivative expressions' if variable.width == 3 else 'one derivative expression'}, "
                    f"got {width}"
                )


@dataclass
class Trajectory:
    """A sampled solution, with the method that produced it written on the front."""

    problem: ODEProblem
    t: list[float]
    #: ref -> one sample per time step; a vector variable's samples are 3-tuples.
    y: dict[Ref, list]
    method: str
    steps: int
    note: str = ""

    @property
    def final_state(self) -> dict[Ref, Quantity]:
        out: dict[Ref, Quantity] = {}
        for variable in self.problem.variables:
            series = self.y[variable.ref]
            out[variable.ref] = Quantity(
                value=series[-1], dim=variable.dim, rank=variable.rank
            )
        return out

    def sample(self, ref: Ref, at_t: float):
        """Linear interpolation between samples. Trajectories are dense by construction."""
        series = self.y[ref]
        if at_t <= self.t[0]:
            return series[0]
        if at_t >= self.t[-1]:
            return series[-1]
        index = min(
            range(len(self.t) - 1), key=lambda i: abs(self.t[i] - at_t)
        )
        if self.t[index] > at_t:
            index -= 1
        t0, t1 = self.t[index], self.t[index + 1]
        if t1 == t0:
            return series[index]
        fraction = (at_t - t0) / (t1 - t0)
        a, b = series[index], series[index + 1]
        if isinstance(a, tuple):
            return tuple((1 - fraction) * x + fraction * y for x, y in zip(a, b))
        return (1 - fraction) * a + fraction * b

    def beats(self, count: int = 12) -> list[dict]:
        """The trajectory as SimSpec-shaped beats, so a renderer can play it back.

        Each beat says what the state is, when, and — because an integrator is
        an opinion, not a law — which integrator and step size produced it.
        """
        total = len(self.t)
        picks = [round(i * (total - 1) / max(count - 1, 1)) for i in range(count)]
        out: list[dict] = []
        for beat, index in enumerate(dict.fromkeys(picks), start=1):
            state = {
                str(variable.ref): (
                    list(self.y[variable.ref][index])
                    if variable.rank == "vector"
                    else self.y[variable.ref][index]
                )
                for variable in self.problem.variables
            }
            out.append(
                {
                    "beat": beat,
                    "kind": "sample",
                    "time": self.t[index],
                    "state": state,
                    "narrate": f"At t = {self.t[index]:.4g} s the state is "
                    + ", ".join(f"{k} = {v}" for k, v in state.items()),
                    "because": {
                        "kind": "integrated",
                        "law": self.problem.law,
                        "method": self.method,
                        "dt": self.problem.dt,
                        "detail": "sampled from the instantaneous laws and the stated "
                        "initial conditions; no algebraic shortcut was used",
                    },
                }
            )
        return out

    def to_json(self) -> dict:
        return {
            "fieldforge": "trajectory/0.1",
            "name": self.problem.name,
            "law": self.problem.law,
            "method": self.method,
            "dt": self.problem.dt,
            "tSpan": list(self.problem.t_span),
            "steps": self.steps,
            "variables": [
                {
                    "ref": str(v.ref),
                    "dim": str(v.dim),
                    "rank": v.rank,
                    "initial": (
                        list(v.initial.value)
                        if v.initial is not None and v.initial.is_vector
                        else (float(v.initial.value) if v.initial is not None else None)
                    ),
                }
                for v in self.problem.variables
            ],
            "t": self.t,
            "y": {
                str(ref): [
                    list(sample) if isinstance(sample, tuple) else sample for sample in series
                ]
                for ref, series in self.y.items()
            },
        }


# --------------------------------------------------------------------------- engine


class ODEEngine:
    """Explicit time integration over a declared first-order system."""

    def integrate(self, problem: ODEProblem) -> Trajectory:
        """Step from ``t_span[0]`` to ``t_span[1]`` and return the sampled trajectory."""
        if not problem.variables:
            raise ODEError("an ODEProblem needs at least one variable")
        if problem.dt <= 0:
            raise ODEError("dt must be greater than zero")
        t0, t1 = problem.t_span
        if t1 <= t0:
            raise ODEError("t_span must run forward: t1 > t0")

        names, symbols, flat_initial = self._flatten(problem)
        symbol_order = symbols + [sp.Symbol("t")]
        lambdas = self._derivative_lambdas(problem, names, symbol_order)

        if problem.method == "rk45":
            return self._integrate_scipy(problem, lambdas, flat_initial, t0, t1)

        times: list[float] = []
        history: list[list[float]] = []
        state = list(flat_initial)
        t = t0
        while t < t1 - 1e-15:
            times.append(t)
            history.append(list(state))
            step = min(problem.dt, t1 - t)
            state = self._step(problem.method, lambdas, state, t, step)
            t += step
        times.append(t1)
        history.append(list(state))

        return Trajectory(
            problem=problem,
            t=times,
            y=self._unflatten(problem, names, history),
            method=problem.method,
            steps=len(times),
            note=f"dt={problem.dt:g}, {t0:g}..{t1:g}",
        )

    # ------------------------------------------------------------------ internals

    @staticmethod
    def _flatten(problem: ODEProblem) -> tuple[list[str], list[sp.Symbol], list[float]]:
        """One symbol per scalar component, and the initial state as a flat list."""
        names: list[str] = []
        symbols: list[sp.Symbol] = []
        initial: list[float] = []
        for variable in problem.variables:
            base = ODEEngine._sym_name(variable.ref)
            if variable.rank == "vector":
                for axis in "xyz":
                    names.append(f"{base}_{axis}")
                    symbols.append(sp.Symbol(f"{base}_{axis}"))
                if variable.initial is None or not variable.initial.is_vector:
                    raise ODEError(f"{variable.ref} is a vector and needs a vector initial value")
                initial.extend(float(c) for c in variable.initial.value)  # type: ignore[union-attr]
            else:
                names.append(base)
                symbols.append(sp.Symbol(base))
                if variable.initial is None:
                    raise ODEError(f"{variable.ref} has no initial value")
                if variable.initial.is_vector:
                    raise ODEError(f"{variable.ref} is a scalar but was given a vector initial value")
                initial.append(float(variable.initial.value))  # type: ignore[arg-type]
        if len(set(names)) != len(names):
            raise ODEError(
                "two variables flatten to the same symbol name; rename an instance: "
                + ", ".join(names)
            )
        return names, symbols, initial

    @staticmethod
    def _sym_name(ref: Ref) -> str:
        name = f"{ref.instance}_{ref.prop.replace('.', '_')}"
        return f"{name}_{ref.state}" if ref.state else name

    def _derivative_lambdas(self, problem: ODEProblem, names: list[str], symbol_order: list[sp.Symbol]):
        """Compile each derivative expression, in the same order as the state vector."""
        lambdas: list = []
        for variable in problem.variables:
            derivative = problem.derivatives[variable.ref]
            texts = derivative if isinstance(derivative, tuple) else (derivative,)
            for text in texts:
                try:
                    expression = parse(text)
                except Exception as exc:
                    raise ODEError(
                        f"d/dt of {variable.ref} is not a usable expression: {exc}"
                    ) from exc
                lambdas.append(sp.lambdify(symbol_order, expression, "math"))
        if len(lambdas) != len(names):
            raise ODEError("the flattened state and its derivatives disagree in size")
        return lambdas

    @staticmethod
    def _evaluate(lambdas, state: list[float], t: float) -> list[float]:
        arguments = list(state) + [t]
        try:
            return [float(f(*arguments)) for f in lambdas]
        except Exception as exc:
            raise ODEError(f"the derivative could not be evaluated at t={t}: {exc}") from exc

    def _step(self, method: str, lambdas, state: list[float], t: float, dt: float) -> list[float]:
        if method == "euler":
            k1 = self._evaluate(lambdas, state, t)
            return [y + dt * k for y, k in zip(state, k1)]
        if method == "rk4":
            k1 = self._evaluate(lambdas, state, t)
            mid = [y + 0.5 * dt * k for y, k in zip(state, k1)]
            k2 = self._evaluate(lambdas, mid, t + 0.5 * dt)
            mid = [y + 0.5 * dt * k for y, k in zip(state, k2)]
            k3 = self._evaluate(lambdas, mid, t + 0.5 * dt)
            end = [y + dt * k for y, k in zip(state, k3)]
            k4 = self._evaluate(lambdas, end, t + dt)
            return [
                y + dt * (a + 2 * b + 2 * c + d) / 6
                for y, a, b, c, d in zip(state, k1, k2, k3, k4)
            ]
        raise ODEError(f"unknown method {method!r}")

    def _integrate_scipy(
        self, problem: ODEProblem, lambdas, initial: list[float], t0: float, t1: float
    ) -> Trajectory:
        try:
            from scipy.integrate import solve_ivp  # type: ignore
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise ODEError(
                "method 'rk45' needs SciPy, which is not a kernel dependency; "
                "use method='rk4' instead"
            ) from exc

        def right_hand_side(t: float, y: list[float]) -> list[float]:
            return self._evaluate(lambdas, list(y), t)

        names, _, _ = self._flatten(problem)
        grid = [t0 + i * problem.dt for i in range(int(math.ceil((t1 - t0) / problem.dt)) + 1)]
        grid[-1] = min(grid[-1], t1)
        solution = solve_ivp(right_hand_side, (t0, t1), initial, t_eval=grid, rtol=1e-9, atol=1e-12)
        if not solution.success:
            raise ODEError(f"SciPy failed to integrate: {solution.message}")
        history = [list(column) for column in zip(*solution.y)]
        return Trajectory(
            problem=problem,
            t=list(solution.t),
            y=self._unflatten(problem, names, history),
            method="rk45 (SciPy, rtol 1e-9)",
            steps=len(solution.t),
            note=f"adaptive, evaluated on a dt={problem.dt:g} grid",
        )

    @staticmethod
    def _unflatten(problem: ODEProblem, names: list[str], history: list[list[float]]):
        out: dict[Ref, list] = {}
        column = 0
        for variable in problem.variables:
            width = variable.width
            series: list = []
            for row in history:
                chunk = row[column : column + width]
                series.append(tuple(chunk) if width == 3 else chunk[0])
            out[variable.ref] = series
            column += width
        return out


# --------------------------------------------------------------------------- ready-made problems


def constant_acceleration(
    ref_position: Ref,
    ref_velocity: Ref,
    acceleration: float,
    *,
    x0: float = 0.0,
    v0: float = 0.0,
    t_span: tuple[float, float] = (0.0, 1.0),
    dt: float = 0.001,
    method: str = "rk4",
    name: str = "constant acceleration",
) -> ODEProblem:
    """Straight-line motion under a constant acceleration, the textbook case.

    Engine C's answer here must match the algebraic kinematics formula, and the
    test suite asserts it does: that is the cross-check that licenses the
    integrator at all.
    """
    return ODEProblem(
        variables=[
            ODEVariable(ref=ref_position, dim=Dim.of(m=1), rank="scalar",
                        initial=Quantity(value=x0, dim=Dim.of(m=1))),
            ODEVariable(ref=ref_velocity, dim=Dim.of(m=1, s=-1), rank="scalar",
                        initial=Quantity(value=v0, dim=Dim.of(m=1, s=-1))),
        ],
        derivatives={
            ref_position: ODEEngine._sym_name(ref_velocity),
            ref_velocity: repr(float(acceleration)),
        },
        t_span=t_span,
        dt=dt,
        method=method,
        name=name,
    )


def rc_charging(
    ref_voltage: Ref,
    supply: float,
    resistance: float,
    capacitance: float,
    *,
    v0: float = 0.0,
    t_span: tuple[float, float] = (0.0, 1.0),
    dt: float = 0.001,
    method: str = "rk4",
    name: str = "RC charging",
) -> ODEProblem:
    """A capacitor charging through a resistor: ``dV/dt = (V_s - V) / (R*C)``.

    The closed form is ``V(t) = V_s + (V_0 - V_s)·e^(-t/RC)``, and the tests
    hold the integrator to it.
    """
    volts = Quantity(value=0.0, dim=Dim.of(kg=1, m=2, s=-3, A=-1))
    tau = resistance * capacitance
    if tau <= 0:
        raise ODEError("R*C must be positive")
    variable = ODEVariable(ref=ref_voltage, dim=volts.dim, rank="scalar",
                           initial=Quantity(value=v0, dim=volts.dim))
    return ODEProblem(
        variables=[variable],
        derivatives={
            ref_voltage: f"({supply!r} - {ODEEngine._sym_name(ref_voltage)}) / {tau!r}"
        },
        t_span=t_span,
        dt=dt,
        method=method,
        name=name,
    )


def rc_closed_form(supply: float, v0: float, resistance: float, capacitance: float, t: float) -> float:
    """The analytical answer :func:`rc_charging` is checked against."""
    return supply + (v0 - supply) * math.exp(-t / (resistance * capacitance))


def projectile_in_gravity(
    ref_position: Ref,
    ref_velocity: Ref,
    *,
    gravity: tuple[float, float, float] = (0.0, -9.80665, 0.0),
    v0: tuple[float, float, float] = (10.0, 10.0, 0.0),
    x0: tuple[float, float, float] = (0.0, 0.0, 0.0),
    t_span: tuple[float, float] = (0.0, 2.0),
    dt: float = 0.001,
    method: str = "rk4",
    name: str = "projectile in gravity",
) -> ODEProblem:
    """Three-dimensional projectile motion, to show the engine handles vectors."""
    length = Dim.of(m=1)
    speed = Dim.of(m=1, s=-1)
    position = ODEVariable(ref=ref_position, dim=length, rank="vector",
                           initial=Quantity(value=x0, dim=length, rank="vector"))
    velocity = ODEVariable(ref=ref_velocity, dim=speed, rank="vector",
                           initial=Quantity(value=v0, dim=speed, rank="vector"))
    base = ODEEngine._sym_name(ref_velocity)
    return ODEProblem(
        variables=[position, velocity],
        derivatives={
            ref_position: (f"{base}_x", f"{base}_y", f"{base}_z"),
            ref_velocity: tuple(repr(float(component)) for component in gravity),
        },
        t_span=t_span,
        dt=dt,
        method=method,
        name=name,
    )

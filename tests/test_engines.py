"""Engines B and C, and the mathematical toolkit they call.

Engine A's tests live in ``test_resolver_corpus.py``. This file covers what was
added afterwards:

* Engine B assembles and solves simultaneous systems, and agrees with Engine A
  wherever Engine A can reach at all;
* Engine C integrates, and agrees with the closed-form answer wherever one
  exists;
* the toolkit is callable by name, and its calculus carries dimensions.

The negative tests matter most. An engine that silently returns a number it
converged on, rather than admitting the system is under-determined, is worse
than an engine that fails.
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from kernel.dims import Dim
from kernel.engine_chain import Resolver
from kernel.engine_ode import (
    ODEEngine,
    ODEProblem,
    ODEVariable,
    constant_acceleration,
    projectile_in_gravity,
    rc_charging,
    rc_closed_form,
)
from kernel.engine_system import SystemEngine, SystemError
from kernel.kb import load_kb
from kernel.math_tools import (
    TOOLS,
    call,
    curl,
    describe,
    determinant,
    differentiate,
    divergence,
    gradient,
    integrate,
    integrate_definite,
    inverse,
    laplacian,
    limit,
    numeric_derivative,
    quadrature,
    rearrange,
    series,
    solve_linear,
    solve_system,
)
from kernel.scene import Ref, load_corpus, load_problem
from kernel.solve import solve_problem
from kernel.units import Quantity, parse_quantity

CORPUS = Path(__file__).resolve().parent.parent / "corpus" / "problems"


@pytest.fixture(scope="module")
def kb():
    return load_kb()


@pytest.fixture(scope="module")
def problems(kb):
    return {p.id: p for p in load_corpus(CORPUS, kb)}


def _magnitude(quantity) -> float:
    return quantity.magnitude if quantity.is_vector else float(quantity.value)


# --------------------------------------------------------------------------- Engine B


def test_chain_problems_are_already_triangular(kb, problems):
    """Engine A's territory: every block is one unknown, so no system is ever assembled."""
    for pid in ("p101", "p102", "p103", "p105"):
        solution = SystemEngine(kb, problems[pid].scene).solve(problems[pid].target)
        assert solution.method == "chain", f"{pid} should not need a system"
        assert solution.simultaneous_blocks == 0


def test_two_cells_in_parallel_needs_the_system_engine(kb, problems):
    """The case Engine A cannot do, and says so."""
    problem = problems["p111"]
    assert not Resolver(kb, problem.scene).resolve(problem.target), (
        "Engine A is not supposed to reach a simultaneous answer"
    )
    solution = SystemEngine(kb, problem.scene).solve(problem.target)
    assert solution.method == "system"
    assert solution.simultaneous_blocks >= 1
    assert _magnitude(solution.value) == pytest.approx(1.0, abs=1e-9)


def test_reversed_cell_gives_the_opposite_current(kb, problems):
    """Same equations, one sign changed: 0.6 A the other way."""
    solution = SystemEngine(kb, problems["p112"].scene).solve(problems["p112"].target)
    assert _magnitude(solution.value) == pytest.approx(-0.6, abs=1e-9)


def test_solved_branch_currents_are_physically_consistent(kb, problems):
    """The two cells must not both deliver: the weaker one is being charged."""
    scene = problems["p111"].scene
    solution = SystemEngine(kb, scene).solve(problems["p111"].target)
    b1 = _magnitude(solution.values[Ref("b1", "electric.current")])
    b2 = _magnitude(solution.values[Ref("b2", "electric.current")])
    total = _magnitude(solution.values[Ref("pp", "electric.current")])
    assert b1 == pytest.approx(0.0, abs=1e-9)  # a 1 V cell at 1 V terminal delivers nothing
    assert b2 == pytest.approx(1.0, abs=1e-9)
    assert total == pytest.approx(b1 + b2, abs=1e-9)
    assert solution.residual <= 1e-12  # every assembled equation, not just the ones solved


def test_every_engine_a_problem_agrees_with_engine_b(kb, problems):
    """Two engines of different construction, one knowledge base, one answer."""
    checked = 0
    for problem in problems.values():
        result = solve_problem(kb, problem)
        assert result.resolved, f"{problem.id} resolved under neither engine"
        if result.cross_check:
            assert result.cross_check["agree"], (
                f"{problem.id}: engines disagree by {result.cross_check['rel_error']:.2e}"
            )
            checked += 1
    assert checked >= 20, "the cross-check hardly ran"


def test_engine_b_refuses_an_underdetermined_scene(kb):
    """A loop with no source cannot be solved, and must say so rather than guess zero."""
    scene = load_problem(CORPUS / "p101.yaml", kb).scene
    # Remove the battery: the loop now has a resistance but no stated driving voltage.
    del scene.instances["bat"]
    scene.relations = [r for r in scene.relations if r.kind != "driven_by"]
    engine = SystemEngine(kb, scene)
    with pytest.raises(SystemError):
        engine.solve(Ref("loop", "electric.current"))


def test_a_law_is_not_applied_to_a_component_it_is_not_a_law_of(kb):
    """Ohm's law is false across a battery's terminals; the knowledge base now says so."""
    problem = load_problem(CORPUS / "p111.yaml", kb)
    engine = SystemEngine(kb, problem.scene)
    candidates = engine.candidates(Ref("b1", "electric.current"))
    keys = {row.formula.key for row in candidates}
    assert "branch.I_from_emf_V_R" in keys
    assert "ohm.I_from_V_R" not in keys, "Ohm's law was offered for a battery"


def test_causalisation_is_reproducible(kb, problems):
    """The same scene must causalise the same way twice; the rank test is seeded."""
    problem = problems["p111"]
    first = SystemEngine(kb, problem.scene).solve(problem.target)
    second = SystemEngine(kb, problem.scene).solve(problem.target)
    assert _magnitude(first.value) == pytest.approx(_magnitude(second.value), abs=1e-12)
    assert len(first.plan.blocks) == len(second.plan.blocks)


def test_engine_b_result_becomes_a_cited_derivation(kb, problems):
    """The SimSpec contract still holds: every step cites a formula and a law."""
    problem = problems["p111"]
    solution = SystemEngine(kb, problem.scene).solve(problem.target)
    derivation = solution.to_derivation(kb)
    assert derivation.value is solution.values[problem.target]
    derived = [s for s in derivation.steps if not s.is_given]
    assert derived, "a system solution produced no cited steps"
    assert all(step.formula and step.formula.law for step in derived)
    assert any("Engine B" in a for step in derived for a in step.formula.assumes)


# --------------------------------------------------------------------------- Engine C


def test_rk4_is_exact_for_constant_acceleration():
    """Where algebra has an answer, the integrator must reproduce it."""
    position, velocity = Ref("p", "geometry.position"), Ref("p", "kinematics.velocity")
    trajectory = ODEEngine().integrate(
        constant_acceleration(position, velocity, 2.0, t_span=(0, 3), dt=0.01)
    )
    assert trajectory.y[velocity][-1] == pytest.approx(6.0, abs=1e-12)
    assert trajectory.y[position][-1] == pytest.approx(9.0, abs=1e-12)


def test_rc_charging_matches_the_closed_form():
    """The exponential is the whole point: an algebraic engine cannot produce it."""
    voltage = Ref("c1", "em.potential_difference")
    problem = rc_charging(voltage, 5.0, 10_000.0, 100e-6, t_span=(0, 1), dt=0.001)
    trajectory = ODEEngine().integrate(problem)
    expected = rc_closed_form(5.0, 0.0, 10_000.0, 100e-6, 1.0)
    assert trajectory.y[voltage][-1] == pytest.approx(expected, rel=1e-9)

    # Euler is first-order: correct, but visibly worse. The method is recorded so a
    # reader can tell which one they are looking at.
    euler = ODEEngine().integrate(
        rc_charging(voltage, 5.0, 10_000.0, 100e-6, t_span=(0, 1), dt=1e-4, method="euler")
    )
    assert abs(euler.y[voltage][-1] - expected) > abs(trajectory.y[voltage][-1] - expected)
    assert euler.method == "euler"


def test_interpolation_between_samples_is_usable():
    voltage = Ref("c1", "em.potential_difference")
    trajectory = ODEEngine().integrate(
        rc_charging(voltage, 5.0, 10_000.0, 100e-6, t_span=(0, 1), dt=0.001)
    )
    assert trajectory.sample(voltage, 0.5) == pytest.approx(
        rc_closed_form(5.0, 0.0, 10_000.0, 100e-6, 0.5), rel=1e-6
    )


def test_vector_state_integrates_three_components():
    position, velocity = Ref("ball", "geometry.position"), Ref("ball", "kinematics.velocity")
    trajectory = ODEEngine().integrate(
        projectile_in_gravity(position, velocity, v0=(10.0, 10.0, 0.0), t_span=(0, 1), dt=0.001)
    )
    final_v = trajectory.y[velocity][-1]
    assert final_v[0] == pytest.approx(10.0, abs=1e-9)  # no horizontal acceleration
    assert final_v[1] == pytest.approx(10.0 - 9.80665, abs=1e-9)
    assert final_v[2] == pytest.approx(0.0, abs=1e-12)


def test_trajectory_emits_cited_beats():
    position, velocity = Ref("p", "geometry.position"), Ref("p", "kinematics.velocity")
    trajectory = ODEEngine().integrate(
        constant_acceleration(position, velocity, 2.0, t_span=(0, 1), dt=0.05)
    )
    beats = trajectory.beats(5)
    assert len(beats) == 5
    assert all(beat["because"]["kind"] == "integrated" for beat in beats)
    assert beats[0]["because"]["method"] == "rk4"
    assert "t" in trajectory.to_json()


def test_a_misstated_problem_is_refused():
    """A vector variable with a scalar derivative is a mistake, not something to guess around."""
    velocity = Ref("p", "kinematics.velocity")
    with pytest.raises(Exception):
        ODEProblem(
            variables=[ODEVariable(ref=velocity, dim=Dim.of(m=1, s=-1), rank="vector",
                                   initial=Quantity(value=(0.0, 0.0, 0.0), dim=Dim.of(m=1, s=-1),
                                                    rank="vector"))],
            derivatives={velocity: "9.81"},  # one expression for three components
        )
    with pytest.raises(Exception):  # no variables at all
        ODEEngine().integrate(ODEProblem(variables=[], derivatives={}))
    with pytest.raises(Exception):
        ODEEngine().integrate(
            constant_acceleration(Ref("p", "geometry.position"), velocity, 1.0, t_span=(1, 0))
        )


# --------------------------------------------------------------------------- the toolkit


def test_differentiation_divides_dimensions():
    length = Dim.of(m=1)
    first = differentiate("x**2", "x", dims={"x": length})
    assert str(first.expression) == "2*x"
    assert first.dim == length
    assert differentiate("x**2", "x", order=2, dims={"x": length}).dim.is_dimensionless


def test_integration_multiplies_dimensions():
    length = Dim.of(m=1)
    result = integrate("2*x", "x", dims={"x": length})
    assert result.dim == Dim.of(m=2)
    definite = integrate_definite("2*x", "x", 0.0, 3.0, dims={"x": length})
    assert float(definite.value) == pytest.approx(9.0)
    assert definite.dim == Dim.of(m=2)


def test_definite_integral_rejects_a_mismatched_bound():
    with pytest.raises(Exception):
        integrate_definite("2*x", "x", 0.0, parse_quantity("3 s"), dims={"x": Dim.of(m=1)})


def test_gradient_divergence_curl_laplacian():
    length = Dim.of(m=1)
    dims = {"x": length, "y": length, "z": length}
    grad = gradient("x**2 + y**2", dims=dims)
    assert [str(g.expression) for g in grad] == ["2*x", "2*y", "0"]
    assert str(divergence(("x", "y", "z"), dims=dims).expression) == "3"
    assert str(laplacian("x**2 + y**2 + z**2", dims=dims).expression) == "6"
    # curl of a rigid rotation is constant, and points along the axis
    assert [str(c.expression) for c in curl(("-y", "x", "0"), dims=dims)] == ["0", "0", "2"]


def test_rearrangement_and_solving():
    assert str(rearrange("V - I*R", "I")) == "V/R"
    assert str(rearrange("V - I*R", "R")) == "V/I"
    assert solve_system(["I1+I2-3", "I1-I2-1"], ["I1", "I2"]) == {"I1": 2, "I2": 1}
    amps = Dim.of(A=1)
    solved = solve_linear([[2, 1], [1, 3]], [5, 6], ["I1", "I2"], [amps, amps])
    assert float(solved["I1"].value) == pytest.approx(1.8)
    assert float(solved["I2"].value) == pytest.approx(1.4)
    assert solved["I1"].dim == amps


def test_linear_algebra_tools():
    assert determinant([[2, 1], [1, 3]]) == pytest.approx(5.0)
    inverted = inverse([[2, 1], [1, 3]])
    for row, expected in zip(inverted, [[0.6, -0.2], [-0.2, 0.4]]):
        assert row == pytest.approx(expected)
    with pytest.raises(Exception):
        inverse([[1, 1], [1, 1]])  # singular: no inverse exists, so none must be returned


def test_numerics_agree_with_the_symbolic_forms():
    assert quadrature("sin(x)", "x", 0.0, math.pi, steps=20000) == pytest.approx(2.0, rel=1e-6)
    assert numeric_derivative("x**2", "x", 3.0) == pytest.approx(6.0, rel=1e-5)
    assert float(limit("sin(x)/x", "x", 0)) == pytest.approx(1.0)
    assert str(series("sin(x)", "x", 0, 3)) == "-x**3/6 + x"


def test_tools_are_callable_by_name():
    """The registry is the point: a solver reaches for a tool the way a person would."""
    assert set(TOOLS) >= {
        "differentiate", "integrate", "integrate_definite", "limit", "series",
        "gradient", "divergence", "curl", "laplacian", "rearrange", "solve_system",
        "solve_linear", "determinant", "inverse", "quadrature", "numeric_derivative",
        "integrate_ode",
    }
    assert str(call("rearrange", "V - I*R", "I")) == "V/R"
    described = describe()
    assert len(described) == len(TOOLS)
    assert all(entry["signature"] for entry in described)
    with pytest.raises(KeyError):
        call("not_a_tool")


# --------------------------------------------------------------------------- trajectory corpus


def test_trajectory_corpus_reaches_its_closed_forms():
    """Engine C is only licensed where it can be checked, so it is checked on every entry."""
    from kernel.engine_ode import ODEEngine
    from kernel.trajectories import check as check_trajectory
    from kernel.trajectories import load_trajectory_corpus

    entries = load_trajectory_corpus()
    assert entries, "the trajectory corpus went missing"
    for entry in entries:
        trajectory = ODEEngine().integrate(entry.problem)
        ok, detail = check_trajectory(entry, trajectory)
        assert ok, f"{entry.id}: {detail}"
        assert trajectory.steps > 10
        assert entry.text, f"{entry.id} has no problem statement"


def test_projectile_keeps_its_horizontal_component():
    """A component-wise property a single magnitude would hide: no horizontal force, no change."""
    from kernel.trajectories import load_trajectory_corpus

    entry = next(e for e in load_trajectory_corpus() if e.id == "t003")
    series = ODEEngine().integrate(entry.problem).y[entry.target]
    assert all(abs(component[0] - 10.0) < 1e-12 for component in series)
    assert all(abs(component[2]) < 1e-12 for component in series)

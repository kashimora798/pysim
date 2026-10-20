"""Engines B and C: system assembly and time evolution, cross-checked against Engine A."""

from __future__ import annotations

import math

import pytest

from kernel.engine_chain import Resolver
from kernel.engine_ode import ODEError, simulate
from kernel.engine_system import solve_system
from kernel.kb import load_kb
from kernel.scene import load_corpus, load_problem
from kernel.solve import cross_check, resolve_problem
from kernel.validate import CORPUS_DIR


@pytest.fixture(scope="module")
def kb():
    return load_kb()


@pytest.fixture(scope="module")
def problems(kb):
    return {p.id: p for p in load_corpus(CORPUS_DIR, kb)}


# ---------------------------------------------------------------- Engine B

def test_wheatstone_bridge_resolves_only_via_system(kb, problems):
    p = problems["p201"]
    assert Resolver(kb, p.scene).resolve(p.target) == []  # the chain honestly cannot
    d = solve_system(kb, p.scene, p.target)
    assert d is not None
    assert float(d.value.value) == pytest.approx(1 / 7, rel=1e-6)
    assert d.steps[-1].ref == p.target


def test_nodal_duplicate_agrees_with_chain_answer(kb, problems):
    p = problems["p202"]
    d = solve_system(kb, p.scene, p.target)
    assert d is not None and float(d.value.value) == pytest.approx(3.0, rel=1e-9)


def test_resolve_problem_reports_engine(kb, problems):
    _, engine_b = resolve_problem(kb, problems["p201"])
    _, engine_a = resolve_problem(kb, problems["p101"])
    assert engine_b == "system" and engine_a == "chain"
    assert cross_check(kb, problems["p202"]) is None


# ---------------------------------------------------------------- Engine C

def test_cavity_trajectory_matches_analytic_and_engine_a(kb, problems):
    p = problems["p011"]
    traj = simulate(kb, p.scene, "p", 0.08, samples=200)
    a = float(Resolver(kb, p.scene).resolve(p.target.__class__("p", "kinematics.acceleration_magnitude"))[0].value.value)
    t_end = traj.t[-1]
    assert abs(traj.velocity[-1][0] - a * t_end) / (a * t_end) < 1e-6
    assert abs(traj.position[-1][0] - 0.5 * a * t_end**2) < 1e-6
    # speed after 2 cm from Engine A (the corpus target) vs Engine C at that position
    target_speed = float(Resolver(kb, p.scene).resolve(p.target)[0].value.value)
    near = min(range(len(traj.t)), key=lambda i: abs(traj.position[i][0] - 0.02))
    assert traj.speed[near] == pytest.approx(target_speed, rel=0.02)


def test_cyclotron_orbit_reproduces_radius_and_period(kb, problems):
    p = problems["p006"]
    period = 2 * math.pi * 1.67262192369e-27 / (1.602176634e-19 * 0.50)
    traj = simulate(kb, p.scene, "p", period, samples=720)
    radii = [math.hypot(*pos) for pos in traj.position]
    assert max(radii) == pytest.approx(2 * 0.0208786, rel=0.02)  # diameter of the orbit
    assert traj.speed[-1] == pytest.approx(traj.speed[0], rel=1e-3)  # B does no work


def test_engine_c_refuses_what_it_cannot_derive(kb, problems):
    with pytest.raises(ODEError):
        simulate(kb, problems["p002"].scene, "p1", 1.0)  # a probe has no dynamics

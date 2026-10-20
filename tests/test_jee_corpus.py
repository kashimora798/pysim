"""The p3xx corpus: JEE-level and book-level problems, verified three ways.

Every p3xx problem was posed from a published problem *type* (JEE Advanced/Main via
JEEBench, HC Verma-style book exercises), rewritten in our own words with transposed
values -- never copied. Each is then verified independently:

* the corpus audit checks the kernel's answer against the analytic answer computed
  by hand (recorded in each problem's `expect:`),
* these tests check the *physics relationships* between problems (the JEE gold ratio,
  the parabola's shape, orbit closure) that no single answer can express,
* Engine C trajectories must reproduce the Engine A answers they animate.
"""

from __future__ import annotations

import math

import pytest

from kernel.engine_chain import Resolver
from kernel.engine_ode import simulate
from kernel.kb import load_kb
from kernel.scene import load_corpus
from kernel.solve import resolve_problem
from kernel.validate import CORPUS_DIR


@pytest.fixture(scope="module")
def kb():
    return load_kb()


@pytest.fixture(scope="module")
def problems(kb):
    return {p.id: p for p in load_corpus(CORPUS_DIR, kb)}


def _answer(kb, p) -> float:
    derivations, _ = resolve_problem(kb, p)
    assert derivations, f"{p.id} did not resolve"
    v = derivations[0].value
    return v.magnitude if v.is_vector else float(v.value)


# ------------------------------------------------------------ JEE Advanced

def test_cavity_field_is_the_superposition_result(kb, problems):
    got = _answer(kb, problems["p301"])
    analytic = 2.0e-5 * 0.04 / (3 * 8.8541878128e-12)
    assert got == pytest.approx(analytic, rel=0.005)


def test_ion_radius_ratio_recovers_the_jee_gold_answer(kb, problems):
    """JEEBench gold for the alpha/sulfur question is the integer 4."""
    r_sulfur = _answer(kb, problems["p304"])
    r_alpha = _answer(kb, problems["p305"])
    assert r_sulfur / r_alpha == pytest.approx(4.0, rel=0.005)


def test_cavity_projectile_trajectory_agrees_with_chain(kb, problems):
    p = problems["p302"]
    traj = simulate(kb, p.scene, "p", 0.06, samples=240)
    target_speed = _answer(kb, p)
    near = min(range(len(traj.t)), key=lambda i: abs(traj.position[i][0] - 0.02))
    assert traj.speed[near] == pytest.approx(target_speed, rel=0.02)


# ------------------------------------------------------------ JEE Main / book dynamics

def test_plate_deflection_is_a_parabola(kb, problems):
    p = problems["p303"]
    traj = simulate(kb, p.scene, "e1", 1.0e-8, samples=200)
    x_end, y_end = traj.position[-1][0], traj.position[-1][1]
    assert x_end == pytest.approx(0.04, rel=0.01)          # 4 cm at constant vx
    assert y_end == pytest.approx(0.00439705, rel=0.01)    # (1/2) a t^2, a = eE/m
    # A parabola under constant acceleration: at half the time, a quarter of the drop.
    mid = len(traj.t) // 2
    assert traj.position[mid][1] == pytest.approx(y_end / 4, rel=0.02)


def test_cyclotron_orbit_closes_and_conserves_speed(kb, problems):
    p = problems["p311"]
    traj = simulate(kb, p.scene, "e1", 3.5724e-9, samples=360)
    assert math.hypot(*traj.position[-1]) < 0.05 * 0.000568563  # back at the start
    assert traj.speed[-1] == pytest.approx(traj.speed[0], rel=1e-3)


def test_sulfur_ion_orbit_radius_matches_engine_a(kb, problems):
    p = problems["p304"]
    traj = simulate(kb, p.scene, "ion", 4.1677e-6, samples=360)
    diameter = max(math.hypot(*pos) for pos in traj.position)
    assert diameter == pytest.approx(2 * _answer(kb, p), rel=0.02)


# ------------------------------------------------------------ Engine B networks

@pytest.mark.parametrize("pid,want", [("p308", -1 / 13), ("p309", 48 / 215)])
def test_unbalanced_networks_need_engine_b(kb, problems, pid, want):
    p = problems[pid]
    assert Resolver(kb, p.scene).resolve(p.target) == []  # chain honestly cannot
    derivations, engine = resolve_problem(kb, p)
    assert engine == "system"
    assert float(derivations[0].value.value) == pytest.approx(want, rel=1e-6)


# ------------------------------------------------------------ corpus hygiene

def test_p3xx_problems_are_tagged_and_cited(kb, problems):
    p3 = [p for pid, p in problems.items() if pid.startswith("p3")]
    assert len(p3) >= 10
    for p in p3:
        assert any(t in p.tags for t in ("jee-advanced", "jee-main", "book")), p.id
        assert p.source and "not reproduced" in p.source, p.id

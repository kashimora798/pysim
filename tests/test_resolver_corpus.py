"""The resolver, the corpus and the SimSpec contract."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kernel.engine_chain import Resolver
from kernel.kb import load_kb
from kernel.solve import resolve_problem
from kernel.scene import Ref, SceneError, build_scene, load_corpus, load_problem
from kernel.trace import build_simspec
from kernel.validate import CORPUS_DIR

CORPUS = CORPUS_DIR


@pytest.fixture(scope="module")
def kb():
    return load_kb()


@pytest.fixture(scope="module")
def problems(kb):
    return load_corpus(CORPUS, kb)


def _ids(problems):
    return [p.id for p in problems]


# --------------------------------------------------------------------------- resolution


def test_every_problem_resolves_to_its_known_answer(kb, problems):
    failures = []
    for problem in problems:
        derivations, _engine = resolve_problem(kb, problem)
        if not derivations:
            failures.append(f"{problem.id}: unresolved")
            continue
        got = derivations[0].value
        want = problem.expect
        assert want is not None, f"{problem.id} has no expectation"
        value = got.magnitude if got.is_vector else abs(float(got.value))
        target = abs(want.value)
        if abs(value - target) / max(target, 1e-30) > want.tol:
            failures.append(f"{problem.id}: got {value:g}, want {target:g}")
    assert not failures, failures


def test_all_paths_of_a_problem_agree(kb, problems):
    """Cross-path agreement is the verification story: two routes, one number."""
    checked = 0
    for problem in problems:
        derivations = Resolver(kb, problem.scene).resolve(problem.target)
        if len(derivations) < 2:
            continue
        checked += 1
        values = [
            d.value.magnitude if d.value.is_vector else float(d.value.value) for d in derivations
        ]
        spread = max(values) - min(values)
        scale = max(abs(v) for v in values) or 1.0
        assert spread / scale < 1e-9, f"{problem.id}: paths disagree -> {values}"
    assert checked >= 1, "no multi-path problem in the corpus to cross-check"


def test_alternative_paths_use_different_laws(kb, problems):
    """Not algebraic rearrangements -- genuinely different physics."""
    multi = []
    for problem in problems:
        derivations = Resolver(kb, problem.scene).resolve(problem.target)
        if len(derivations) >= 2:
            multi.append((problem.id, [d.laws for d in derivations]))
    assert multi, "no multi-path problems"
    for pid, law_sets in multi:
        assert len(set(law_sets)) == len(law_sets), f"{pid}: two paths cite identical laws"


def test_cross_domain_chain_crosses_domains(kb, problems):
    """The flagship claim: one trace spanning electromagnetism and mechanics."""
    flagship = next(p for p in problems if p.id == "p011")
    derivation = Resolver(kb, flagship.scene).resolve(flagship.target)[0]
    domains = {kb.ontology.prop(s.ref.prop).domain for s in derivation.steps}
    assert {"electromagnetism", "mechanics", "kinematics"} <= domains, domains
    assert len(derivation.laws) >= 4, derivation.laws


def test_shielded_cavity_resolves_with_no_inputs(kb, problems):
    """A result justified entirely by a relation, computed from no given value at all."""
    problem = next(p for p in problems if p.id == "p004")
    derivation = Resolver(kb, problem.scene).resolve(problem.target)[0]
    final = derivation.steps[-1]
    assert final.formula is not None
    assert final.inputs == ()
    assert float(final.quantity.value) == 0.0
    assert final.quantity.dim == kb.ontology.prop("em.electric_field_magnitude").dim


def test_every_step_is_justified(kb, problems):
    """No step may exist without either being given or citing a formula."""
    for problem in problems:
        for derivation in Resolver(kb, problem.scene).resolve(problem.target):
            for step in derivation.steps:
                assert step.is_given or step.formula is not None
                assert step.cite, f"{problem.id}: {step.ref} has no citation"


def test_unreachable_target_explains_itself(kb, problems):
    """A failure must say what was missing, since the audit's backlog depends on it."""
    problem = next(p for p in problems if p.id == "p002")
    resolver = Resolver(kb, problem.scene)
    # Nothing in the scene can give a probe a mass.
    assert resolver.resolve(Ref("p1", "mechanics.mass")) == []
    failure = resolver.failure(Ref("p1", "mechanics.mass"))
    assert "mechanics.mass" in str(failure)


# --------------------------------------------------------------------------- scene rules


def test_setting_an_observable_is_refused(kb):
    with pytest.raises(SceneError, match="observable"):
        build_scene(
            {
                "instances": [
                    {"id": "p", "kind": "charged_particle",
                     "set": {"em.charge": "1 nC", "mechanics.mass": "1 g",
                             "mechanics.force": "[1,0,0] N"}}
                ]
            },
            kb,
        )


def test_initial_conditions_are_allowed(kb):
    """Asserting the answer is refused; asserting a starting condition is not."""
    scene = build_scene(
        {
            "instances": [
                {"id": "e", "kind": "electron", "set": {"kinematics.speed@initial": "0 m/s"}}
            ]
        },
        kb,
    )
    assert scene.given(Ref("e", "kinematics.speed", "initial")) is not None


def test_wrong_dimension_for_a_property_is_refused(kb):
    with pytest.raises(SceneError, match="expects"):
        build_scene(
            {"instances": [{"id": "q", "kind": "point_charge", "set": {"em.charge": "5 kg"}}]},
            kb,
        )


def test_property_not_carried_by_the_component_is_refused(kb):
    with pytest.raises(SceneError, match="does not carry"):
        build_scene(
            {"instances": [{"id": "q", "kind": "point_charge", "set": {"mechanics.mass": "1 kg"}}]},
            kb,
        )


def test_unknown_component_is_refused(kb):
    with pytest.raises(SceneError, match="unknown component"):
        build_scene({"instances": [{"id": "x", "kind": "flux_capacitor"}]}, kb)


def test_relation_to_unknown_instance_is_refused(kb):
    with pytest.raises(SceneError, match="unknown instance"):
        build_scene(
            {
                "instances": [{"id": "q", "kind": "point_charge", "set": {"em.charge": "1 nC"}}],
                "relations": [{"kind": "acts_on", "from": "q", "to": "ghost"}],
            },
            kb,
        )


def test_components_arrive_stocked(kb):
    """Placing an electron brings its charge and mass with it."""
    scene = build_scene({"instances": [{"id": "e", "kind": "electron"}]}, kb)
    assert scene.given(Ref("e", "mechanics.mass")) is not None
    assert scene.given(Ref("e", "em.charge")) is not None


# --------------------------------------------------------------------------- SimSpec


def test_simspec_is_json_and_every_beat_is_justified(kb, problems):
    for problem in problems:
        derivations, _engine = resolve_problem(kb, problem)
        spec = build_simspec(problem, derivations, kb)
        data = json.loads(spec.to_json())

        assert data["fieldforge"]
        assert data["checks"]["paths_agree"] is True
        assert data["timeline"], f"{problem.id}: empty timeline"

        for beat in data["timeline"]:
            assert beat["because"], f"{problem.id}: beat {beat['beat']} has no justification"
            assert beat["because"].get("kind")

        # Every component in the scene is placed before anything references it.
        placed: set[str] = set()
        for beat in data["timeline"]:
            if beat["kind"] == "place":
                placed.add(beat["instance"])
            elif beat["kind"] == "relate":
                assert beat["from"] in placed and beat["to"] in placed
            elif "instance" in beat:
                assert beat["instance"] in placed, (
                    f"{problem.id}: beat {beat['beat']} uses {beat['instance']} before placing it"
                )


def test_simspec_derived_beats_carry_law_and_citation(kb, problems):
    problem = next(p for p in problems if p.id == "p011")
    derivations = Resolver(kb, problem.scene).resolve(problem.target)
    data = json.loads(build_simspec(problem, derivations, kb).to_json())
    derived = [b for b in data["timeline"] if b["kind"] == "resolve"]
    assert derived
    for beat in derived:
        because = beat["because"]
        assert because["formula"]
        assert because["expression"]
        assert because["substituted"]
        assert because["cite"]


def test_simspec_records_every_alternative_path(kb, problems):
    problem = next(p for p in problems if p.id == "p001")
    derivations = Resolver(kb, problem.scene).resolve(problem.target)
    data = json.loads(build_simspec(problem, derivations, kb).to_json())
    assert len(data["paths"]) == len(derivations) >= 2
    laws = [tuple(p["laws"]) for p in data["paths"]]
    assert len(set(laws)) == len(laws)


def test_corpus_problems_all_have_prose_and_a_source(problems):
    for problem in problems:
        assert problem.text, f"{problem.id} has no problem statement"
        assert problem.source, f"{problem.id} has no source attribution"
        assert problem.expect is not None, f"{problem.id} has no expected answer"

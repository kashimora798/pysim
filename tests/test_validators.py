"""The six validators, and the knowledge base they run against.

The positive tests assert the shipped knowledge base is clean. The negative tests matter more:
they assert that deliberately broken physics is *rejected*. A compiler nobody has watched reject
anything is not a compiler.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest
import yaml

from kernel.kb import KBError, load_kb
from kernel.validate import (
    audit,
    check_dims_and_rank,
    check_orphans,
    check_refs,
    check_units,
)
from kernel.validate import Report


@pytest.fixture(scope="module")
def kb():
    return load_kb()


# --------------------------------------------------------------------------- the real KB


def test_shipped_knowledge_base_is_clean(kb):
    report, _ = audit(kb, with_coverage=False)
    assert report.ok, "\n".join(f"{f.check} {f.where}: {f.message}" for f in report.errors)


def test_shipped_corpus_fully_resolves(kb):
    report, rows = audit(kb, with_coverage=True)
    assert report.ok, "\n".join(f"{f.check} {f.where}: {f.message}" for f in report.errors)
    assert rows, "no corpus problems were found"
    assert all(r.resolved for r in rows), [r.problem.id for r in rows if not r.resolved]
    assert all(r.agrees for r in rows), [r.problem.id for r in rows if not r.agrees]
    assert report.stats["corpus_multipath"] >= 1, "no problem had an alternative derivation"


def test_every_formula_cites_a_source(kb):
    missing = [f.key for f in kb.formulas.values() if not f.cite]
    assert not missing, f"formulas without a citation: {missing}"


def test_every_formula_names_a_law_or_is_definitional(kb):
    orphaned = [
        f.key for f in kb.formulas.values()
        if not f.law and f.cite.lower() not in ("definitional", "geometry")
    ]
    assert not orphaned, f"formulas with no law and no definitional excuse: {orphaned}"


def test_no_component_names_a_formula(kb):
    """The linking discipline: components and formulas may only meet through property keys."""
    formula_keys = set(kb.formulas)
    for component in kb.components.values():
        text = yaml.safe_dump(
            {"tags": list(component.tags), "laws": list(component.laws),
             "slots": sorted(component.slots)}
        )
        for key in formula_keys:
            assert key not in text, f"{component.key} references formula {key}"


def test_tools_are_ordinary_components(kb):
    """A measurement is placing a component, not a special case in the engine."""
    tools = kb.components_tagged("tool")
    assert tools, "no tools in the shop"
    for tool in tools:
        assert tool.slots, f"{tool.key} carries no properties, so nothing can be read off it"


# --------------------------------------------------------------------------- negatives


def _kb_with_formula(tmp_path: Path, body: str):
    """Build a knowledge base whose formula table is exactly `body`."""
    root = tmp_path / "kb"
    for sub in ("components", "formulas", "laws"):
        (root / sub).mkdir(parents=True, exist_ok=True)
    real = Path(__file__).resolve().parent.parent / "kernel" / "data" / "kb"
    for sub in ("components", "laws"):
        for src in (real / sub).glob("*.yaml"):
            (root / sub / src.name).write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    (root / "formulas" / "test.yaml").write_text(textwrap.dedent(body), encoding="utf-8")
    return load_kb(root)


def test_inverse_cube_coulomb_is_rejected(tmp_path):
    """The headline negative case.

    The research document quotes a builder on exactly this failure: "a simulation that looks
    correct but implements 1/r^3 instead of 1/r^2 is worse than no simulation at all." Here it
    cannot reach a learner, because the declared dimension and the inferred dimension disagree.
    """
    kb = _kb_with_formula(
        tmp_path,
        """
        formulas:
          bad.coulomb_inverse_cube:
            solves_for: em.electric_field_magnitude
            scope: self
            bindings:
              k_e: {const: k_e}
              Q:   {prop: em.charge_magnitude}
              r:   {prop: geometry.radius}
            expr: "k_e * Q / r**3"
            law: coulombs_law
            cite: "deliberately wrong"
        """,
    )
    report = Report()
    check_dims_and_rank(kb, report)
    assert report.errors, "a 1/r^3 Coulomb law was accepted"
    message = report.errors[0].message
    assert "em.electric_field_magnitude" in message
    assert report.errors[0].check == "dims"


def test_inhomogeneous_sum_is_rejected(tmp_path):
    kb = _kb_with_formula(
        tmp_path,
        """
        formulas:
          bad.add_charge_to_length:
            solves_for: em.charge
            scope: self
            bindings:
              q: {prop: em.charge}
              R: {prop: geometry.radius}
            expr: "q + R"
            cite: "deliberately wrong"
        """,
    )
    report = Report()
    check_dims_and_rank(kb, report)
    assert any(f.check == "dims" for f in report.errors)


def test_scalar_claiming_to_be_a_vector_is_rejected(tmp_path):
    kb = _kb_with_formula(
        tmp_path,
        """
        formulas:
          bad.scalar_as_vector:
            solves_for: em.electric_field
            scope: self
            bindings:
              V: {prop: em.potential_difference}
              d: {prop: geometry.separation_plates}
            expr: "V / d"
            cite: "deliberately wrong"
        """,
    )
    report = Report()
    check_dims_and_rank(kb, report)
    assert any(f.check == "rank" for f in report.errors), report.findings


def test_dangling_property_reference_is_rejected(tmp_path):
    kb = _kb_with_formula(
        tmp_path,
        """
        formulas:
          bad.dangling:
            solves_for: em.charge
            scope: self
            bindings:
              x: {prop: em.not_a_real_property}
            expr: "x"
            cite: "deliberately wrong"
        """,
    )
    report = Report()
    check_refs(kb, report)
    assert any("not_a_real_property" in f.message for f in report.errors)


def test_unused_binding_is_rejected_at_load(tmp_path):
    """An unused binding silently widens what a formula demands, so it never loads."""
    with pytest.raises(KBError, match="declared but never used"):
        _kb_with_formula(
            tmp_path,
            """
            formulas:
              bad.unused:
                solves_for: em.charge
                scope: self
                bindings:
                  q: {prop: em.charge}
                  R: {prop: geometry.radius}
                expr: "q"
                cite: "deliberately wrong"
            """,
        )


def test_undeclared_symbol_is_rejected_at_load(tmp_path):
    with pytest.raises(KBError, match="undeclared symbol"):
        _kb_with_formula(
            tmp_path,
            """
            formulas:
              bad.undeclared:
                solves_for: em.charge
                scope: self
                bindings:
                  q: {prop: em.charge}
                expr: "q * mystery"
                cite: "deliberately wrong"
            """,
        )


def test_pair_scope_without_relation_is_rejected_at_load(tmp_path):
    with pytest.raises(KBError, match="needs at least one role"):
        _kb_with_formula(
            tmp_path,
            """
            formulas:
              bad.pair_no_via:
                solves_for: em.charge
                scope: pair
                bindings:
                  q: {prop: em.charge}
                expr: "q"
                cite: "deliberately wrong"
            """,
        )


def test_self_scope_cannot_bind_across_a_relation(tmp_path):
    with pytest.raises(KBError, match="is not valid here"):
        _kb_with_formula(
            tmp_path,
            """
            formulas:
              bad.self_reaching_out:
                solves_for: em.charge
                scope: self
                bindings:
                  q: {prop: em.charge, from: src}
                expr: "q"
                cite: "deliberately wrong"
            """,
        )


def test_orphan_check_reports_a_property_nothing_can_produce(kb):
    report = Report()
    check_orphans(kb, report)
    warnings = {f.where.split(":")[-1] for f in report.warnings}
    # These are real backlog items in the shipped base, not failures.
    assert warnings, "the orphan audit found nothing at all, which is suspicious"
    for where in warnings:
        assert where in kb.ontology.properties


def test_pair_properties_are_not_reported_as_orphans(kb):
    """A separation is carried by a relation, so "no component declares it" is not a gap."""
    report = Report()
    check_orphans(kb, report)
    flagged = {f.where.split(":")[-1] for f in report.warnings}
    assert "geometry.separation" not in flagged


def test_si_unit_must_match_declared_dimension(kb):
    report = Report()
    check_units(kb, report)
    assert not [f for f in report.errors], [f.message for f in report.errors]


# --------------------------------------------------------------------------- multi-role formulas


def test_two_role_formula_loads(tmp_path):
    """Series reduction needs two roles: R_eq = R_a + R_b."""
    kb = _kb_with_formula(
        tmp_path,
        """
        formulas:
          ok.two_roles:
            solves_for: electric.resistance
            scope: pair
            roles:
              a: {via: member_a, kinds: [resistor]}
              b: {via: member_b, kinds: [resistor]}
            bindings:
              Ra: {prop: electric.resistance, from: a}
              Rb: {prop: electric.resistance, from: b}
            expr: "Ra + Rb"
            law: series_resistance
            cite: "test"
        """,
    )
    f = kb.formulas["ok.two_roles"]
    assert set(f.roles) == {"a", "b"}
    assert f.roles["a"].via == "member_a"


def test_roles_and_legacy_role_cannot_both_be_given(tmp_path):
    with pytest.raises(KBError, match="not both"):
        _kb_with_formula(
            tmp_path,
            """
            formulas:
              bad.both_spellings:
                solves_for: em.charge
                scope: pair
                via: acts_on
                role: src
                roles:
                  a: {via: member_a}
                bindings:
                  q: {prop: em.charge, from: a}
                expr: "q"
                cite: "test"
            """,
        )


def test_reserved_names_cannot_be_roles(tmp_path):
    with pytest.raises(KBError, match="reserved binding source"):
        _kb_with_formula(
            tmp_path,
            """
            formulas:
              bad.reserved_role:
                solves_for: em.charge
                scope: pair
                roles:
                  self: {via: member_a}
                bindings:
                  q: {prop: em.charge, from: self}
                expr: "q"
                cite: "test"
            """,
        )


def test_bare_rel_is_rejected_when_ambiguous(tmp_path):
    """With two roles there are two relations, so `rel` must name which one."""
    with pytest.raises(KBError, match="is not valid here"):
        _kb_with_formula(
            tmp_path,
            """
            formulas:
              bad.ambiguous_rel:
                solves_for: electric.resistance
                scope: pair
                roles:
                  a: {via: member_a}
                  b: {via: member_b}
                bindings:
                  r: {prop: geometry.separation, from: rel}
                expr: "r"
                cite: "test"
            """,
        )

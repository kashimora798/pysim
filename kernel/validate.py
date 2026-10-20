"""The compiler: six mechanical checks over the knowledge base.

This is the part that makes a growing knowledge base an asset instead of a liability. "Nothing is
left unconnected" is not a hope here; it is six checks that run in CI:

1. **refs** — every property key a formula or component names actually exists.
2. **dims** — every formula's expression is dimensionally homogeneous *and* its inferred dimension
   equals the dimension declared for what it solves for. This is the check that kills the
   ``1/r**3``-instead-of-``1/r**2`` class of error before it can ever teach anybody.
3. **rank** — scalars and vectors are not silently interchanged.
4. **units** — every property's declared SI unit actually has the dimension it claims.
5. **orphans** — properties nothing can produce, and properties nothing consumes. Not errors: a
   printed backlog. The audit *is* the to-do list.
6. **coverage** — every corpus problem resolves, and reaches its known answer.

Checks 1-4 are hard failures: invalid physics cannot enter the building. Checks 5-6 report.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from . import exprs
from .dims import DimensionError
from .exprs import ExprError, RankError, Type
from .kb import KnowledgeBase, load_kb
from .ontology import Property
from .scene import Problem, load_corpus
from .units import format_quantity, parse_unit

CORPUS_DIR = Path(__file__).resolve().parent.parent / "corpus" / "problems"

SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}


@dataclass(frozen=True, slots=True)
class Finding:
    check: str
    severity: str  # error | warning | info
    where: str
    message: str

    @property
    def is_error(self) -> bool:
        return self.severity == "error"


@dataclass
class Report:
    findings: list[Finding] = field(default_factory=list)
    stats: dict[str, object] = field(default_factory=dict)

    def add(self, check: str, severity: str, where: str, message: str) -> None:
        self.findings.append(Finding(check, severity, where, message))

    @property
    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "error"]

    @property
    def warnings(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "warning"]

    @property
    def ok(self) -> bool:
        return not self.errors

    def by_check(self) -> dict[str, list[Finding]]:
        out: dict[str, list[Finding]] = {}
        for f in self.findings:
            out.setdefault(f.check, []).append(f)
        return out


# --------------------------------------------------------------------------- 1. refs


def check_refs(kb: KnowledgeBase, report: Report) -> None:
    props = kb.ontology.properties

    for component in kb.components.values():
        for prop in component.slots:
            if prop not in props:
                report.add(
                    "refs", "error", f"{component.source}:{component.key}",
                    f"carries unknown property {prop!r}",
                )
        for law in component.laws:
            if law not in kb.laws:
                report.add(
                    "refs", "error", f"{component.source}:{component.key}",
                    f"cites unknown law {law!r}",
                )

    for formula in kb.formulas.values():
        at = f"{formula.source}:{formula.key}"
        if formula.solves_for not in props:
            report.add("refs", "error", at, f"solves_for unknown property {formula.solves_for!r}")
        for binding in formula.bindings.values():
            if binding.is_const:
                if binding.const not in kb.ontology.constants:
                    report.add("refs", "error", at, f"binds unknown constant {binding.const!r}")
            elif binding.prop not in props:
                report.add("refs", "error", at, f"binds unknown property {binding.prop!r}")
        if formula.law and formula.law not in kb.laws:
            report.add("refs", "error", at, f"cites unknown law {formula.law!r}")
        for role in formula.roles.values():
            for kind in role.kinds:
                if kind not in kb.components:
                    report.add(
                        "refs", "error", at,
                        f"role {role.name!r} names unknown component kind {kind!r}",
                    )

    for law in kb.laws.values():
        for prop in law.governs:
            if prop not in props:
                report.add(
                    "refs", "error", f"{law.source}:{law.key}",
                    f"governs unknown property {prop!r}",
                )


# --------------------------------------------------------------------------- 2+3. dims, rank


def _binding_types(kb: KnowledgeBase, formula) -> dict[str, Type] | None:
    env: dict[str, Type] = {}
    for symbol, binding in formula.bindings.items():
        if binding.is_const:
            constant = kb.ontology.constants.get(binding.const or "")
            if constant is None:
                return None
            env[symbol] = constant.type
        else:
            prop = kb.ontology.properties.get(binding.prop or "")
            if prop is None:
                return None
            env[symbol] = prop.type
    return env


def check_dims_and_rank(kb: KnowledgeBase, report: Report) -> None:
    for formula in kb.formulas.values():
        at = f"{formula.source}:{formula.key}"
        env = _binding_types(kb, formula)
        if env is None:
            continue  # refs already reported the real problem

        try:
            inferred = exprs.infer(formula.expr, env, where=formula.key)
        except DimensionError as exc:
            report.add("dims", "error", at, str(exc))
            continue
        except RankError as exc:
            report.add("rank", "error", at, str(exc))
            continue
        except ExprError as exc:
            report.add("dims", "error", at, str(exc))
            continue

        declared = kb.ontology.properties.get(formula.solves_for)
        if declared is None:
            continue

        # A literal zero belongs to every dimension space, so it is admissible against any target.
        if formula.expr.is_zero:
            continue

        if inferred.dim != declared.dim:
            report.add(
                "dims", "error", at,
                f"`{formula.expr_text}` has dimension {inferred.dim}, but it claims to solve "
                f"{formula.solves_for} which is {declared.dim}. "
                + "  ".join(f"{s}:{t.dim}" for s, t in sorted(env.items())),
            )
        if inferred.rank != declared.rank:
            report.add(
                "rank", "error", at,
                f"`{formula.expr_text}` is a {inferred.rank}, but {formula.solves_for} "
                f"is a {declared.rank}",
            )


# --------------------------------------------------------------------------- 4. units


def check_units(kb: KnowledgeBase, report: Report) -> None:
    for prop in kb.ontology.properties.values():
        if not prop.si_unit:
            report.add(
                "units", "warning", f"{prop.source}:{prop.key}",
                "no si_unit declared, so values cannot be displayed in natural units",
            )
            continue
        try:
            dim, _ = parse_unit(prop.si_unit)
        except Exception as exc:
            report.add("units", "error", f"{prop.source}:{prop.key}", str(exc))
            continue
        if dim != prop.dim:
            report.add(
                "units", "error", f"{prop.source}:{prop.key}",
                f"si_unit {prop.si_unit!r} has dimension {dim}, but the property declares {prop.dim}",
            )

    for constant in kb.ontology.constants.values():
        if constant.quantity.dim.is_dimensionless and constant.key not in {"pi_const"}:
            report.add(
                "units", "info", f"constants:{constant.key}",
                "is dimensionless — check that this is intended",
            )


# --------------------------------------------------------------------------- 5. orphans


def _producers(kb: KnowledgeBase, prop: Property) -> list[str]:
    reasons: list[str] = []
    if kb.solvers_for(prop.key):
        reasons.append(f"{len(kb.solvers_for(prop.key))} formula(s)")
    settable = [
        c.key for c in kb.components.values()
        if (slot := c.slot(prop.key)) and slot.role in ("settable", "intrinsic")
    ]
    if settable:
        reasons.append(f"settable on {len(settable)} component(s)")
    governing = [law.key for law in kb.laws.values() if prop.key in law.governs]
    if governing:
        reasons.append(f"governed by {len(governing)} law(s)")
    return reasons


def check_orphans(kb: KnowledgeBase, report: Report) -> None:
    consumed: set[str] = set()
    for formula in kb.formulas.values():
        for binding in formula.bindings.values():
            if binding.prop:
                consumed.add(binding.prop)

    carried: set[str] = set()
    for component in kb.components.values():
        carried.update(component.slots)

    for prop in kb.ontology.properties.values():
        at = f"{prop.source}:{prop.key}"

        # A `pair` property is carried by a relation, not by a component, so "no component
        # declares it" is the normal case rather than a gap.
        relation_supplied = prop.kind == "pair"

        if not kb.solvers_for(prop.key) and not relation_supplied:
            settable = any(
                (slot := c.slot(prop.key)) and slot.role in ("settable", "intrinsic")
                for c in kb.components.values()
            )
            if not settable:
                report.add(
                    "orphans", "warning", at,
                    "nothing can produce this: no solving formula and not settable on any "
                    "component. Either add a formula or mark it settable somewhere.",
                )

        if prop.key not in consumed and not kb.solvers_for(prop.key):
            report.add(
                "orphans", "info", at,
                "no formula consumes or produces it — it is inert in the current knowledge base",
            )

        if prop.key not in carried and not relation_supplied:
            report.add(
                "orphans", "info", at,
                "no component carries it, so no scene can ever mention it",
            )

    for component in kb.components.values():
        required_without_source = [
            s.prop for s in component.slots.values() if s.required and s.default is None
        ]
        if len(required_without_source) > 4:
            report.add(
                "orphans", "info", f"{component.source}:{component.key}",
                f"requires {len(required_without_source)} values to be set — heavy for a problem "
                "statement to supply",
            )


# --------------------------------------------------------------------------- 6. coverage


@dataclass
class CoverageRow:
    problem: Problem
    resolved: bool
    paths: int
    value: str = ""
    expected: str = ""
    agrees: bool | None = None
    detail: str = ""


def check_coverage(
    kb: KnowledgeBase, report: Report, corpus_dir: Path | None = None
) -> list[CoverageRow]:
    from .engine_chain import Resolver

    corpus_dir = corpus_dir or CORPUS_DIR
    rows: list[CoverageRow] = []
    if not corpus_dir.exists():
        report.add("coverage", "warning", str(corpus_dir), "no corpus directory found")
        return rows

    from .solve import cross_check, resolve_problem

    problems = load_corpus(corpus_dir, kb)
    for problem in problems:
        at = f"corpus:{problem.id}"
        resolver = Resolver(kb, problem.scene)
        derivations, engine = resolve_problem(kb, problem)

        if not derivations:
            report.add("coverage", "error", at, str(resolver.failure(problem.target)))
            rows.append(CoverageRow(problem=problem, resolved=False, paths=0))
            continue

        disagreement = cross_check(kb, problem)
        if disagreement:
            report.add("coverage", "error", at, disagreement)

        best = derivations[0]
        row = CoverageRow(
            problem=problem,
            resolved=True,
            paths=len(derivations),
            value=format_quantity(best.value),
        )

        if problem.expect is not None:
            from .units import parse_quantity

            want = parse_quantity(f"{problem.expect.value} {problem.expect.unit}")
            got = best.value.magnitude if best.value.is_vector else float(best.value.value)
            target_value = want.magnitude if want.is_vector else float(want.value)
            scale = max(abs(target_value), 1e-30)
            row.expected = format_quantity(want)
            row.agrees = abs(got - target_value) / scale <= problem.expect.tol
            if not row.agrees:
                report.add(
                    "coverage", "error", at,
                    f"resolved to {format_quantity(best.value)} but expected "
                    f"{format_quantity(want)} (tolerance {problem.expect.tol:.1%})",
                )

            # Every complete path must agree with every other, or the knowledge base is
            # inconsistent. This is the cross-check that makes "lawful" testable.
            for other in derivations[1:]:
                other_value = (
                    other.value.magnitude if other.value.is_vector else float(other.value.value)
                )
                if abs(other_value - got) / scale > problem.expect.tol:
                    report.add(
                        "coverage", "error", at,
                        f"paths disagree: {'+'.join(best.formulas)} gives "
                        f"{format_quantity(best.value)} but {'+'.join(other.formulas)} gives "
                        f"{format_quantity(other.value)}",
                    )
        rows.append(row)

    resolved = sum(1 for r in rows if r.resolved)
    agreeing = sum(1 for r in rows if r.agrees)
    report.stats["corpus_total"] = len(rows)
    report.stats["corpus_resolved"] = resolved
    report.stats["corpus_correct"] = agreeing
    report.stats["corpus_multipath"] = sum(1 for r in rows if r.paths > 1)
    return rows


# --------------------------------------------------------------------------- runner


def audit(
    kb: KnowledgeBase | None = None,
    *,
    corpus_dir: Path | None = None,
    with_coverage: bool = True,
) -> tuple[Report, list[CoverageRow]]:
    kb = kb or load_kb()
    report = Report()
    report.stats.update(
        properties=len(kb.ontology.properties),
        constants=len(kb.ontology.constants),
        components=len(kb.components),
        formulas=len(kb.formulas),
        laws=len(kb.laws),
    )

    check_refs(kb, report)
    check_dims_and_rank(kb, report)
    check_units(kb, report)
    check_orphans(kb, report)

    rows: list[CoverageRow] = []
    if with_coverage:
        # Only meaningful once the structural checks pass; a bad reference makes every
        # resolution failure a red herring.
        if report.ok:
            rows = check_coverage(kb, report, corpus_dir)
        else:
            report.add(
                "coverage", "info", "-",
                "skipped: fix the structural errors above first, or every resolution failure "
                "below would be a symptom rather than a cause",
            )
    return report, rows

"""``ff export`` — compile the verified knowledge base into static JSON for the browser.

The app judges will open is a static site, so the kernel does not run at runtime. It runs *here*,
at build time, and ships only what it has already proved:

* every validator must pass, or the export refuses — a browser never receives unverified physics;
* each formula's expression is serialised to a small JSON AST, so the runtime needs a ~120-line
  evaluator instead of SymPy;
* every corpus problem is resolved now and its trace written out as a SimSpec, so Auto and Guided
  modes need no solver in the browser at all.

That last point is the load-bearing one. The two highest-value modes replay precompiled traces;
only the free-build bench needs the resolver port. The riskiest code is therefore not on the
critical path of the best demo.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from . import exprs
from .dims import BASE, Dim
from .engine_chain import Resolver
from .kb import KnowledgeBase, load_kb
from .scene import Problem, load_corpus
from .trace import build_simspec
from .units import Quantity, display_unit, format_quantity
from .validate import CORPUS_DIR, audit

#: Default output root. `web/public/` is what Vite serves verbatim.
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "web" / "public" / "physics"

SCHEMA_VERSION = "1"


class ExportError(RuntimeError):
    """Raised when the knowledge base is not fit to ship."""


def _dim_list(dim: Dim) -> list[float]:
    """A dimension as a plain 7-array, in :data:`kernel.dims.BASE` order.

    An array rather than an object: the runtime compares dimensions constantly, and comparing
    seven numbers is cheaper and less error-prone than comparing sparse maps.
    """
    return [float(x) for x in dim.e]


def _dim_key(dim: Dim) -> str:
    return ",".join(
        str(int(x)) if float(x).is_integer() else str(float(x)) for x in dim.e
    )


def _quantity_json(q: Quantity) -> dict:
    return {
        "value": list(q.value) if q.is_vector else float(q.value),  # type: ignore[arg-type]
        "dim": _dim_list(q.dim),
        "rank": q.rank,
        "unit": display_unit(q.dim),
        "display": format_quantity(q),
    }


# --------------------------------------------------------------------------- knowledge base


def build_kb_json(kb: KnowledgeBase, audit_summary: dict) -> dict:
    properties = {
        p.key: {
            "symbol": p.symbol,
            "dim": _dim_list(p.dim),
            "dimKey": _dim_key(p.dim),
            "dimText": str(p.dim),
            "rank": p.rank,
            "kind": p.kind,
            "siUnit": p.si_unit,
            "unit": display_unit(p.dim),
            "domain": p.domain,
            "description": p.description,
        }
        for p in kb.ontology.properties.values()
    }

    constants = {
        c.key: {
            "symbol": c.symbol,
            **_quantity_json(c.quantity),
            "description": c.description,
            "cite": c.cite,
        }
        for c in kb.ontology.constants.values()
    }

    components = {
        c.key: {
            "label": c.label,
            "tags": list(c.tags),
            "laws": list(c.laws),
            "model3d": c.model3d,
            "description": c.description.strip(),
            "slots": {
                slot.prop: {
                    "role": slot.role,
                    "required": slot.required,
                    "default": slot.default,
                    "defaultQuantity": (
                        _quantity_json(_parse(slot.default)) if slot.default else None
                    ),
                    "note": slot.note,
                }
                for slot in c.slots.values()
            },
        }
        for c in kb.components.values()
    }

    formulas = {}
    for f in kb.formulas.values():
        formulas[f.key] = {
            "solvesFor": f.solves_for,
            "producesState": f.produces_state,
            "scope": f.scope,
            "roles": {
                name: {"via": r.via, "kinds": list(r.kinds)} for name, r in f.roles.items()
            },
            "exprText": f.expr_text,
            "ast": exprs.to_ast(f.expr, where=f.key),
            "bindings": {
                symbol: {
                    "prop": b.prop,
                    "const": b.const,
                    "from": b.frm,
                    "state": b.state,
                }
                for symbol, b in f.bindings.items()
            },
            "law": f.law,
            "assumes": list(f.assumes),
            "cite": f.cite,
            "cost": f.cost,
            "note": f.note.strip(),
        }

    laws = {
        law.key: {
            "label": law.label,
            "statement": law.statement.strip(),
            "governs": list(law.governs),
            "cite": law.cite,
        }
        for law in kb.laws.values()
    }

    #: Preferred display unit per dimension, so the runtime formats quantities as physics
    #: ("0.5 A") rather than as base SI ("0.5 A"), without duplicating the table in TypeScript.
    display_units: dict[str, str] = {}
    for p in kb.ontology.properties.values():
        display_units.setdefault(_dim_key(p.dim), display_unit(p.dim))

    #: Which property each formula can produce, pre-indexed. This is the "components are the
    #: index" collapse, shipped as a lookup so the runtime never scans all formulas.
    solvers: dict[str, list[str]] = {}
    for prop, group in kb.solvers.items():
        solvers[prop] = [f.key for f in group]

    return {
        "schema": SCHEMA_VERSION,
        "audit": audit_summary,
        "base": list(BASE),
        "properties": properties,
        "constants": constants,
        "components": components,
        "formulas": formulas,
        "laws": laws,
        "solvers": solvers,
        "displayUnits": display_units,
    }


def _parse(text: str) -> Quantity:
    from .units import parse_quantity

    return parse_quantity(text)


# --------------------------------------------------------------------------- the command


@dataclass
class ExportResult:
    out_dir: Path
    kb_bytes: int
    problems: list[str]
    spec_bytes: int
    content_hash: str
    warnings: int


def export(
    out_dir: Path | None = None,
    *,
    corpus_dir: Path | None = None,
    allow_warnings: bool = True,
) -> ExportResult:
    """Validate, compile and write the static physics bundle."""
    out_dir = out_dir or DEFAULT_OUT
    corpus_dir = corpus_dir or CORPUS_DIR

    kb = load_kb()
    report, rows = audit(kb, corpus_dir=corpus_dir, with_coverage=True)

    if report.errors:
        lines = "\n".join(f"  [{f.check}] {f.where}: {f.message}" for f in report.errors)
        raise ExportError(
            f"refusing to export: {len(report.errors)} validator error(s).\n{lines}\n"
            "The browser must only ever receive verified physics."
        )
    if report.warnings and not allow_warnings:
        raise ExportError(f"refusing to export: {len(report.warnings)} warning(s) with --strict")

    unresolved = [r.problem.id for r in rows if not r.resolved]
    disagreeing = [r.problem.id for r in rows if r.resolved and r.agrees is False]
    if unresolved or disagreeing:
        raise ExportError(
            f"refusing to export: unresolved={unresolved} disagreeing={disagreeing}"
        )

    audit_summary = {
        "checks": {"refs": "pass", "dims": "pass", "rank": "pass", "units": "pass"},
        "errors": 0,
        "warnings": len(report.warnings),
        "backlog": sorted(
            {f.where.split(":")[-1] for f in report.warnings if f.check == "orphans"}
        ),
        "counts": {
            "properties": len(kb.ontology.properties),
            "constants": len(kb.ontology.constants),
            "components": len(kb.components),
            "formulas": len(kb.formulas),
            "laws": len(kb.laws),
        },
        "coverage": {
            "total": len(rows),
            "resolved": sum(1 for r in rows if r.resolved),
            "agreeing": sum(1 for r in rows if r.agrees),
            "multipath": sum(1 for r in rows if r.paths > 1),
        },
    }

    kb_json = build_kb_json(kb, audit_summary)

    specs_dir = out_dir / "specs"
    specs_dir.mkdir(parents=True, exist_ok=True)

    problems = load_corpus(corpus_dir, kb)
    manifest = []
    spec_bytes = 0
    for problem in problems:
        derivations = Resolver(kb, problem.scene).resolve(problem.target)
        spec = build_simspec(problem, derivations, kb)
        text = spec.to_json()
        (specs_dir / f"{problem.id}.json").write_text(text, encoding="utf-8")
        spec_bytes += len(text.encode("utf-8"))

        data = spec.data
        manifest.append(
            {
                "id": problem.id,
                "title": problem.title,
                "text": problem.text,
                "source": problem.source,
                "tags": list(problem.tags),
                "target": str(problem.target),
                "answer": data["answer"]["display"],
                "beats": len(data["timeline"]),
                "paths": len(data["paths"]),
                "laws": sorted({law for p in data["paths"] for law in p["laws"]}),
                "components": sorted({i["kind"] for i in data["scene"]["instances"]}),
                "spec": f"specs/{problem.id}.json",
            }
        )

    # Hash the physics, not the wrapper, so the hash is stable across cosmetic changes and can be
    # shown in-app as an honest provenance stamp.
    payload = json.dumps(
        {"kb": kb_json, "manifest": manifest}, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    content_hash = hashlib.sha256(payload).hexdigest()[:16]
    kb_json["contentHash"] = content_hash

    out_dir.mkdir(parents=True, exist_ok=True)
    kb_text = json.dumps(kb_json, indent=1, ensure_ascii=False)
    (out_dir / "kb.json").write_text(kb_text, encoding="utf-8")
    (out_dir / "problems.json").write_text(
        json.dumps({"schema": SCHEMA_VERSION, "contentHash": content_hash, "problems": manifest},
                   indent=1, ensure_ascii=False),
        encoding="utf-8",
    )

    return ExportResult(
        out_dir=out_dir,
        kb_bytes=len(kb_text.encode("utf-8")),
        problems=[p.id for p in problems],
        spec_bytes=spec_bytes,
        content_hash=content_hash,
        warnings=len(report.warnings),
    )

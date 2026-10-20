"""Trace -> SimSpec.

The derivation order *is* the animation order. There is no separate animation planner: each step
of the trace becomes one beat, and every beat carries a ``because`` naming the formula, the law
and the source that justify it. A renderer that cannot explain a frame cannot draw it.

SimSpec is the contract between the kernel and anything downstream — a 3D player, a worked-example
page, an MCP client. The kernel never imports a renderer; the renderer never imports the kernel.
That is what lets visual quality and physics correctness scale independently.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .engine_chain import Derivation, Step
from .kb import KnowledgeBase
from .scene import Problem, Ref, Scene
from .units import Quantity, display_unit, format_quantity

SPEC_VERSION = "0.1"

#: Which visual channel a property drives. The renderer owns the look; the kernel owns the
#: mapping, because the mapping is a claim about what the quantity *is*.
CHANNEL: dict[str, str] = {
    "em.electric_field": "field_arrows",
    "em.electric_field_magnitude": "field_intensity",
    "em.electric_potential": "potential_shading",
    "em.magnetic_field": "field_arrows",
    "em.magnetic_field_magnitude": "field_intensity",
    "mechanics.force": "force_vector",
    "mechanics.force_magnitude": "force_vector",
    "kinematics.acceleration": "acceleration_vector",
    "kinematics.acceleration_magnitude": "acceleration_vector",
    "kinematics.velocity": "velocity_vector",
    "kinematics.speed": "velocity_vector",
    "kinematics.displacement": "trajectory",
    "kinematics.distance": "trajectory",
    "kinematics.time": "clock",
    "energy.kinetic": "energy_bar",
    "energy.potential_electric": "energy_bar",
    "mechanics.work": "energy_bar",
    "em.charge": "charge_glyph",
    "em.charge_magnitude": "charge_glyph",
    "em.cyclotron_radius": "orbit_circle",
    "em.cyclotron_period": "clock",
    "em.charge_density_volume": "density_shading",
    "em.charge_density_surface": "density_shading",
    "em.charge_density_linear": "density_shading",
    "em.potential_difference": "potential_shading",
    "em.electric_flux": "flux_surface",
    "mechanics.mass": "mass_label",
    "mechanics.momentum": "momentum_vector",
    "geometry.position": "placement",
    "geometry.offset": "offset_vector",
    "geometry.radius": "radius_ring",
    "geometry.separation": "separation_dimension",
    "geometry.separation_plates": "gap_dimension",
    "geometry.length": "dimension_label",
    "geometry.area": "dimension_label",
    "geometry.volume": "dimension_label",
    "geometry.angle": "angle_arc",
}


def _quantity_json(q: Quantity) -> dict[str, Any]:
    return {
        "value": list(q.value) if q.is_vector else float(q.value),  # type: ignore[arg-type]
        "unit": display_unit(q.dim),
        "dimension": q.dim.as_mapping(),
        "rank": q.rank,
        "display": format_quantity(q),
    }


def _narrate(step: Step, kb: KnowledgeBase) -> str:
    prop = kb.ontology.prop(step.ref.prop)
    name = prop.key.rsplit(".", 1)[-1].replace("_", " ")
    where = step.ref.instance
    value = format_quantity(step.quantity)
    if step.is_given:
        return f"{where}: {name} is {value}, as stated."
    return f"{where}: {name} resolves to {value}."


def _because(step: Step, kb: KnowledgeBase) -> dict[str, Any]:
    """The trust contract, per beat. Never empty."""
    if step.is_given:
        return {"kind": "given", "detail": "supplied by the problem statement"}
    formula = step.formula
    assert formula is not None
    law = kb.laws.get(formula.law or "")
    return {
        "kind": "derived",
        "formula": formula.key,
        "expression": formula.expr_text,
        "substituted": step.substituted(),
        "law": formula.law,
        "law_label": law.label if law else None,
        "law_statement": law.statement.strip() if law else None,
        "assumes": list(formula.assumes),
        "cite": formula.cite,
        "inputs": [
            {
                "symbol": i.symbol,
                "from": (i.const if i.const else str(i.ref)),
                **_quantity_json(i.quantity),
            }
            for i in step.inputs
        ],
    }


def _path_json(d: Derivation, kb: KnowledgeBase) -> dict[str, Any]:
    return {
        "cost": d.cost,
        "laws": sorted(d.laws),
        "formulas": list(d.formulas),
        "value": _quantity_json(d.value),
        "assumptions": list(d.assumptions),
        "citations": list(d.citations),
        "steps": [
            {
                "ref": str(s.ref),
                "property": s.ref.prop,
                **_quantity_json(s.quantity),
                "because": _because(s, kb),
            }
            for s in d.steps
        ],
    }


def _scene_json(scene: Scene, kb: KnowledgeBase) -> dict[str, Any]:
    instances = []
    for inst in scene.instances.values():
        component = kb.components[inst.kind]
        instances.append(
            {
                "id": inst.id,
                "kind": inst.kind,
                "label": inst.label,
                "model3d": component.model3d,
                "tags": list(component.tags),
                "given": {
                    str(ref): _quantity_json(q) for ref, q in sorted(
                        inst.values.items(), key=lambda kv: str(kv[0])
                    )
                },
            }
        )
    relations = [
        {
            "kind": r.kind,
            "from": r.frm,
            "to": r.to,
            "given": {
                (f"{p}@{s}" if s else p): _quantity_json(q) for (p, s), q in r.values.items()
            },
        }
        for r in scene.relations
    ]
    return {"instances": instances, "relations": relations}


@dataclass
class SimSpec:
    data: dict[str, Any]

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.data, indent=indent, ensure_ascii=False)

    @property
    def beats(self) -> list[dict[str, Any]]:
        return self.data["timeline"]


def build_simspec(
    problem: Problem,
    derivations: list[Derivation],
    kb: KnowledgeBase,
    *,
    engine: str = "chain",
    trajectory=None,
) -> SimSpec:
    """Compile a resolved problem into a renderable, self-justifying spec."""
    if not derivations:
        raise ValueError("cannot build a SimSpec from zero derivations")

    best = derivations[0]
    timeline: list[dict[str, Any]] = []
    beat = 0

    def emit(**fields: Any) -> None:
        nonlocal beat
        beat += 1
        timeline.append({"beat": beat, **fields})

    # Components appear in the order the derivation first needs them -- the build-up sequence a
    # student watches, rather than an arbitrary scene dump.
    order: list[str] = []
    for step in best.steps:
        for iid in (step.ref.instance, *step.role_instances):
            if iid and iid not in order:
                order.append(iid)
    for iid in scene_order_remainder(problem.scene, order):
        order.append(iid)

    for iid in order:
        inst = problem.scene.instance(iid)
        component = kb.components[inst.kind]
        emit(
            kind="place",
            instance=iid,
            component=inst.kind,
            model3d=component.model3d,
            narrate=f"Place {inst.label}.",
            because={
                "kind": "scene",
                "detail": component.description.strip() or f"a {inst.label} is in the problem",
                "laws": list(component.laws),
            },
        )

    for rel in problem.scene.relations:
        if rel.frm in order and rel.to in order:
            emit(
                kind="relate",
                relation=rel.kind,
                **{"from": rel.frm, "to": rel.to},
                narrate=f"{rel.frm} is {rel.kind.replace('_', ' ')} {rel.to}.",
                because={"kind": "scene", "detail": "stated by the problem's geometry"},
            )

    for step in best.steps:
        emit(
            kind="given" if step.is_given else "resolve",
            instance=step.ref.instance,
            ref=str(step.ref),
            property=step.ref.prop,
            channel=CHANNEL.get(step.ref.prop),
            **_quantity_json(step.quantity),
            narrate=_narrate(step, kb),
            because=_because(step, kb),
        )

    emit(
        kind="answer",
        ref=str(problem.target),
        property=problem.target.prop,
        **_quantity_json(best.value),
        narrate=f"Answer: {format_quantity(best.value)}.",
        because={
            "kind": "summary",
            "laws": sorted(best.laws),
            "paths_found": len(derivations),
        },
    )

    values = [
        d.value.magnitude if d.value.is_vector else abs(float(d.value.value)) for d in derivations
    ]
    spread = (max(values) - min(values)) / max(max(values), 1e-30) if len(values) > 1 else 0.0

    return SimSpec(
        {
            "fieldforge": SPEC_VERSION,
            "problem": {
                "id": problem.id,
                "title": problem.title,
                "text": problem.text,
                "source": problem.source,
                "tags": list(problem.tags),
            },
            "target": str(problem.target),
            "answer": _quantity_json(best.value),
            "scene": _scene_json(problem.scene, kb),
            "assumptions": list(best.assumptions),
            "citations": list(best.citations),
            "trajectory": trajectory.to_json() if trajectory is not None else None,
            "checks": {
                "dimensions": "pass",
                "engines": [engine],
                "paths_found": len(derivations),
                "paths_agree": spread <= 1e-6,
                "path_spread": spread,
            },
            "timeline": timeline,
            "paths": [_path_json(d, kb) for d in derivations],
        }
    )


def scene_order_remainder(scene: Scene, already: list[str]) -> list[str]:
    """Instances the derivation never touched. They are still in the problem, so they still get
    placed — just last, and the spec makes clear nothing depended on them."""
    return [iid for iid in scene.instances if iid not in already]

"""Engine B: acausal system assembly — simultaneous equations, solved as a system.

Engine A chains formulas; nobody can chain a Wheatstone bridge, because no formula
isolates any unknown in it. Engine B assembles the system the way Modelica taught the
world to: components contribute *constitutive* equations (Ohm's law on each branch),
topology contributes *connection* equations (Kirchhoff's current law at each node —
currents leaving a node sum to zero), and the assembled linear system is solved whole.

Scene vocabulary (relations, as everywhere in FieldForge):

* a `circuit_node` instance is a point of one potential (`em.electric_potential`);
* a resistor/lamp declares `terminal_a` / `terminal_b` relations to its two nodes;
* a battery declares `positive_terminal` / `negative_terminal` relations to its nodes.
  The negative node is ground (0 V); the positive node is held at the emf.

v1 scope, honestly bounded: **one battery, resistive branches**. Multiple sources need
supernodes and reactive branches need Engine C's time stepping; both are refused, not
faked. The output is an ordinary `Derivation` — givens, node voltages (KCL), then branch
currents (Ohm) — so traces, SimSpecs and the XR storyboard consume it unchanged, and any
network Engine A can also reach must agree with it (the cross-check the audit runs).
"""

from __future__ import annotations

import sympy as sp

from .engine_chain import Derivation, Input, Step
from .exprs import parse
from .kb import Formula, KnowledgeBase
from .scene import Ref, Scene
from .units import Quantity
from .ontology import load_ontology  # noqa: F401  (re-exported for tests building scenes)

SYSTEM_CITE = "OpenStax College Physics 2e, 21.2-21.3 (CC BY)"


class SystemError(RuntimeError):
    """Raised when a scene is not a system Engine B can lawfully assemble."""


def _formula(key: str, solves_for: str, expr_text: str, law: str, note: str) -> Formula:
    return Formula(
        key=key,
        solves_for=solves_for,
        scope="self",
        bindings={},
        expr_text=expr_text,
        expr=parse("0"),
        law=law,
        assumes=("ideal_wires", "steady_state"),
        cite=SYSTEM_CITE,
        cost=1,
        note=note,
    )


KCL_FORMULA = _formula(
    "system.kcl_node_voltage", "em.electric_potential", "sum((V_node - V_other) / R_branch) = 0",
    "kirchhoff_current_law",
    "Assembled and solved as a simultaneous system by Engine B; no single formula isolates this node.",
)
OHM_FORMULA = _formula(
    "system.ohm_branch_current", "electric.current", "(V_a - V_b) / R",
    "ohms_law",
    "Branch current from the solved node potentials (Engine B).",
)


def _quantity(kb: KnowledgeBase, prop: str, value: float) -> Quantity:
    p = kb.ontology.prop(prop)
    return Quantity(value=value, dim=p.dim, rank=p.rank)


def solve_system(kb: KnowledgeBase, scene: Scene, target: Ref) -> Derivation | None:
    """Assemble and solve the nodal system; return a Derivation for `target`, or None
    when the scene is not a nodal circuit at all. Raises SystemError for circuits that
    are nodal but outside v1 scope (multi-source, reactive, disconnected)."""
    batteries = [i for i in scene.instances.values()
                 if any(r.kind in ("positive_terminal", "negative_terminal") and r.frm == i.id
                        for r in scene.relations)]
    branches = [i for i in scene.instances.values()
                if any(r.kind == "terminal_a" and r.frm == i.id for r in scene.relations)]
    nodes = [i for i in scene.instances.values() if i.kind == "circuit_node"]
    if not batteries and not branches:
        return None
    if len(batteries) != 1:
        raise SystemError(
            f"Engine B v1 assembles single-source networks; this scene has {len(batteries)} batteries "
            "(supernodes are future work)")
    battery = batteries[0]

    def node_of(instance: str, relation: str) -> str:
        for r in scene.relations:
            if r.frm == instance and r.kind == relation:
                return r.to
        raise SystemError(f"{instance}: missing `{relation}` relation to a circuit_node")

    ground = node_of(battery.id, "negative_terminal")
    positive = node_of(battery.id, "positive_terminal")
    emf_q = scene.given(Ref(battery.id, "electric.emf"))
    if emf_q is None:
        raise SystemError(f"{battery.id}: no emf stated")
    emf = float(emf_q.value)  # type: ignore[arg-type]

    branch_ends: dict[str, tuple[str, str, float]] = {}
    for branch in branches:
        if branch.kind not in ("resistor", "lamp"):
            raise SystemError(
                f"Engine B v1 is resistive; {branch.id} is a {branch.kind} (reactive branches need Engine C)")
        r_q = scene.given(Ref(branch.id, "electric.resistance"))
        if r_q is None:
            raise SystemError(f"{branch.id}: no resistance stated")
        resistance = float(r_q.value)  # type: ignore[arg-type]
        if resistance <= 0:
            raise SystemError(f"{branch.id}: resistance must be positive")
        branch_ends[branch.id] = (node_of(branch.id, "terminal_a"), node_of(branch.id, "terminal_b"), resistance)

    known: dict[str, float] = {ground: 0.0, positive: emf}
    unknown_nodes = [n.id for n in nodes if n.id not in known]
    symbols = {nid: sp.Symbol(f"V_{nid}") for nid in unknown_nodes}

    def potential(nid: str) -> sp.Expr:
        return sp.Float(known[nid]) if nid in known else symbols[nid]

    equations: list[sp.Expr] = []
    for nid in unknown_nodes:
        total = sp.Integer(0)
        incident = 0
        for a, b, resistance in branch_ends.values():
            if a == nid:
                total += (potential(nid) - potential(b)) / resistance
                incident += 1
            elif b == nid:
                total += (potential(nid) - potential(a)) / resistance
                incident += 1
        if incident == 0:
            raise SystemError(f"node {nid} is disconnected: no branch reaches it")
        equations.append(sp.Eq(total, 0))

    solution: dict[sp.Symbol, sp.Expr] = {}
    if equations:
        solved = sp.solve(equations, list(symbols.values()), dict=True)
        if not solved:
            raise SystemError("the assembled system has no solution (check for floating subnetworks)")
        solution = solved[0]
    voltages: dict[str, float] = dict(known)
    for nid in unknown_nodes:
        voltages[nid] = float(solution[symbols[nid]])

    currents: dict[str, float] = {}
    for bid, (a, b, resistance) in branch_ends.items():
        currents[bid] = (voltages[a] - voltages[b]) / resistance

    if target.instance in currents:
        target_value = currents[target.instance]
    elif target.instance in voltages and target.prop == "em.electric_potential":
        target_value = voltages[target.instance]
    elif target.instance == battery.id and target.prop == "electric.current":
        target_value = sum(
            abs(currents[bid]) for bid, (a, b, _) in branch_ends.items() if positive in (a, b))
    else:
        return None

    # --- trace: givens, node voltages (KCL), branch currents (Ohm), target last.
    steps: list[Step] = []
    seen: set[Ref] = set()

    def given_step(ref: Ref) -> None:
        if ref in seen:
            return
        q = scene.given(ref)
        if q is not None:
            steps.append(Step(ref=ref, quantity=q))
            seen.add(ref)

    given_step(Ref(battery.id, "electric.emf"))
    for bid in branch_ends:
        given_step(Ref(bid, "electric.resistance"))

    for nid in [n.id for n in nodes]:
        ref = Ref(nid, "em.electric_potential")
        steps.append(Step(
            ref=ref,
            quantity=_quantity(kb, "em.electric_potential", voltages[nid]),
            formula=KCL_FORMULA,
            inputs=tuple(
                Input(symbol=f"R_{bid}", ref=Ref(bid, "electric.resistance"), const=None,
                      quantity=_quantity(kb, "electric.resistance", r))
                for bid, (a, b, r) in branch_ends.items() if nid in (a, b)
            ),
        ))
        seen.add(ref)

    ordered_branches = sorted(branch_ends, key=lambda b: (b != target.instance, b))
    for bid in ordered_branches:
        a, b, resistance = branch_ends[bid]
        ref = Ref(bid, "electric.current")
        steps.append(Step(
            ref=ref,
            quantity=_quantity(kb, "electric.current", currents[bid]),
            formula=OHM_FORMULA,
            inputs=(
                Input(symbol="V_a", ref=Ref(a, "em.electric_potential"), const=None,
                      quantity=_quantity(kb, "em.electric_potential", voltages[a])),
                Input(symbol="V_b", ref=Ref(b, "em.electric_potential"), const=None,
                      quantity=_quantity(kb, "em.electric_potential", voltages[b])),
                Input(symbol="R", ref=Ref(bid, "electric.resistance"), const=None,
                      quantity=_quantity(kb, "electric.resistance", resistance)),
            ),
        ))
        seen.add(ref)

    if target.instance == battery.id and target.prop == "electric.current":
        steps.append(Step(
            ref=target,
            quantity=_quantity(kb, "electric.current", target_value),
            formula=KCL_FORMULA,
            inputs=tuple(
                Input(symbol=f"I_{bid}", ref=Ref(bid, "electric.current"), const=None,
                      quantity=_quantity(kb, "electric.current", currents[bid]))
                for bid, (a, b, _) in branch_ends.items() if positive in (a, b)
            ),
        ))

    # The derivation must *end* at the target (Derivation.value reads the last step).
    steps.sort(key=lambda s: (s.ref == target, str(s.ref) if s.ref != target else ""))
    head = [s for s in steps if s.ref != target]
    tail = [s for s in steps if s.ref == target]
    if not tail:
        return None
    return Derivation(target=target, steps=head + tail[-1:])

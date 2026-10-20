"""Scenes: instances, relations, and the problems posed over them.

A scene is the typed object an LLM is allowed to produce and the only thing the kernel will
compute over. Nothing here consults a model; a scene either validates or it is handed back.

Two ideas carry the weight:

* **Instances arrive stocked.** Placing an ``electron`` brings its charge and mass with it,
  because the component table declares them ``intrinsic`` with defaults. The problem statement
  only has to supply what is genuinely particular to it.
* **Relations carry properties.** A separation belongs to a *pair* of objects, not to either one.
  Making relations first-class property carriers is what lets Coulomb's law bind without a
  special case, and what lets ``inside_cavity_of`` express a precondition with no inputs at all.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .kb import STATES, KBError, KnowledgeBase
from .units import Quantity, parse_quantity


#: The component kind that carries the surroundings, and the id used when one is implied.
ENVIRONMENT_KIND = "environment"
IMPLICIT_ENVIRONMENT_ID = "env"


class SceneError(ValueError):
    """Raised when a scene is structurally invalid or contradicts the knowledge base."""


@dataclass(frozen=True, slots=True)
class Ref:
    """What the resolver resolves: one property of one instance, at one state."""

    instance: str
    prop: str
    state: str | None = None

    def __str__(self) -> str:
        return f"{self.instance}.{self.prop}" + (f"@{self.state}" if self.state else "")


@dataclass
class Instance:
    """A component placed in the world."""

    id: str
    kind: str
    values: dict[Ref, Quantity] = field(default_factory=dict)
    label: str = ""
    note: str = ""


@dataclass
class Relation:
    """A named link between two instances, which may itself carry properties."""

    kind: str
    frm: str
    to: str
    values: dict[tuple[str, str | None], Quantity] = field(default_factory=dict)

    def get(self, prop: str, state: str | None = None) -> Quantity | None:
        return self.values.get((prop, state), self.values.get((prop, None)))


@dataclass
class Scene:
    instances: dict[str, Instance] = field(default_factory=dict)
    relations: list[Relation] = field(default_factory=list)

    def instance(self, iid: str) -> Instance:
        try:
            return self.instances[iid]
        except KeyError:
            raise SceneError(f"no instance {iid!r} in scene") from None

    def given(self, ref: Ref) -> Quantity | None:
        """A value the problem supplied, or a component default.

        A value stated without an instant describes the *starting* (or steady) condition, so a
        lookup for ``initial`` may fall back to it. A lookup for ``final`` may NOT: the final value
        is what solving is for, and letting it default would quietly answer "how fast is it going
        when it arrives?" with the speed it started at.
        """
        inst = self.instances.get(ref.instance)
        if inst is None:
            return None
        if ref in inst.values:
            return inst.values[ref]
        if ref.state == "final":
            return None
        if ref.state is not None:
            return inst.values.get(Ref(ref.instance, ref.prop, None))
        return None

    def relations_into(self, iid: str, kind: str) -> list[Relation]:
        """Relations of ``kind`` whose *target* is ``iid`` — "something acts on me"."""
        return [r for r in self.relations if r.to == iid and r.kind == kind]

    def relations_from(self, iid: str, kind: str) -> list[Relation]:
        return [r for r in self.relations if r.frm == iid and r.kind == kind]

    def all_givens(self) -> list[tuple[Ref, Quantity]]:
        out: list[tuple[Ref, Quantity]] = []
        for inst in self.instances.values():
            out.extend(inst.values.items())
        return sorted(out, key=lambda kv: str(kv[0]))


@dataclass
class Expectation:
    """The known answer, for coverage checking."""

    value: float
    unit: str
    tol: float = 0.01
    note: str = ""


@dataclass
class Problem:
    """A corpus entry: prose, a scene, a target, and the answer it must reach."""

    id: str
    title: str
    text: str
    scene: Scene
    target: Ref
    source: str = ""
    expect: Expectation | None = None
    simulate: dict | None = None  # {instance, duration, samples} for Engine C
    tags: tuple[str, ...] = ()
    path: Path | None = None


# --------------------------------------------------------------------------- parsing


def _split_prop_state(key: str) -> tuple[str, str | None]:
    """``"kinematics.speed@initial"`` -> ``("kinematics.speed", "initial")``."""
    if "@" not in key:
        return key, None
    prop, state = key.rsplit("@", 1)
    if state not in STATES:
        raise SceneError(f"unknown state {state!r} in {key!r}; expected one of {sorted(STATES)}")
    return prop, state


def build_scene(spec: dict, kb: KnowledgeBase, *, where: str = "scene") -> Scene:
    """Build and structurally validate a scene against the knowledge base."""
    scene = Scene()

    for raw in spec.get("instances") or []:
        iid = str(raw.get("id") or "")
        if not iid:
            raise SceneError(f"{where}: an instance is missing its `id`")
        if iid in scene.instances:
            raise SceneError(f"{where}: duplicate instance id {iid!r}")
        kind = str(raw.get("kind") or "")
        try:
            component = kb.component(kind)
        except KBError as exc:
            raise SceneError(f"{where}:{iid}: {exc}") from None

        inst = Instance(
            id=iid,
            kind=kind,
            label=str(raw.get("label") or component.label),
            note=str(raw.get("note", "")),
        )

        # Components arrive stocked: intrinsic defaults first, so the problem can override
        # nothing it does not mention.
        for slot in component.slots.values():
            if slot.default is not None:
                inst.values[Ref(iid, slot.prop, None)] = parse_quantity(slot.default)

        for key, raw_value in (raw.get("set") or {}).items():
            prop, state = _split_prop_state(str(key))
            if prop not in kb.ontology.properties:
                raise SceneError(f"{where}:{iid}: unknown property {prop!r}")
            slot = component.slot(prop)
            if slot is None:
                carried = ", ".join(sorted(component.slots)) or "(none)"
                raise SceneError(
                    f"{where}:{iid}: a {kind!r} does not carry {prop!r}. It carries: {carried}"
                )
            if slot.role == "observable" and state != "initial":
                raise SceneError(
                    f"{where}:{iid}: {prop!r} is observable on a {kind!r} — it is produced by "
                    "solving, so setting it would be asserting the answer. An initial condition "
                    f"is a legitimate given: write `{prop}@initial` if that is what you mean."
                )
            quantity = parse_quantity(str(raw_value))
            prop_def = kb.ontology.prop(prop)
            if quantity.dim != prop_def.dim:
                raise SceneError(
                    f"{where}:{iid}: {prop!r} expects {prop_def.dim}, "
                    f"but {raw_value!r} is {quantity.dim}"
                )
            if quantity.rank != prop_def.rank:
                raise SceneError(
                    f"{where}:{iid}: {prop!r} is a {prop_def.rank}, but {raw_value!r} is a "
                    f"{quantity.rank}"
                )
            inst.values[Ref(iid, prop, state)] = quantity

        scene.instances[iid] = inst

    # Every scene has surroundings, whether or not the problem mentions them. Injecting an
    # implicit environment means a formula may always bind the medium -- so Coulomb's law can
    # divide by permittivity and weight can be derived -- while a problem that says nothing about
    # its surroundings still describes the idealised vacuum it meant. A declared environment wins.
    if ENVIRONMENT_KIND in kb.components and not any(
        inst.kind == ENVIRONMENT_KIND for inst in scene.instances.values()
    ):
        component = kb.component(ENVIRONMENT_KIND)
        implicit = Instance(
            id=IMPLICIT_ENVIRONMENT_ID,
            kind=ENVIRONMENT_KIND,
            label=component.label,
            note="implicit: no environment was declared, so the idealised defaults apply",
        )
        for slot in component.slots.values():
            if slot.default is not None:
                implicit.values[Ref(implicit.id, slot.prop, None)] = parse_quantity(slot.default)
        scene.instances[implicit.id] = implicit

    for raw in spec.get("relations") or []:
        kind = str(raw.get("kind") or "")
        frm, to = str(raw.get("from") or ""), str(raw.get("to") or "")
        if not kind or not frm or not to:
            raise SceneError(f"{where}: a relation needs `kind`, `from` and `to`")
        for end in (frm, to):
            if end not in scene.instances:
                raise SceneError(f"{where}: relation {kind!r} references unknown instance {end!r}")
        rel = Relation(kind=kind, frm=frm, to=to)
        for key, raw_value in (raw.get("set") or {}).items():
            prop, state = _split_prop_state(str(key))
            if prop not in kb.ontology.properties:
                raise SceneError(f"{where}: relation {kind!r} sets unknown property {prop!r}")
            quantity = parse_quantity(str(raw_value))
            prop_def = kb.ontology.prop(prop)
            if quantity.dim != prop_def.dim:
                raise SceneError(
                    f"{where}: relation {kind!r} property {prop!r} expects {prop_def.dim}, "
                    f"got {quantity.dim}"
                )
            rel.values[(prop, state)] = quantity
        scene.relations.append(rel)

    return scene


def load_problem(path: Path, kb: KnowledgeBase) -> Problem:
    """Read one corpus problem."""
    doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    where = path.name

    target_spec = doc.get("target") or {}
    if not target_spec:
        raise SceneError(f"{where}: missing `target`")

    scene = build_scene(doc.get("scene") or {}, kb, where=where)

    prop = str(target_spec.get("prop") or "")
    if prop not in kb.ontology.properties:
        raise SceneError(f"{where}: target names unknown property {prop!r}")
    iid = str(target_spec.get("instance") or "")
    if iid not in scene.instances:
        raise SceneError(f"{where}: target names unknown instance {iid!r}")
    state = target_spec.get("state")
    if state is not None and str(state) not in STATES:
        raise SceneError(f"{where}: target state must be one of {sorted(STATES)}")

    expect = None
    if doc.get("expect"):
        e = doc["expect"]
        expect = Expectation(
            value=float(e["value"]),
            unit=str(e.get("unit", "")),
            tol=float(e.get("tol", 0.01)),
            note=str(e.get("note", "")),
        )

    return Problem(
        id=str(doc.get("id") or path.stem),
        title=str(doc.get("title", "")),
        text=str(doc.get("text", "")).strip(),
        scene=scene,
        target=Ref(iid, prop, str(state) if state else None),
        source=str(doc.get("source", "")),
        expect=expect,
        simulate=(dict(doc["simulate"]) if doc.get("simulate") else None),
        tags=tuple(doc.get("tags") or ()),
        path=path,
    )


def load_corpus(root: Path, kb: KnowledgeBase) -> list[Problem]:
    paths = sorted(root.glob("*.yaml"))
    return [load_problem(p, kb) for p in paths]

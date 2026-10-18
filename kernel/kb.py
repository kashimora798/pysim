"""The knowledge base: components, formulas and laws.

Three tables, one linking discipline:

* a **component** declares the property keys it carries, each with a role — ``intrinsic`` (fixed
  by nature), ``settable`` (the problem assigns it), ``observable`` (emerges from solving);
* a **formula** declares the property key it ``solves_for`` and the bindings it ``needs``;
* a **law** declares the scope of properties it governs, and is what a trace step cites.

A formula never names a component. A component never names a formula. Both name only property
keys, so adding a chapter is adding rows, never changing the schema.

**Scopes.** A formula says where its bindings come from:

``self``   every binding belongs to the instance being solved for (``K = m*v**2/2``).
``pair``   the instance is related to another one by a named relation; bindings may come from
           ``self``, from the other end (the *role*), or from the relation itself (``rel``) —
           which is how a separation, an angle or an offset binds without being owned by either
           object.
``scene``  bindings come from a uniquely-identified instance elsewhere in the scene.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import sympy as sp
import yaml

from . import exprs
from .ontology import Ontology, load_ontology

KB_DIR = Path(__file__).parent / "data" / "kb"

SLOT_ROLES = {"intrinsic", "settable", "observable"}
SCOPES = {"self", "pair", "scene"}
STATES = {"initial", "final"}

#: A binding may ask for "whatever state the target was asked for". Without this a state-agnostic
#: formula answers a state-specific query from the wrong instant — a magnitude link would report
#: the speed at rest when asked for the speed at the end.
SAME_STATE = "same"
BINDING_STATES = STATES | {SAME_STATE}

#: `self` and `rel` are reserved binding sources; anything else names a role.
SELF = "self"
REL = "rel"


class KBError(ValueError):
    """Raised when a knowledge-base table is malformed."""


# --------------------------------------------------------------------------- components


@dataclass(frozen=True, slots=True)
class Slot:
    """One property a component carries."""

    prop: str
    role: str
    required: bool = False
    default: str | None = None
    note: str = ""


@dataclass(frozen=True, slots=True)
class Component:
    """A thing you can take off the shelf and place in a scene."""

    key: str
    label: str
    tags: tuple[str, ...]
    slots: dict[str, Slot]
    laws: tuple[str, ...]
    model3d: str | None
    description: str
    source: str

    def slot(self, prop: str) -> Slot | None:
        return self.slots.get(prop)

    def settable(self) -> list[Slot]:
        return [s for s in self.slots.values() if s.role == "settable"]


# --------------------------------------------------------------------------- formulas


@dataclass(frozen=True, slots=True)
class RoleSpec:
    """One other instance a formula reaches, and how it reaches it.

    A formula may declare several roles. Series and parallel reduction need exactly two
    (``R_eq = R_a + R_b``), and that binary shape is not a limitation but a match for how the
    physics is taught and how the hand interaction works: you wire two things together, then wire
    that combination to a third. The reduction tree mirrors the build order.

    Each role binds one of two ways:

    * ``via: <relation>`` — the instance related to the target by that relation.
    * ``scene: true`` — a unique instance of one of ``kinds`` anywhere in the scene. This is how a
      formula reaches the *environment*: Coulomb's law needs both the related charge and the
      scene's medium, so the two roles resolve differently inside one formula.
    """

    name: str
    via: str | None = None
    kinds: tuple[str, ...] = ()
    scene: bool = False


@dataclass(frozen=True, slots=True)
class Binding:
    """One symbol in a formula body, and where its value comes from.

    ``frm`` is ``self``, a role name, or ``rel.<role>`` for a property carried by the relation
    itself. A single-role formula may spell the last one as plain ``rel``.
    """

    symbol: str
    prop: str | None = None
    const: str | None = None
    frm: str = SELF
    state: str | None = None

    @property
    def is_const(self) -> bool:
        return self.const is not None

    @property
    def relation_role(self) -> str | None:
        """The role whose relation carries this binding, if it is a relation property."""
        if self.frm == REL:
            return REL
        if self.frm.startswith(REL + "."):
            return self.frm[len(REL) + 1 :]
        return None

    def describe(self) -> str:
        if self.is_const:
            return f"{self.symbol} = {self.const}"
        state = f"@{self.state}" if self.state else ""
        return f"{self.symbol} = {self.frm}.{self.prop}{state}"


@dataclass(frozen=True, slots=True)
class Formula:
    """A verified algebraic relation that produces one property."""

    key: str
    solves_for: str
    scope: str
    bindings: dict[str, Binding]
    expr_text: str
    expr: sp.Expr
    produces_state: str | None = None
    roles: dict[str, RoleSpec] = field(default_factory=dict)
    law: str | None = None
    assumes: tuple[str, ...] = ()
    cite: str = ""
    cost: int = 1
    note: str = ""
    source: str = ""

    def needs(self) -> list[Binding]:
        return [b for b in self.bindings.values() if not b.is_const]

    @property
    def role_names(self) -> tuple[str, ...]:
        return tuple(self.roles)

    @property
    def via_list(self) -> tuple[str, ...]:
        return tuple(r.via for r in self.roles.values() if r.via is not None)


# --------------------------------------------------------------------------- laws


@dataclass(frozen=True, slots=True)
class Law:
    key: str
    label: str
    statement: str
    governs: tuple[str, ...] = ()
    cite: str = ""
    source: str = ""


# --------------------------------------------------------------------------- the base


@dataclass
class KnowledgeBase:
    ontology: Ontology
    components: dict[str, Component] = field(default_factory=dict)
    formulas: dict[str, Formula] = field(default_factory=dict)
    laws: dict[str, Law] = field(default_factory=dict)
    #: property key -> formulas that can produce it. This index is the "collapse the universe"
    #: step: the resolver never scans all formulas.
    solvers: dict[str, list[Formula]] = field(default_factory=dict)

    def solvers_for(self, prop: str) -> list[Formula]:
        return self.solvers.get(prop, [])

    def components_tagged(self, tag: str) -> list[Component]:
        return [c for c in self.components.values() if tag in c.tags or tag == c.key]

    def component(self, key: str) -> Component:
        try:
            return self.components[key]
        except KeyError:
            raise KBError(f"unknown component kind {key!r}") from None


def load_kb(root: Path | None = None, ontology: Ontology | None = None) -> KnowledgeBase:
    """Load the whole knowledge base. Structural errors raise; physics errors are the
    validators' job (see :mod:`kernel.validate`)."""
    root = root or KB_DIR
    kb = KnowledgeBase(ontology=ontology or load_ontology())

    for path in sorted((root / "laws").glob("*.yaml")):
        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for key, spec in (doc.get("laws") or {}).items():
            if key in kb.laws:
                raise KBError(f"law {key!r} declared twice")
            kb.laws[key] = Law(
                key=key,
                label=str(spec.get("label", key)),
                statement=str(spec.get("statement", "")),
                governs=tuple(spec.get("governs") or ()),
                cite=str(spec.get("cite", "")),
                source=path.name,
            )

    for path in sorted((root / "components").glob("*.yaml")):
        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for key, spec in (doc.get("components") or {}).items():
            if key in kb.components:
                raise KBError(f"component {key!r} declared twice")
            kb.components[key] = _build_component(key, spec, path)

    for path in sorted((root / "formulas").glob("*.yaml")):
        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        entries = doc.get("formulas") or {}
        for key, spec in entries.items():
            if key in kb.formulas:
                raise KBError(f"formula {key!r} declared twice")
            kb.formulas[key] = _build_formula(key, spec, path)

    for f in kb.formulas.values():
        kb.solvers.setdefault(f.solves_for, []).append(f)
    for group in kb.solvers.values():
        group.sort(key=lambda f: (f.cost, f.key))

    return kb


def _build_component(key: str, spec: dict, path: Path) -> Component:
    where = f"{path.name}:{key}"
    if not isinstance(spec, dict):
        raise KBError(f"{where}: component body must be a mapping")

    slots: dict[str, Slot] = {}
    for prop, slot_spec in (spec.get("properties") or {}).items():
        if isinstance(slot_spec, str):
            slot_spec = {"role": slot_spec}
        if not isinstance(slot_spec, dict):
            raise KBError(f"{where}:{prop}: slot must be a role name or a mapping")
        role = str(slot_spec.get("role", "observable"))
        if role not in SLOT_ROLES:
            raise KBError(f"{where}:{prop}: role must be one of {sorted(SLOT_ROLES)}, got {role!r}")
        slots[prop] = Slot(
            prop=prop,
            role=role,
            required=bool(slot_spec.get("required", False)),
            default=(str(slot_spec["default"]) if slot_spec.get("default") is not None else None),
            note=str(slot_spec.get("note", "")),
        )

    return Component(
        key=key,
        label=str(spec.get("label", key.replace("_", " ").title())),
        tags=tuple(spec.get("tags") or ()),
        slots=slots,
        laws=tuple(spec.get("laws") or ()),
        model3d=(str(spec["model3d"]) if spec.get("model3d") else None),
        description=str(spec.get("description", "")),
        source=path.name,
    )


def _build_roles(key: str, spec: dict, scope: str, where: str) -> dict[str, RoleSpec]:
    """Read a formula's roles, accepting both the single-role and multi-role spellings.

    ``role:`` + ``via:`` + ``role_kinds:`` is sugar for a one-entry ``roles:`` map. Keeping both
    means the electrostatics tables, which only ever reach one other object, stay readable.
    """
    roles: dict[str, RoleSpec] = {}

    if spec.get("roles"):
        if spec.get("role") or spec.get("via"):
            raise KBError(f"{where}: use either `roles:` or `role:`/`via:`, not both")
        for name, rspec in spec["roles"].items():
            if not isinstance(rspec, dict):
                raise KBError(f"{where}: role {name!r} must be a mapping")
            if name in (SELF, REL):
                raise KBError(f"{where}: {name!r} is a reserved binding source, not a role name")
            is_scene = bool(rspec.get("scene", False))
            if is_scene == ("via" in rspec):
                raise KBError(
                    f"{where}: role {name!r} needs exactly one of `via: <relation>` or `scene: true`"
                )
            if is_scene and not rspec.get("kinds"):
                raise KBError(
                    f"{where}: scene role {name!r} needs `kinds` — without it any instance matches"
                )
            roles[str(name)] = RoleSpec(
                name=str(name),
                via=(str(rspec["via"]) if "via" in rspec else None),
                kinds=tuple(rspec.get("kinds") or ()),
                scene=is_scene,
            )
    elif spec.get("role") or spec.get("via"):
        if not spec.get("via"):
            raise KBError(f"{where}: scope 'pair' needs a `via` relation kind")
        if not spec.get("role"):
            raise KBError(f"{where}: scope 'pair' needs a `role` name for the other end")
        name = str(spec["role"])
        roles[name] = RoleSpec(
            name=name, via=str(spec["via"]), kinds=tuple(spec.get("role_kinds") or ())
        )

    if scope == "pair" and not roles:
        raise KBError(f"{where}: scope 'pair' needs at least one role (`roles:` or `role:`/`via:`)")
    if scope == "self" and roles:
        raise KBError(f"{where}: scope 'self' cannot declare roles")
    return roles


def _build_formula(key: str, spec: dict, path: Path) -> Formula:
    where = f"{path.name}:{key}"
    if not isinstance(spec, dict):
        raise KBError(f"{where}: formula body must be a mapping")

    for required in ("solves_for", "expr"):
        if required not in spec:
            raise KBError(f"{where}: missing required field {required!r}")

    scope = str(spec.get("scope", "self"))
    if scope not in SCOPES:
        raise KBError(f"{where}: scope must be one of {sorted(SCOPES)}, got {scope!r}")

    roles = _build_roles(key, spec, scope, where)
    relation_roles = {n for n, r in roles.items() if not r.scene}
    legal_sources = {SELF, *roles} | {f"{REL}.{n}" for n in relation_roles}
    if len(relation_roles) == 1:
        legal_sources.add(REL)  # unambiguous shorthand

    bindings: dict[str, Binding] = {}
    for symbol, b in (spec.get("bindings") or {}).items():
        if isinstance(b, str):
            b = {"prop": b}
        if not isinstance(b, dict):
            raise KBError(f"{where}:{symbol}: binding must be a property key or a mapping")
        if ("prop" in b) == ("const" in b):
            raise KBError(f"{where}:{symbol}: binding needs exactly one of `prop` or `const`")
        state = b.get("state")
        if state is not None and str(state) not in BINDING_STATES:
            raise KBError(
                f"{where}:{symbol}: state must be one of {sorted(BINDING_STATES)}, got {state!r}"
            )
        source = str(b.get("from", SELF))
        if "const" in b:
            source = SELF  # a constant has no owner; normalise so comparisons stay simple
        elif source not in legal_sources:
            raise KBError(
                f"{where}:{symbol}: binding source {source!r} is not valid here. "
                f"Allowed: {', '.join(sorted(legal_sources))}"
            )
        bindings[symbol] = Binding(
            symbol=symbol,
            prop=(str(b["prop"]) if "prop" in b else None),
            const=(str(b["const"]) if "const" in b else None),
            frm=source,
            state=(str(state) if state else None),
        )

    expr_text = str(spec["expr"])
    expr = exprs.parse(expr_text)

    declared = set(bindings)
    used = exprs.symbols_in(expr)
    if used - declared:
        raise KBError(
            f"{where}: expression uses undeclared symbol(s) {sorted(used - declared)}; "
            f"declared: {sorted(declared)}"
        )
    if declared - used:
        raise KBError(
            f"{where}: binding(s) {sorted(declared - used)} are declared but never used in "
            f"`{expr_text}` — an unused binding silently widens what the formula requires"
        )

    produces = spec.get("produces_state")
    if produces is not None and str(produces) not in STATES:
        raise KBError(f"{where}: produces_state must be one of {sorted(STATES)}")

    return Formula(
        key=key,
        solves_for=str(spec["solves_for"]),
        scope=scope,
        bindings=bindings,
        expr_text=expr_text,
        expr=expr,
        produces_state=(str(produces) if produces else None),
        roles=roles,
        law=(str(spec["law"]) if spec.get("law") else None),
        assumes=tuple(spec.get("assumes") or ()),
        cite=str(spec.get("cite", "")),
        cost=int(spec.get("cost", 1)),
        note=str(spec.get("note", "")),
        source=path.name,
    )

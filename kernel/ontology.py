"""The property registry — the hub every other table links through.

A *property* is a physical quantity with a canonical identity: a dotted key, a dimension vector,
a tensor rank, and a kind. Components declare which properties they carry; formulas declare which
properties they need and solve for. Neither ever names the other. That single discipline is what
keeps the graph hub-and-spoke instead of pairwise spaghetti, and it is why cross-topic chains
(field -> force -> trajectory) fall out without special cases.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

from .dims import Dim, parse_dim
from .exprs import SCALAR, VECTOR, Type
from .units import Quantity, parse_quantity

ONTOLOGY_DIR = Path(__file__).parent / "data" / "ontology"

RANKS = {SCALAR, VECTOR}
KINDS = {"lumped", "field", "pair"}


class OntologyError(ValueError):
    """Raised when the property registry is malformed."""


@dataclass(frozen=True, slots=True)
class Property:
    """A canonical physical quantity."""

    key: str
    symbol: str
    dim: Dim
    rank: str
    kind: str
    si_unit: str
    domain: str
    description: str = ""
    source: str = ""

    @property
    def type(self) -> Type:
        return Type(self.dim, self.rank)

    @property
    def is_vector(self) -> bool:
        return self.rank == VECTOR


@dataclass(frozen=True, slots=True)
class Constant:
    """A physical constant, treated as an ordinary dimensioned binding."""

    key: str
    symbol: str
    quantity: Quantity
    description: str = ""
    cite: str = ""

    @property
    def type(self) -> Type:
        return Type(self.quantity.dim, self.quantity.rank)


@dataclass(frozen=True, slots=True)
class Ontology:
    properties: dict[str, Property]
    constants: dict[str, Constant]

    def prop(self, key: str) -> Property:
        try:
            return self.properties[key]
        except KeyError:
            raise OntologyError(f"unknown property key {key!r}") from None

    def by_domain(self) -> dict[str, list[Property]]:
        out: dict[str, list[Property]] = {}
        for p in self.properties.values():
            out.setdefault(p.domain, []).append(p)
        for group in out.values():
            group.sort(key=lambda p: p.key)
        return out


def load_ontology(root: Path | None = None) -> Ontology:
    """Load every property and constant table under ``ontology/``."""
    root = root or ONTOLOGY_DIR
    properties: dict[str, Property] = {}

    prop_dir = root / "properties"
    files = sorted(prop_dir.glob("*.yaml"))
    if not files:
        raise OntologyError(f"no property tables found in {prop_dir}")

    for path in files:
        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        domain = doc.get("domain") or path.stem
        for key, spec in (doc.get("properties") or {}).items():
            if key in properties:
                raise OntologyError(
                    f"property {key!r} declared twice "
                    f"({properties[key].source} and {path.name})"
                )
            properties[key] = _build_property(key, spec, domain, path)

    constants = _load_constants(root / "constants.yaml")
    return Ontology(properties=properties, constants=constants)


def _build_property(key: str, spec: dict, domain: str, path: Path) -> Property:
    where = f"{path.name}:{key}"
    if not isinstance(spec, dict):
        raise OntologyError(f"{where}: property body must be a mapping")

    missing = {"dim", "rank", "kind"} - set(spec)
    if missing:
        raise OntologyError(f"{where}: missing required field(s) {sorted(missing)}")

    rank = str(spec["rank"])
    if rank not in RANKS:
        raise OntologyError(f"{where}: rank must be one of {sorted(RANKS)}, got {rank!r}")

    kind = str(spec["kind"])
    if kind not in KINDS:
        raise OntologyError(f"{where}: kind must be one of {sorted(KINDS)}, got {kind!r}")

    return Property(
        key=key,
        symbol=str(spec.get("symbol", key.rsplit(".", 1)[-1])),
        dim=parse_dim(spec["dim"]),
        rank=rank,
        kind=kind,
        si_unit=str(spec.get("si_unit", "")),
        domain=str(spec.get("domain", domain)),
        description=str(spec.get("description", "")),
        source=path.name,
    )


def _load_constants(path: Path) -> dict[str, Constant]:
    if not path.exists():
        return {}
    doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    out: dict[str, Constant] = {}
    for key, spec in (doc.get("constants") or {}).items():
        out[key] = Constant(
            key=key,
            symbol=str(spec.get("symbol", key)),
            quantity=parse_quantity(str(spec["value"])),
            description=str(spec.get("description", "")),
            cite=str(spec.get("cite", "")),
        )
    return out

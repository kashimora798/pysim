"""Quantity parsing and SI normalisation.

The knowledge base and the corpus are authored in human units (``"30 cm"``, ``"2 uC"``,
``"[0, 0, -9.81] m/s^2"``). Everything is normalised to SI base units on the way in, so the
resolver only ever arithmetics in SI and the dimension vector is always meaningful.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from fractions import Fraction

from .dims import Dim, DimensionError

Vector = tuple[float, float, float]


class UnitError(ValueError):
    """Raised when a unit string cannot be read."""


# --------------------------------------------------------------------------- unit tables

# symbol -> (dimension, multiplier to SI base units)
UNITS: dict[str, tuple[Dim, float]] = {
    # SI base
    "kg": (Dim.of(kg=1), 1.0),
    "m": (Dim.of(m=1), 1.0),
    "s": (Dim.of(s=1), 1.0),
    "A": (Dim.of(A=1), 1.0),
    "K": (Dim.of(K=1), 1.0),
    "mol": (Dim.of(mol=1), 1.0),
    "cd": (Dim.of(cd=1), 1.0),
    # mass
    "g": (Dim.of(kg=1), 1e-3),
    "t": (Dim.of(kg=1), 1e3),
    "u": (Dim.of(kg=1), 1.66053906892e-27),
    # length
    "angstrom": (Dim.of(m=1), 1e-10),
    "in": (Dim.of(m=1), 0.0254),
    "ft": (Dim.of(m=1), 0.3048),
    # time
    "min": (Dim.of(s=1), 60.0),
    "h": (Dim.of(s=1), 3600.0),
    "day": (Dim.of(s=1), 86400.0),
    # derived mechanical
    "N": (Dim.of(kg=1, m=1, s=-2), 1.0),
    "J": (Dim.of(kg=1, m=2, s=-2), 1.0),
    "W": (Dim.of(kg=1, m=2, s=-3), 1.0),
    "Pa": (Dim.of(kg=1, m=-1, s=-2), 1.0),
    "Hz": (Dim.of(s=-1), 1.0),
    "L": (Dim.of(m=3), 1e-3),
    "eV": (Dim.of(kg=1, m=2, s=-2), 1.602176634e-19),
    # derived electromagnetic
    "C": (Dim.of(s=1, A=1), 1.0),
    "V": (Dim.of(kg=1, m=2, s=-3, A=-1), 1.0),
    "F": (Dim.of(kg=-1, m=-2, s=4, A=2), 1.0),
    "ohm": (Dim.of(kg=1, m=2, s=-3, A=-2), 1.0),
    "Ω": (Dim.of(kg=1, m=2, s=-3, A=-2), 1.0),
    "S": (Dim.of(kg=-1, m=-2, s=3, A=2), 1.0),
    "T": (Dim.of(kg=1, s=-2, A=-1), 1.0),
    "Wb": (Dim.of(kg=1, m=2, s=-2, A=-1), 1.0),
    "H": (Dim.of(kg=1, m=2, s=-2, A=-2), 1.0),
    # angle (dimensionless, but the multiplier matters)
    "rad": (Dim.dimensionless(), 1.0),
    "sr": (Dim.dimensionless(), 1.0),
    "deg": (Dim.dimensionless(), math.pi / 180.0),
    "°": (Dim.dimensionless(), math.pi / 180.0),
    "percent": (Dim.dimensionless(), 0.01),
}

PREFIXES: dict[str, float] = {
    "y": 1e-24, "z": 1e-21, "a": 1e-18, "f": 1e-15, "p": 1e-12,
    "n": 1e-9, "u": 1e-6, "µ": 1e-6, "μ": 1e-6, "m": 1e-3,
    "c": 1e-2, "d": 1e-1, "da": 1e1, "h": 1e2, "k": 1e3,
    "M": 1e6, "G": 1e9, "T": 1e12, "P": 1e15, "E": 1e18,
    "Z": 1e21, "Y": 1e24,
}

# Units that must never be prefixed, because doing so collides with a real unit.
# ("min" would otherwise read as milli-inch; "cd" as centi-day.)
_NO_PREFIX = {"min", "day", "deg", "rad", "sr", "in", "h", "t", "percent", "angstrom"}

_FACTOR_RE = re.compile(r"^([A-Za-zΩµμ°]+)(?:\s*\*\*\s*|\s*\^\s*)?(-?\d+(?:/\d+)?)?$")
_SCALAR_RE = re.compile(r"^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(.*?)\s*$")
_VECTOR_RE = re.compile(r"^\s*[\[(]\s*(.*?)\s*[\])]\s*(.*?)\s*$")


def _resolve_symbol(sym: str) -> tuple[Dim, float]:
    """Resolve one unit symbol, trying an exact match before prefix decomposition.

    Exact-first is what keeps ``T`` tesla rather than tera, and ``min`` minutes rather than
    milli-inches.
    """
    if sym in UNITS:
        return UNITS[sym]
    # Try two-character prefixes ("da") before one-character ones.
    for plen in (2, 1):
        if len(sym) <= plen:
            continue
        prefix, rest = sym[:plen], sym[plen:]
        if prefix in PREFIXES and rest in UNITS and rest not in _NO_PREFIX:
            dim, mult = UNITS[rest]
            return dim, mult * PREFIXES[prefix]
    raise UnitError(f"unknown unit symbol {sym!r}")


def parse_unit(text: str) -> tuple[Dim, float]:
    """Parse a unit expression such as ``"m/s^2"``, ``"kg*m/s**2"`` or ``"V/m"``."""
    # Normalise `**` to `^` *before* splitting on `*`, or "s**2" would split into "s" and "2".
    s = text.strip().replace("·", "*").replace("⋅", "*").replace("**", "^")
    if s in ("", "1", "-"):
        return Dim.dimensionless(), 1.0

    dim = Dim.dimensionless()
    mult = 1.0
    for seg_index, segment in enumerate(s.split("/")):
        sign = 1 if seg_index == 0 else -1
        segment = segment.strip()
        if not segment:
            raise UnitError(f"empty segment in unit {text!r}")
        for factor in re.split(r"[*\s]+", segment):
            if not factor:
                continue
            match = _FACTOR_RE.match(factor)
            if not match:
                raise UnitError(f"cannot read unit factor {factor!r} in {text!r}")
            sym, exp_text = match.group(1), match.group(2)
            exp = Fraction(exp_text) if exp_text else Fraction(1)
            exp *= sign
            fdim, fmult = _resolve_symbol(sym)
            dim = dim * (fdim**exp)
            mult *= fmult ** float(exp)
    return dim, mult


# --------------------------------------------------------------------------- quantity


@dataclass(frozen=True, slots=True)
class Quantity:
    """A value in SI base units, with its dimension and tensor rank."""

    value: float | Vector
    dim: Dim
    rank: str = "scalar"  # "scalar" | "vector"
    text: str | None = None  # as originally authored, for display

    @property
    def is_vector(self) -> bool:
        return self.rank == "vector"

    @property
    def magnitude(self) -> float:
        if self.is_vector:
            vx, vy, vz = self.value  # type: ignore[misc]
            return math.sqrt(vx * vx + vy * vy + vz * vz)
        return abs(float(self.value))  # type: ignore[arg-type]

    def check_dim(self, expected: Dim, what: str) -> None:
        if self.dim != expected:
            raise DimensionError(f"{what}: expected {expected}, got {self.dim}")

    def __str__(self) -> str:
        return format_quantity(self)


def parse_quantity(text: str) -> Quantity:
    """Parse ``"100 V"``, ``"2 uC"``, ``"[0, 0, -9.81] m/s^2"`` or a bare number."""
    raw = str(text).strip()

    vec = _VECTOR_RE.match(raw)
    if vec:
        body, unit_text = vec.group(1), vec.group(2)
        parts = [p for p in re.split(r"[,\s]+", body.strip()) if p]
        if len(parts) != 3:
            raise UnitError(f"a vector needs exactly 3 components, got {len(parts)} in {raw!r}")
        try:
            comps = tuple(float(p) for p in parts)
        except ValueError as exc:
            raise UnitError(f"non-numeric vector component in {raw!r}") from exc
        dim, mult = parse_unit(unit_text)
        return Quantity(
            value=(comps[0] * mult, comps[1] * mult, comps[2] * mult),
            dim=dim,
            rank="vector",
            text=raw,
        )

    scalar = _SCALAR_RE.match(raw)
    if not scalar:
        raise UnitError(f"cannot read quantity {raw!r}")
    number, unit_text = scalar.group(1), scalar.group(2)
    dim, mult = parse_unit(unit_text)
    return Quantity(value=float(number) * mult, dim=dim, rank="scalar", text=raw)


# --------------------------------------------------------------------------- display

#: Preferred display unit per dimension, so output reads as physics rather than base SI.
_DISPLAY: dict[Dim, str] = {
    Dim.of(kg=1, m=1, s=-2): "N",
    Dim.of(kg=1, m=2, s=-2): "J",
    Dim.of(kg=1, m=2, s=-3): "W",
    Dim.of(s=1, A=1): "C",
    Dim.of(kg=1, m=2, s=-3, A=-1): "V",
    Dim.of(kg=1, m=1, s=-3, A=-1): "V/m",
    Dim.of(kg=1, s=-2, A=-1): "T",
    Dim.of(kg=-1, m=-2, s=4, A=2): "F",
    Dim.of(kg=1, m=2, s=-3, A=-2): "Ω",
    Dim.of(m=1, s=-1): "m/s",
    Dim.of(m=1, s=-2): "m/s²",
    Dim.of(kg=1, m=1, s=-1): "kg·m/s",
    Dim.of(m=-1, s=1, A=1): "C/m",
    Dim.of(m=-2, s=1, A=1): "C/m²",
    Dim.of(m=-3, s=1, A=1): "C/m³",
    Dim.of(kg=1, m=3, s=-3, A=-1): "V·m",
    Dim.of(m=2): "m²",
    Dim.of(m=3): "m³",
}


def display_unit(dim: Dim) -> str:
    if dim in _DISPLAY:
        return _DISPLAY[dim]
    return str(dim) if not dim.is_dimensionless else ""


def _fmt_number(x: float, sig: int = 4) -> str:
    if x == 0:
        return "0"
    if not math.isfinite(x):
        return str(x)
    exponent = math.floor(math.log10(abs(x)))
    if -4 <= exponent < 6:
        text = f"{x:.{max(0, sig - 1 - exponent)}f}"
        return text.rstrip("0").rstrip(".") if "." in text else text
    return f"{x:.{sig - 1}e}".replace("e+0", "e").replace("e-0", "e-").replace("e+", "e")


def format_quantity(q: Quantity, sig: int = 4) -> str:
    unit = display_unit(q.dim)
    if q.is_vector:
        body = ", ".join(_fmt_number(c, sig) for c in q.value)  # type: ignore[union-attr]
        return f"[{body}] {unit}".strip()
    return f"{_fmt_number(float(q.value), sig)} {unit}".strip()  # type: ignore[arg-type]

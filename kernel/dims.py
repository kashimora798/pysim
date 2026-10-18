"""Seven-dimensional SI dimension vectors.

Every physical quantity in FieldForge carries one of these. Two quantities may be added only
if their dimension vectors are identical; this is the type system the knowledge base compiles
against, and it is what makes "lawful, not plausible" a mechanical property rather than a claim.

Exponents are Fractions so that `sqrt` is representable (2*ke*q*V/m under a root has
half-integer exponents mid-expression even when the result is integral).
"""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction

#: SI base dimensions, in canonical order. The order is load-bearing: it fixes the tuple layout.
BASE: tuple[str, ...] = ("kg", "m", "s", "A", "K", "mol", "cd")

_SUPERSCRIPT = str.maketrans("-0123456789", "⁻⁰¹²³⁴⁵⁶⁷⁸⁹")


class DimensionError(ValueError):
    """Raised when an expression is not dimensionally homogeneous."""


@dataclass(frozen=True, slots=True)
class Dim:
    """An immutable exponent vector over :data:`BASE`."""

    e: tuple[Fraction, ...]

    def __post_init__(self) -> None:
        if len(self.e) != len(BASE):
            raise ValueError(f"dimension vector needs {len(BASE)} exponents, got {len(self.e)}")

    # ------------------------------------------------------------------ construction

    @staticmethod
    def of(**exponents: int | float | Fraction) -> Dim:
        """``Dim.of(kg=1, m=1, s=-2)`` -> the dimension of force."""
        unknown = set(exponents) - set(BASE)
        if unknown:
            raise ValueError(f"not SI base dimensions: {sorted(unknown)}")
        return Dim(tuple(Fraction(exponents.get(b, 0)) for b in BASE))

    @staticmethod
    def dimensionless() -> Dim:
        return _DIMENSIONLESS

    @staticmethod
    def from_mapping(m: dict[str, int | float | Fraction]) -> Dim:
        return Dim.of(**m)

    # ------------------------------------------------------------------ algebra

    def __mul__(self, other: Dim) -> Dim:
        return Dim(tuple(a + b for a, b in zip(self.e, other.e)))

    def __truediv__(self, other: Dim) -> Dim:
        return Dim(tuple(a - b for a, b in zip(self.e, other.e)))

    def __pow__(self, n: int | float | Fraction) -> Dim:
        f = Fraction(n)
        return Dim(tuple(a * f for a in self.e))

    # ------------------------------------------------------------------ queries

    @property
    def is_dimensionless(self) -> bool:
        return all(x == 0 for x in self.e)

    def as_mapping(self) -> dict[str, str]:
        return {b: str(x) for b, x in zip(BASE, self.e) if x != 0}

    # ------------------------------------------------------------------ display

    def __str__(self) -> str:
        if self.is_dimensionless:
            return "1"
        parts = []
        for base, exp in zip(BASE, self.e):
            if exp == 0:
                continue
            if exp == 1:
                parts.append(base)
            else:
                shown = str(exp) if exp.denominator != 1 else str(exp.numerator)
                parts.append(base + shown.translate(_SUPERSCRIPT))
        return "·".join(parts)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Dim({self})"


_DIMENSIONLESS = Dim(tuple(Fraction(0) for _ in BASE))

# Named dimensions used across the knowledge base. Kept here so the YAML tables can spell a
# dimension either as a base-exponent mapping or as one of these names.
NAMED: dict[str, Dim] = {
    "dimensionless": _DIMENSIONLESS,
    "length": Dim.of(m=1),
    "area": Dim.of(m=2),
    "volume": Dim.of(m=3),
    "time": Dim.of(s=1),
    "mass": Dim.of(kg=1),
    "velocity": Dim.of(m=1, s=-1),
    "acceleration": Dim.of(m=1, s=-2),
    "force": Dim.of(kg=1, m=1, s=-2),
    "energy": Dim.of(kg=1, m=2, s=-2),
    "power": Dim.of(kg=1, m=2, s=-3),
    "momentum": Dim.of(kg=1, m=1, s=-1),
    "pressure": Dim.of(kg=1, m=-1, s=-2),
    "charge": Dim.of(s=1, A=1),
    "current": Dim.of(A=1),
    "voltage": Dim.of(kg=1, m=2, s=-3, A=-1),
    "electric_field": Dim.of(kg=1, m=1, s=-3, A=-1),
    "magnetic_field": Dim.of(kg=1, s=-2, A=-1),
    "capacitance": Dim.of(kg=-1, m=-2, s=4, A=2),
    "resistance": Dim.of(kg=1, m=2, s=-3, A=-2),
    "permittivity": Dim.of(kg=-1, m=-3, s=4, A=2),
    "permeability": Dim.of(kg=1, m=1, s=-2, A=-2),
    "charge_density_linear": Dim.of(m=-1, s=1, A=1),
    "charge_density_area": Dim.of(m=-2, s=1, A=1),
    "charge_density_volume": Dim.of(m=-3, s=1, A=1),
    "electric_flux": Dim.of(kg=1, m=3, s=-3, A=-1),
}


def parse_dim(spec: str | dict[str, int | float | Fraction]) -> Dim:
    """Read a dimension from a knowledge-base entry.

    Accepts a name from :data:`NAMED` (``"force"``) or an explicit exponent mapping
    (``{"kg": 1, "m": 1, "s": -2}``).
    """
    if isinstance(spec, str):
        try:
            return NAMED[spec]
        except KeyError:
            raise DimensionError(
                f"unknown named dimension {spec!r}; "
                f"use an exponent mapping or one of: {', '.join(sorted(NAMED))}"
            ) from None
    return Dim.from_mapping(spec)

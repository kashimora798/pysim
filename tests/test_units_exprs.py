"""Units, dimensions and expression typing."""

from __future__ import annotations

import math

import pytest
from hypothesis import given
from hypothesis import strategies as st

from kernel.dims import BASE, Dim, DimensionError, parse_dim
from kernel.exprs import SCALAR, VECTOR, ExprError, RankError, Type, evaluate, infer, parse
from kernel.units import UnitError, format_quantity, parse_quantity, parse_unit


# --------------------------------------------------------------------------- dimensions


def test_dim_algebra():
    force = Dim.of(kg=1, m=1, s=-2)
    assert force * Dim.of(m=1) == Dim.of(kg=1, m=2, s=-2)  # work
    assert force / Dim.of(m=2) == Dim.of(kg=1, m=-1, s=-2)  # pressure
    assert (Dim.of(m=2) ** 0.5) == Dim.of(m=1)
    assert Dim.dimensionless().is_dimensionless


def test_named_dimensions_are_self_consistent():
    """Every named dimension must match the SI unit it is conventionally written in."""
    pairs = [
        ("force", "N"), ("energy", "J"), ("power", "W"), ("charge", "C"),
        ("voltage", "V"), ("electric_field", "V/m"), ("magnetic_field", "T"),
        ("capacitance", "F"), ("resistance", "ohm"), ("permittivity", "F/m"),
        ("velocity", "m/s"), ("acceleration", "m/s^2"), ("momentum", "kg*m/s"),
    ]
    for name, unit in pairs:
        assert parse_dim(name) == parse_unit(unit)[0], f"{name} != {unit}"


def test_unknown_named_dimension_is_rejected():
    with pytest.raises(DimensionError):
        parse_dim("flux_capacitance")


# --------------------------------------------------------------------------- units


@pytest.mark.parametrize(
    "text,si_value",
    [
        ("100 V", 100.0),
        ("2 uC", 2e-6),
        ("30 cm", 0.30),
        ("1.0 nC", 1e-9),
        ("2 mT", 2e-3),
        ("10 min", 600.0),
        ("3 MeV", 3 * 1.602176634e-13),
        ("5 kV/m", 5000.0),
        ("9.8", 9.8),
    ],
)
def test_quantity_normalises_to_si(text, si_value):
    assert parse_quantity(text).value == pytest.approx(si_value, rel=1e-12)


def test_exact_unit_match_beats_prefix_decomposition():
    """`T` is tesla not tera, `min` is minutes not milli-inches, `cd` is candela not centi-day."""
    assert parse_unit("T")[0] == Dim.of(kg=1, s=-2, A=-1)
    assert parse_quantity("1 min").value == 60.0
    assert parse_unit("cd")[0] == Dim.of(cd=1)


def test_equivalent_unit_spellings_agree():
    assert parse_unit("N/C")[0] == parse_unit("V/m")[0]
    assert parse_unit("J/C")[0] == parse_unit("V")[0]
    assert parse_unit("N*m")[0] == parse_unit("J")[0]
    assert parse_unit("kg*m/s**2")[0] == parse_unit("kg*m/s^2")[0] == parse_unit("N")[0]


def test_vector_quantity():
    q = parse_quantity("[0, 3, 4] m/s")
    assert q.rank == VECTOR
    assert q.magnitude == pytest.approx(5.0)
    assert q.dim == Dim.of(m=1, s=-1)


def test_vector_needs_three_components():
    with pytest.raises(UnitError):
        parse_quantity("[1, 2] m")


def test_unknown_unit_is_rejected():
    with pytest.raises(UnitError):
        parse_quantity("5 smoots")


# --------------------------------------------------------------------------- expressions

CHARGE = Type(Dim.of(s=1, A=1), SCALAR)
LENGTH = Type(Dim.of(m=1), SCALAR)
MASS = Type(Dim.of(kg=1), SCALAR)
K_E = Type(Dim.of(kg=1, m=3, s=-4, A=-2), SCALAR)
E_FIELD = Dim.of(kg=1, m=1, s=-3, A=-1)
E_VEC = Type(E_FIELD, VECTOR)
V_VEC = Type(Dim.of(m=1, s=-1), VECTOR)
B_VEC = Type(Dim.of(kg=1, s=-2, A=-1), VECTOR)


def test_coulomb_field_has_field_dimension():
    t = infer(parse("k_e * Q / r**2"), {"k_e": K_E, "Q": CHARGE, "r": LENGTH})
    assert t.dim == E_FIELD
    assert t.rank == SCALAR


def test_inverse_cube_slip_does_not_have_field_dimension():
    """The failure the research document names: a 1/r^3 implementation of Coulomb's law.

    Inference alone does not raise -- the expression is internally consistent. It is caught by
    comparing the *inferred* dimension against the *declared* one, which is what
    `check_dims_and_rank` does and what `test_validators.py` asserts.
    """
    t = infer(parse("k_e * Q / r**3"), {"k_e": K_E, "Q": CHARGE, "r": LENGTH})
    assert t.dim != E_FIELD


def test_vector_force_from_field():
    t = infer(parse("q * E"), {"q": CHARGE, "E": E_VEC})
    assert t.dim == Dim.of(kg=1, m=1, s=-2)
    assert t.rank == VECTOR


def test_cross_product_force():
    t = infer(parse("q * cross(v, B)"), {"q": CHARGE, "v": V_VEC, "B": B_VEC})
    assert t.dim == Dim.of(kg=1, m=1, s=-2)
    assert t.rank == VECTOR


@pytest.mark.parametrize(
    "src,env,exc",
    [
        ("Q + r", {"Q": CHARGE, "r": LENGTH}, DimensionError),
        ("sin(r)", {"r": LENGTH}, DimensionError),
        ("q**r", {"q": CHARGE, "r": LENGTH}, DimensionError),
        ("v * B", {"v": V_VEC, "B": B_VEC}, RankError),
        ("mag(q)", {"q": CHARGE}, RankError),
        ("dot(q, q)", {"q": CHARGE}, RankError),
        ("E**2", {"E": E_VEC}, RankError),
    ],
)
def test_incoherent_expressions_are_rejected(src, env, exc):
    with pytest.raises(exc):
        infer(parse(src), env)


@pytest.mark.parametrize(
    "src",
    [
        '__import__("os").system("echo pwned")',
        "Integral(q, r)",
        "Derivative(q, r)",
        "open('/etc/passwd').read()",
        # The standard Python sandbox escape: reaches live classes by attribute access alone,
        # without needing __builtins__ at all.
        "().__class__.__bases__",
        "().__class__.__bases__[0].__subclasses__()",
        "(1).__class__",
    ],
)
def test_parser_refuses_non_physics(src):
    with pytest.raises(ExprError):
        parse(src)


def test_parse_always_returns_a_sympy_expression():
    """Everything downstream walks a SymPy tree, so the parser must never hand back a tuple."""
    import sympy as sp

    for src in ("k_e * Q / r**2", "sqrt(2*a*s)", "0", "mag(E)"):
        assert isinstance(parse(src), sp.Expr)


def test_sympy_namespace_does_not_shadow_physics_symbols():
    """`Q`, `E`, `S`, `N` and `I` are ordinary physics symbols, not sympy singletons."""
    for name in ("Q", "E", "S", "N", "I", "O", "beta", "gamma"):
        expr = parse(name)
        assert expr.free_symbols, f"{name} was captured by sympy instead of becoming a symbol"


# --------------------------------------------------------------------------- evaluation


def test_evaluation_matches_hand_calculation():
    env = {
        "k_e": parse_quantity("8.9875517873681764e9 N*m^2/C^2"),
        "Q": parse_quantity("2.0 uC"),
        "r": parse_quantity("30 cm"),
    }
    got = evaluate(parse("k_e * Q / r**2"), env)
    assert got.value == pytest.approx(8.9875517873681764e9 * 2e-6 / 0.09, rel=1e-12)
    assert got.dim == E_FIELD


def test_cross_product_evaluates_right_handed():
    env = {
        "v": parse_quantity("[1, 0, 0] m/s"),
        "B": parse_quantity("[0, 1, 0] T"),
    }
    got = evaluate(parse("cross(v, B)"), env)
    assert got.value == pytest.approx((0.0, 0.0, 1.0))  # x cross y = +z


def test_division_by_zero_surfaces():
    env = {"Q": parse_quantity("1 C"), "r": parse_quantity("0 m")}
    with pytest.raises(ZeroDivisionError):
        evaluate(parse("Q / r"), env)


def test_substitution_does_not_corrupt_function_names():
    """`s` must not eat the `s` in `sqrt`, and a substituted `m/s` must not be re-substituted."""
    from kernel.exprs import substituted_text

    env = {
        "u": parse_quantity("0 m/s"),
        "a": parse_quantity("7.5 m/s^2"),
        "s": parse_quantity("2 cm"),
    }
    text = substituted_text(parse("sqrt(u**2 + 2*a*s)"), env)
    assert "sqrt(" in text
    assert "qrt" not in text.replace("sqrt", "")
    assert text.count("0 m/s") == 1


# --------------------------------------------------------------------------- properties


@given(
    st.lists(st.integers(min_value=-3, max_value=3), min_size=7, max_size=7),
    st.lists(st.integers(min_value=-3, max_value=3), min_size=7, max_size=7),
)
def test_dim_multiplication_is_exponent_addition(a, b):
    da = Dim.of(**dict(zip(BASE, a)))
    db = Dim.of(**dict(zip(BASE, b)))
    assert (da * db) == Dim.of(**{k: x + y for k, x, y in zip(BASE, a, b)})
    assert (da * db) / db == da


@given(st.floats(min_value=1e-12, max_value=1e12, allow_nan=False, allow_infinity=False))
def test_formatting_round_trips_through_parsing(value):
    q = parse_quantity(f"{value} N")
    reparsed = parse_quantity(format_quantity(q, sig=12))
    assert reparsed.dim == q.dim
    assert reparsed.value == pytest.approx(q.value, rel=1e-9)

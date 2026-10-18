"""Safe expression parsing, with dimension and rank inference.

Formula bodies in the knowledge base are small algebraic expressions over property symbols.
This module does three things with them:

* **parse** them into SymPy trees through a whitelist, so a knowledge-base file cannot execute
  arbitrary code;
* **infer** a dimension vector and tensor rank for the result, which is how validators 2 and 3
  reject bad physics at authoring time rather than at solve time;
* **evaluate** them over concrete quantities, with real vector semantics.

The inference walk and the evaluation walk deliberately mirror each other: if a construct is
dimensionally meaningful it is also computable, and vice versa.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from fractions import Fraction

import sympy as sp
from sympy.parsing.sympy_parser import (
    auto_number,
    auto_symbol,
    parse_expr,
    repeated_decimals,
)

from .dims import Dim, DimensionError
from .units import Quantity, Vector

SCALAR = "scalar"
VECTOR = "vector"


class RankError(ValueError):
    """Raised when scalars and vectors are combined incoherently."""


class ExprError(ValueError):
    """Raised when an expression cannot be parsed or contains a disallowed construct."""


# --------------------------------------------------------------------------- vector algebra


class mag(sp.Function):
    """Magnitude of a vector."""

    nargs = 1


class dot(sp.Function):
    """Scalar product of two vectors."""

    nargs = 2


class cross(sp.Function):
    """Vector product of two vectors."""

    nargs = 2


class unit(sp.Function):
    """Unit vector along a vector (dimensionless)."""

    nargs = 1


#: Transcendental functions: dimensionless scalar in, dimensionless scalar out.
_TRANSCENDENTAL = {
    sp.sin, sp.cos, sp.tan, sp.asin, sp.acos, sp.atan,
    sp.sinh, sp.cosh, sp.tanh, sp.exp, sp.log,
}

_ALLOWED_FUNCS = _TRANSCENDENTAL | {sp.Abs, sp.sign, sp.atan2, mag, dot, cross, unit}

#: The parser runs against a sealed namespace. SymPy's default globals are `from sympy import *`,
#: which would shadow ordinary physics symbols — `Q` becomes sympy's assumptions object, `S` the
#: singleton registry, `E` Euler's number, `N` numeric evaluation. Sealing the namespace keeps
#: `Q` meaning charge, and dropping `__builtins__` means a knowledge-base file cannot reach
#: `__import__` even if the whitelist walk were bypassed.
_PARSE_GLOBALS: dict[str, object] = {
    "__builtins__": {},
    "Symbol": sp.Symbol,
    "Integer": sp.Integer,
    "Float": sp.Float,
    "Rational": sp.Rational,
}

#: Only the transformations we actually need: name -> Symbol, literal -> Number. Notably *not*
#: `factorial_notation` or `lambda_notation`.
_TRANSFORMATIONS = (auto_symbol, repeated_decimals, auto_number)

_PARSE_LOCALS: dict[str, object] = {
    "mag": mag, "dot": dot, "cross": cross, "unit": unit,
    "sqrt": sp.sqrt, "Abs": sp.Abs, "abs": sp.Abs, "sign": sp.sign,
    "sin": sp.sin, "cos": sp.cos, "tan": sp.tan,
    "asin": sp.asin, "acos": sp.acos, "atan": sp.atan, "atan2": sp.atan2,
    "sinh": sp.sinh, "cosh": sp.cosh, "tanh": sp.tanh,
    "exp": sp.exp, "log": sp.log, "ln": sp.log,
    "pi": sp.pi,
}


def parse(text: str) -> sp.Expr:
    """Parse a formula body, rejecting anything outside the whitelist."""
    # Reject dunder access before parsing. SymPy's parser ultimately `eval`s the transformed
    # source, and emptying `__builtins__` is not sufficient on its own: the expression
    # `().__class__.__bases__[0].__subclasses__()` reaches 436 live classes through attribute
    # access alone, which is the standard way out of a Python sandbox. Formula bodies never need
    # an attribute, so banning the dunder closes the route at its root rather than one input at
    # a time.
    if "__" in text:
        raise ExprError(f"expression {text!r} contains '__'; attribute access is not allowed")

    try:
        expr = parse_expr(
            text,
            local_dict=dict(_PARSE_LOCALS),
            global_dict=dict(_PARSE_GLOBALS),
            transformations=_TRANSFORMATIONS,
            evaluate=True,
        )
    except Exception as exc:  # sympy raises a wide variety here
        raise ExprError(f"cannot parse expression {text!r}: {exc}") from exc

    # The parser can hand back a plain Python object (a tuple, a list) rather than an expression.
    # Everything downstream assumes a SymPy tree, so insist on one here.
    if not isinstance(expr, sp.Expr):
        raise ExprError(
            f"expression {text!r} did not parse to a physics expression "
            f"(got {type(expr).__name__})"
        )

    for node in sp.preorder_traversal(expr):
        if isinstance(node, sp.Function) and node.func not in _ALLOWED_FUNCS:
            raise ExprError(
                f"function {node.func.__name__!r} is not allowed in {text!r}; "
                f"allowed: {', '.join(sorted(f.__name__ for f in _ALLOWED_FUNCS))}"
            )
        if isinstance(node, (sp.Derivative, sp.Integral, sp.Sum, sp.Product)):
            raise ExprError(f"{type(node).__name__} is not allowed in {text!r}")
    return expr


def symbols_in(expr: sp.Expr) -> set[str]:
    return {s.name for s in expr.free_symbols}


# --------------------------------------------------------------------------- inference


@dataclass(frozen=True, slots=True)
class Type:
    """The static type of a sub-expression: a dimension plus a tensor rank."""

    dim: Dim
    rank: str = SCALAR

    def __str__(self) -> str:
        return f"{self.dim}" if self.rank == SCALAR else f"{self.dim} (vector)"


_DIMENSIONLESS_SCALAR = Type(Dim.dimensionless(), SCALAR)


def infer(expr: sp.Expr, env: dict[str, Type], *, where: str = "expression") -> Type:
    """Infer the dimension and rank of ``expr``, raising on any inconsistency.

    ``env`` maps symbol name to its declared :class:`Type`.
    """
    return _infer(expr, env, where)


def _infer(e: sp.Basic, env: dict[str, Type], where: str) -> Type:
    if isinstance(e, sp.Symbol):
        try:
            return env[e.name]
        except KeyError:
            raise ExprError(f"{where}: symbol {e.name!r} has no declared binding") from None

    if isinstance(e, (sp.Integer, sp.Float, sp.Rational, sp.NumberSymbol)) or e.is_number:
        return _DIMENSIONLESS_SCALAR

    if isinstance(e, sp.Add):
        types = [_infer(a, env, where) for a in e.args]
        first = types[0]
        for other in types[1:]:
            if other.dim != first.dim:
                raise DimensionError(
                    f"{where}: cannot add {first.dim} to {other.dim} in `{e}` "
                    "— every term of a sum must share one dimension"
                )
            if other.rank != first.rank:
                raise RankError(
                    f"{where}: cannot add a {first.rank} to a {other.rank} in `{e}`"
                )
        return first

    if isinstance(e, sp.Mul):
        dim = Dim.dimensionless()
        rank = SCALAR
        for arg in e.args:
            t = _infer(arg, env, where)
            dim = dim * t.dim
            if t.rank == VECTOR:
                if rank == VECTOR:
                    raise RankError(
                        f"{where}: `{e}` multiplies two vectors directly; "
                        "say dot(a, b) or cross(a, b) so the intent is explicit"
                    )
                rank = VECTOR
        return Type(dim, rank)

    if isinstance(e, sp.Pow):
        base, exponent = e.args
        et = _infer(exponent, env, where)
        if not et.dim.is_dimensionless:
            raise DimensionError(f"{where}: exponent `{exponent}` must be dimensionless, got {et.dim}")
        if not exponent.is_number:
            raise ExprError(
                f"{where}: exponent `{exponent}` must be a constant — "
                "a symbolic exponent has no static dimension"
            )
        bt = _infer(base, env, where)
        if bt.rank == VECTOR:
            raise RankError(f"{where}: cannot raise a vector to a power in `{e}`; use mag() first")
        try:
            power = Fraction(sp.Rational(exponent).p, sp.Rational(exponent).q)
        except Exception as exc:
            raise ExprError(f"{where}: exponent `{exponent}` is not rational") from exc
        return Type(bt.dim**power, SCALAR)

    if isinstance(e, sp.Function):
        return _infer_function(e, env, where)

    raise ExprError(f"{where}: unsupported construct `{e}` ({type(e).__name__})")


def _infer_function(e: sp.Function, env: dict[str, Type], where: str) -> Type:
    func = e.func
    args = [_infer(a, env, where) for a in e.args]

    if func is mag:
        if args[0].rank != VECTOR:
            raise RankError(f"{where}: mag() takes a vector, got a scalar in `{e}`")
        return Type(args[0].dim, SCALAR)

    if func is unit:
        if args[0].rank != VECTOR:
            raise RankError(f"{where}: unit() takes a vector, got a scalar in `{e}`")
        return Type(Dim.dimensionless(), VECTOR)

    if func in (dot, cross):
        for i, a in enumerate(args):
            if a.rank != VECTOR:
                raise RankError(f"{where}: {func.__name__}() argument {i + 1} must be a vector in `{e}`")
        return Type(args[0].dim * args[1].dim, SCALAR if func is dot else VECTOR)

    if func in (sp.Abs, sp.sign):
        if args[0].rank == VECTOR:
            raise RankError(f"{where}: {func.__name__}() takes a scalar; use mag() for a vector")
        return Type(args[0].dim if func is sp.Abs else Dim.dimensionless(), SCALAR)

    if func is sp.atan2:
        if args[0].dim != args[1].dim:
            raise DimensionError(
                f"{where}: atan2 arguments must share a dimension, got {args[0].dim} and {args[1].dim}"
            )
        return _DIMENSIONLESS_SCALAR

    if func in _TRANSCENDENTAL:
        a = args[0]
        if a.rank == VECTOR:
            raise RankError(f"{where}: {func.__name__}() takes a scalar in `{e}`")
        if not a.dim.is_dimensionless:
            raise DimensionError(
                f"{where}: {func.__name__}() needs a dimensionless argument, got {a.dim} in `{e}`"
            )
        return _DIMENSIONLESS_SCALAR

    raise ExprError(f"{where}: function {func.__name__!r} is not allowed")


# --------------------------------------------------------------------------- evaluation

_Val = float | Vector


def evaluate(expr: sp.Expr, env: dict[str, Quantity], *, where: str = "expression") -> Quantity:
    """Evaluate ``expr`` over concrete quantities, honouring vector semantics."""
    typed = {name: Type(q.dim, q.rank) for name, q in env.items()}
    result_type = infer(expr, typed, where=where)
    value = _eval(expr, env, where)
    return Quantity(value=value, dim=result_type.dim, rank=result_type.rank)


def _is_vec(v: _Val) -> bool:
    return isinstance(v, tuple)


def _eval(e: sp.Basic, env: dict[str, Quantity], where: str) -> _Val:
    if isinstance(e, sp.Symbol):
        return env[e.name].value

    if e.is_number:
        return float(e.evalf())

    if isinstance(e, sp.Add):
        total: _Val = 0.0
        for arg in e.args:
            v = _eval(arg, env, where)
            if _is_vec(v):
                total = v if total == 0.0 else tuple(a + b for a, b in zip(total, v))  # type: ignore[arg-type]
            else:
                total = total + v  # type: ignore[operator]
        return total

    if isinstance(e, sp.Mul):
        scale = 1.0
        vec: Vector | None = None
        for arg in e.args:
            v = _eval(arg, env, where)
            if _is_vec(v):
                vec = v  # inference already guaranteed there is at most one
            else:
                scale *= float(v)  # type: ignore[arg-type]
        if vec is None:
            return scale
        return (vec[0] * scale, vec[1] * scale, vec[2] * scale)

    if isinstance(e, sp.Pow):
        base = float(_eval(e.args[0], env, where))  # type: ignore[arg-type]
        exponent = float(e.args[1].evalf())
        if base < 0 and not float(exponent).is_integer():
            raise ExprError(f"{where}: `{e}` takes a fractional power of a negative number")
        if base == 0 and exponent < 0:
            raise ZeroDivisionError(f"{where}: division by zero in `{e}`")
        return float(base**exponent)

    if isinstance(e, sp.Function):
        return _eval_function(e, env, where)

    raise ExprError(f"{where}: cannot evaluate `{e}`")


def _eval_function(e: sp.Function, env: dict[str, Quantity], where: str) -> _Val:
    func = e.func
    vals = [_eval(a, env, where) for a in e.args]

    if func is mag:
        v = vals[0]
        return math.sqrt(sum(c * c for c in v))  # type: ignore[union-attr]

    if func is unit:
        v = vals[0]
        n = math.sqrt(sum(c * c for c in v))  # type: ignore[union-attr]
        if n == 0:
            raise ZeroDivisionError(f"{where}: unit() of a zero vector in `{e}`")
        return (v[0] / n, v[1] / n, v[2] / n)  # type: ignore[index]

    if func is dot:
        a, b = vals
        return sum(x * y for x, y in zip(a, b))  # type: ignore[call-overload]

    if func is cross:
        a, b = vals  # type: ignore[misc]
        return (
            a[1] * b[2] - a[2] * b[1],  # type: ignore[index]
            a[2] * b[0] - a[0] * b[2],  # type: ignore[index]
            a[0] * b[1] - a[1] * b[0],  # type: ignore[index]
        )

    scalars = [float(v) for v in vals]  # type: ignore[arg-type]
    if func is sp.Abs:
        return abs(scalars[0])
    if func is sp.sign:
        return float(math.copysign(1.0, scalars[0])) if scalars[0] != 0 else 0.0
    if func is sp.atan2:
        return math.atan2(scalars[0], scalars[1])

    simple = {
        sp.sin: math.sin, sp.cos: math.cos, sp.tan: math.tan,
        sp.asin: math.asin, sp.acos: math.acos, sp.atan: math.atan,
        sp.sinh: math.sinh, sp.cosh: math.cosh, sp.tanh: math.tanh,
        sp.exp: math.exp, sp.log: math.log,
    }
    if func in simple:
        return simple[func](scalars[0])

    raise ExprError(f"{where}: cannot evaluate function {func.__name__!r}")


def substituted_text(expr: sp.Expr, env: dict[str, Quantity]) -> str:
    """Render the expression with each symbol replaced by its value, for the trace.

    One regex pass with word boundaries, deliberately. Replacing symbol by symbol with
    ``str.replace`` corrupts the output twice over: ``s`` would eat the ``s`` in ``sqrt``, and a
    substituted ``0 m/s`` would then have its own ``s`` replaced in turn. ``re.sub`` never
    rescans its own replacements, so one pass is both correct and simpler.
    """
    import re

    from .units import format_quantity

    def swap(match: re.Match[str]) -> str:
        name = match.group(0)
        q = env.get(name)
        return f"({format_quantity(q)})" if q is not None else name

    return re.sub(r"[A-Za-z_]\w*", swap, str(expr))


# --------------------------------------------------------------------------- serialisation

#: SymPy function -> the short tag used in the exported AST.
_FN_TAG: dict[object, str] = {
    sp.sqrt: "sqrt", sp.Abs: "abs", sp.sign: "sign", sp.atan2: "atan2",
    sp.sin: "sin", sp.cos: "cos", sp.tan: "tan",
    sp.asin: "asin", sp.acos: "acos", sp.atan: "atan",
    sp.sinh: "sinh", sp.cosh: "cosh", sp.tanh: "tanh",
    sp.exp: "exp", sp.log: "log",
    mag: "mag", dot: "dot", cross: "cross", unit: "unit",
}


def to_ast(expr: sp.Expr, *, where: str = "expression") -> dict:
    """Serialise a verified expression to a small JSON tree.

    This is what lets the physics reach a browser without shipping SymPy. Dimensional analysis is
    an *authoring-time* concern: by the time an expression is exported, the validators have already
    proved it homogeneous and rank-correct, so the runtime only has to arithmetic. A ~120-line
    evaluator on the other side is enough.

    Node shapes::

        {"k": "num", "v": 2.0}
        {"k": "sym", "n": "k_e"}
        {"k": "add", "a": [...]}            # subtraction is add + mul by -1
        {"k": "mul", "a": [...]}            # division is mul by pow(x, -1)
        {"k": "pow", "b": <node>, "e": 2.0}
        {"k": "fn",  "f": "sqrt", "a": [...]}
    """
    if isinstance(expr, sp.Symbol):
        return {"k": "sym", "n": expr.name}

    if expr.is_number:
        return {"k": "num", "v": float(expr.evalf())}

    if isinstance(expr, sp.Add):
        return {"k": "add", "a": [to_ast(a, where=where) for a in expr.args]}

    if isinstance(expr, sp.Mul):
        return {"k": "mul", "a": [to_ast(a, where=where) for a in expr.args]}

    if isinstance(expr, sp.Pow):
        base, exponent = expr.args
        if not exponent.is_number:
            raise ExprError(f"{where}: cannot export a symbolic exponent in `{expr}`")
        return {"k": "pow", "b": to_ast(base, where=where), "e": float(exponent.evalf())}

    if isinstance(expr, sp.Function):
        tag = _FN_TAG.get(expr.func)
        if tag is None:
            raise ExprError(f"{where}: cannot export function {expr.func.__name__!r}")
        return {"k": "fn", "f": tag, "a": [to_ast(a, where=where) for a in expr.args]}

    raise ExprError(f"{where}: cannot export `{expr}` ({type(expr).__name__})")

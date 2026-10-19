"""The mathematical toolkit — explicit, callable, dimension-checked.

The user asked for the mathematics to be available as *tools*: named functions
that any engine can call the moment it needs them, rather than machinery buried
inside a solver. This module is that toolkit.

Three properties matter and are enforced here:

**Every tool is explicit.** Nothing integrates or differentiates by accident.
A caller names the tool, passes the expression and the variable, and gets back
a labelled result. That is what makes a trace able to say "and here we
integrated", which is the difference between a derivation and a number.

**Every tool is dimension-aware where it can be.** Differentiation divides by
the variable's dimension, integration multiplies by it, a gradient's components
carry the field's dimension per length. Where a tool cannot know the dimensions
— a purely numerical quadrature over an expression in SI — it says so and
returns a plain float, leaving the caller to tag it.

**No tool invents physics.** These are the operations of calculus and linear
algebra, only. They know nothing about charge, fields or circuits; the
knowledge base decides what is lawful and this module does the arithmetic.

The registry at the bottom (:data:`TOOLS`) exists so that a solver, a CLI, or
an external agent can enumerate and *call* the toolkit by name.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

import sympy as sp

from .dims import Dim, DimensionError
from .exprs import SCALAR, VECTOR, ExprError, Type, infer, parse
from .units import Quantity

# --------------------------------------------------------------------------- results


@dataclass(frozen=True)
class SymbolicResult:
    """A symbolic answer, with the dimension the calculus says it must carry."""

    expression: sp.Expr
    dim: Dim
    rank: str = SCALAR
    tool: str = ""
    note: str = ""

    @property
    def text(self) -> str:
        return str(self.expression)

    def __str__(self) -> str:
        return f"{self.expression}   [{self.dim}{', vector' if self.rank == VECTOR else ''}]"


@dataclass(frozen=True)
class Tool:
    """One entry in the registry: what it is called, what it does, how to call it."""

    name: str
    summary: str
    signature: str
    returns: str
    fn: Callable[..., Any]
    #: True when the tool carries dimensions through, False when it works on plain numbers.
    dimension_aware: bool = True


TOOLS: dict[str, Tool] = {}


def tool(name: str, signature: str, returns: str, *, dimension_aware: bool = True) -> Callable:
    """Register a function in the toolkit."""

    def wrap(fn: Callable) -> Callable:
        TOOLS[name] = Tool(
            name=name,
            summary=(fn.__doc__ or "").strip().splitlines()[0] if fn.__doc__ else name,
            signature=signature,
            returns=returns,
            fn=fn,
            dimension_aware=dimension_aware,
        )
        return fn

    return wrap


def call(name: str, *args: Any, **kwargs: Any) -> Any:
    """Call a tool by name. This is the whole point of the registry."""
    if name not in TOOLS:
        raise KeyError(f"no such tool {name!r}; available: {', '.join(sorted(TOOLS))}")
    return TOOLS[name].fn(*args, **kwargs)


def describe() -> list[dict[str, str]]:
    """The toolkit as data, so a UI or an agent can list what is available."""
    return [
        {
            "name": entry.name,
            "summary": entry.summary,
            "signature": entry.signature,
            "returns": entry.returns,
            "dimension_aware": str(entry.dimension_aware),
        }
        for entry in TOOLS.values()
    ]


# --------------------------------------------------------------------------- helpers


def _environment(dims: dict[str, Dim], ranks: dict[str, str] | None = None) -> dict[str, Type]:
    ranks = ranks or {}
    return {name: Type(dim, ranks.get(name, SCALAR)) for name, dim in dims.items()}


def _check(expression: sp.Expr, dims: dict[str, Dim], where: str) -> Type:
    """Infer a type, so a tool never returns a dimension it cannot justify."""
    return infer(expression, _environment(dims), where=where)


def _symbols_of(expr: sp.Expr) -> set[str]:
    return {s.name for s in expr.free_symbols}


# --------------------------------------------------------------------------- calculus


@tool("differentiate", "differentiate(expr, var, order=1, dims=...)", "SymbolicResult", dimension_aware=True)
def differentiate(
    expr: str | sp.Expr,
    var: str,
    order: int = 1,
    *,
    dims: dict[str, Dim] | None = None,
    require_var: bool = True,
) -> SymbolicResult:
    """Differentiate an expression with respect to a variable, any number of times.

    The result's dimension is the expression's divided by the variable's, once
    per order: differentiating a position by time gives a velocity, and the type
    system says so whether or not anybody remembers to.

    A variable that does not appear gives a zero derivative, which is a real
    answer and not an error — but only when the caller asks for it. A solver
    that mistypes a variable name should hear about it; a gradient taking a
    partial with respect to an axis the field ignores should not.
    """
    if order < 1:
        raise ValueError("order must be at least 1")
    parsed = expr if isinstance(expr, sp.Expr) else parse(expr)
    symbol = sp.Symbol(var)

    result_dim: Dim | None = None
    rank = SCALAR
    if dims:
        if var not in dims:
            raise ValueError(f"differentiate: no dimension declared for {var!r}")
        declared = _check(parsed, dims, "differentiate")
        rank = declared.rank
        result_dim = declared.dim
        for _ in range(order):
            result_dim = result_dim / dims[var]

    if symbol not in parsed.free_symbols:
        if require_var:
            raise ExprError(f"differentiate: {var!r} does not appear in `{parsed}`")
        return SymbolicResult(
            expression=sp.Integer(0),
            dim=result_dim or Dim.dimensionless(),
            rank=rank,
            tool="differentiate",
            note=f"d^{order}/d{var}^{order} (identically zero)",
        )

    derivative = sp.diff(parsed, symbol, order)
    return SymbolicResult(
        expression=derivative,
        dim=result_dim or Dim.dimensionless(),
        rank=rank,
        tool="differentiate",
        note=f"d^{order}/d{var}^{order}",
    )


@tool("integrate", "integrate(expr, var, dims=...)", "SymbolicResult")
def integrate(
    expr: str | sp.Expr,
    var: str,
    *,
    dims: dict[str, Dim] | None = None,
) -> SymbolicResult:
    """Integrate an expression with respect to a variable, symbolically.

    The result's dimension is the expression's times the variable's: integrating
    a velocity over time gives a displacement.
    """
    parsed = expr if isinstance(expr, sp.Expr) else parse(expr)
    symbol = sp.Symbol(var)
    if symbol not in parsed.free_symbols:
        raise ExprError(f"integrate: {var!r} does not appear in `{parsed}`")

    result_dim: Dim | None = None
    rank = SCALAR
    if dims:
        if var not in dims:
            raise ValueError(f"integrate: no dimension declared for {var!r}")
        declared = _check(parsed, dims, "integrate")
        rank = declared.rank
        result_dim = declared.dim * dims[var]

    antiderivative = sp.integrate(parsed, symbol)
    if isinstance(antiderivative, sp.Integral):
        raise ExprError(
            f"integrate: `{parsed}` has no elementary antiderivative in {var!r}; "
            "use quadrature for a numerical answer"
        )
    return SymbolicResult(
        expression=antiderivative,
        dim=result_dim or Dim.dimensionless(),
        rank=rank,
        tool="integrate",
        note=f"∫ d{var}",
    )


@tool("integrate_definite", "integrate_definite(expr, var, lower, upper, dims=...)", "Quantity")
def integrate_definite(
    expr: str | sp.Expr,
    var: str,
    lower: float | Quantity,
    upper: float | Quantity,
    *,
    dims: dict[str, Dim] | None = None,
) -> Quantity | float:
    """Evaluate ``∫ expr dvar`` between two bounds, and tag the result with its dimension.

    Bounds may be plain numbers (already in SI) or :class:`Quantity` values, in
    which case their dimension must match the variable's — a length cannot be
    integrated over a time.
    """
    indefinite = integrate(expr, var, dims=dims)
    symbol = sp.Symbol(var)

    def as_float(bound: float | Quantity) -> float:
        if isinstance(bound, Quantity):
            if dims and var in dims and bound.dim != dims[var]:
                raise DimensionError(
                    f"integrate_definite: bound {bound} has dimension {bound.dim}, "
                    f"but {var!r} is {dims[var]}"
                )
            return float(bound.value)  # type: ignore[arg-type]
        return float(bound)

    low, high = as_float(lower), as_float(upper)
    value = float(sp.integrate(indefinite.expression, (symbol, low, high)).evalf())
    if dims is None:
        return value
    return Quantity(value=value, dim=indefinite.dim, rank=indefinite.rank)


@tool("limit", "limit(expr, var, point, direction='+-')", "sympy expression")
def limit(expr: str | sp.Expr, var: str, point: float | str, direction: str = "+-") -> sp.Expr:
    """Take a limit: what an expression approaches as a variable approaches a point."""
    parsed = expr if isinstance(expr, sp.Expr) else parse(expr)
    target = sp.sympify(point) if isinstance(point, str) else sp.Float(point)
    return sp.limit(parsed, sp.Symbol(var), target, dir=direction)


@tool("series", "series(expr, var, point=0, order=4)", "sympy expression")
def series(expr: str | sp.Expr, var: str, point: float = 0.0, order: int = 4) -> sp.Expr:
    """Expand an expression as a Taylor series about a point.

    The small-angle and small-signal approximations every chapter leans on are
    this tool, applied once and then stated as an assumption.
    """
    parsed = expr if isinstance(expr, sp.Expr) else parse(expr)
    return sp.series(parsed, sp.Symbol(var), sp.Float(point), order + 1).removeO()


# --------------------------------------------------------------------------- vector calculus


def _components(field: tuple[str, str, str] | tuple[sp.Expr, sp.Expr, sp.Expr]):
    if len(field) != 3:
        raise ValueError("a vector field needs exactly three components")
    return tuple(
        component if isinstance(component, sp.Expr) else parse(component) for component in field
    )


@tool("gradient", "gradient(scalar, vars=('x','y','z'), dims=...)", "tuple of SymbolicResult")
def gradient(
    scalar: str | sp.Expr,
    vars: tuple[str, str, str] = ("x", "y", "z"),
    *,
    dims: dict[str, Dim] | None = None,
) -> tuple[SymbolicResult, SymbolicResult, SymbolicResult]:
    """∇f — the three partial derivatives of a scalar field.

    Each component carries the field's dimension divided by a length, which is
    why a potential in volts differentiates into a field in volts per metre.
    """
    return tuple(differentiate(scalar, axis, dims=dims, require_var=False) for axis in vars)


@tool("divergence", "divergence(field, vars=('x','y','z'), dims=...)", "SymbolicResult")
def divergence(
    field: tuple[str, str, str],
    vars: tuple[str, str, str] = ("x", "y", "z"),
    *,
    dims: dict[str, Dim] | None = None,
) -> SymbolicResult:
    """∇·F — how much a vector field spreads out of a point. Gauss's law is this."""
    components = _components(field)
    total: sp.Expr | None = None
    result_dim: Dim | None = None
    for component, axis in zip(components, vars):
        part = differentiate(component, axis, dims=dims, require_var=False)
        total = part.expression if total is None else total + part.expression
        result_dim = part.dim if result_dim is None else result_dim
    assert total is not None
    return SymbolicResult(
        expression=sp.simplify(total), dim=result_dim or Dim.dimensionless(), tool="divergence",
        note="∇·F",
    )


@tool("curl", "curl(field, vars=('x','y','z'), dims=...)", "tuple of SymbolicResult")
def curl(
    field: tuple[str, str, str],
    vars: tuple[str, str, str] = ("x", "y", "z"),
    *,
    dims: dict[str, Dim] | None = None,
) -> tuple[SymbolicResult, SymbolicResult, SymbolicResult]:
    """∇×F — how much a vector field swirls. Faraday's law is this."""
    fx, fy, fz = _components(field)
    x, y, z = vars
    parts = (
        (differentiate(fz, y, dims=dims, require_var=False), differentiate(fy, z, dims=dims, require_var=False)),
        (differentiate(fx, z, dims=dims, require_var=False), differentiate(fz, x, dims=dims, require_var=False)),
        (differentiate(fy, x, dims=dims, require_var=False), differentiate(fx, y, dims=dims, require_var=False)),
    )
    out = []
    for first, second in parts:
        out.append(
            SymbolicResult(
                expression=sp.simplify(first.expression - second.expression),
                dim=first.dim,
                tool="curl",
                note="∇×F",
            )
        )
    return tuple(out)  # type: ignore[return-value]


@tool("laplacian", "laplacian(scalar, vars=('x','y','z'), dims=...)", "SymbolicResult")
def laplacian(
    scalar: str | sp.Expr,
    vars: tuple[str, str, str] = ("x", "y", "z"),
    *,
    dims: dict[str, Dim] | None = None,
) -> SymbolicResult:
    """∇²f — the sum of the second partials. Laplace's and Poisson's equations are this."""
    total: sp.Expr | None = None
    result_dim: Dim | None = None
    for axis in vars:
        second = differentiate(scalar, axis, order=2, dims=dims, require_var=False)
        total = second.expression if total is None else total + second.expression
        result_dim = second.dim
    assert total is not None
    return SymbolicResult(
        expression=sp.simplify(total), dim=result_dim or Dim.dimensionless(), tool="laplacian",
        note="∇²f",
    )


# --------------------------------------------------------------------------- algebra


@tool("rearrange", "rearrange(equation, symbol)", "sympy expression")
def rearrange(equation: str | sp.Expr, symbol: str) -> sp.Expr:
    """Solve one equation for one symbol — the rearrangement every formula row is.

    Given ``V - I*R`` this returns ``V/R`` for ``I``. Cheap, and the reason a
    knowledge base does not have to store every algebraic variant by hand.
    """
    parsed = equation if isinstance(equation, sp.Expr) else parse(equation)
    solutions = sp.solve(sp.Eq(parsed, 0), sp.Symbol(symbol), dict=True)
    if not solutions:
        raise ExprError(f"rearrange: `{parsed}` cannot be solved for {symbol!r}")
    return sp.simplify(solutions[0][sp.Symbol(symbol)])


@tool("solve_system", "solve_system(equations, unknowns)", "dict symbol -> expression")
def solve_system(equations: list[str], unknowns: list[str]) -> dict[str, sp.Expr]:
    """Solve a system of equations symbolically, exactly.

    This is what Engine B reaches for once a block is assembled: every equation
    is a law, and the answer comes out of algebra rather than out of iteration.
    """
    symbols = {name: sp.Symbol(name) for name in unknowns}
    parsed = [sp.Eq(eq if isinstance(eq, sp.Expr) else parse(eq), 0) for eq in equations]
    try:
        found = sp.solve(parsed, [symbols[name] for name in unknowns], dict=True)
    except Exception as exc:
        raise ExprError(f"solve_system: {exc}") from exc
    if isinstance(found, dict):
        found = [found]
    for candidate in found:
        if candidate and all(symbols[name] in candidate for name in unknowns):
            return {name: sp.simplify(candidate[symbols[name]]) for name in unknowns}
    raise ExprError(
        f"solve_system: no complete solution for {unknowns} in {equations}"
    )


@tool("solve_linear", "solve_linear(A, b, unknowns, dims=...)", "dict symbol -> Quantity")
def solve_linear(
    A: list[list[float]],
    b: list[float],
    unknowns: list[str],
    dims: list[Dim] | None = None,
) -> dict[str, Quantity]:
    """Solve ``A·x = b`` in SI magnitudes, returning dimensioned quantities.

    Used when a block is linear: exact rational arithmetic through sympy, with a
    least-squares fall-back for a system that is over-determined but consistent.
    """
    if len(A) != len(b):
        raise ValueError(f"A has {len(A)} rows but b has {len(b)} entries")
    if any(len(row) != len(unknowns) for row in A):
        raise ValueError("every row of A must have one column per unknown")
    matrix, rhs = sp.Matrix(A), sp.Matrix(b)
    try:
        solution = list(matrix.solve_least_squares(rhs)) if matrix.rows > matrix.cols else list(matrix.solve(rhs))
    except Exception as exc:
        raise ValueError(f"solve_linear: {exc}") from exc
    if dims is None:
        dims = [Dim.dimensionless() for _ in unknowns]
    if len(dims) != len(unknowns):
        raise ValueError("one dimension per unknown is required")
    return {
        name: Quantity(value=float(value), dim=dim)
        for name, value, dim in zip(unknowns, solution, dims)
    }


@tool("determinant", "determinant(matrix)", "float")
def determinant(matrix: list[list[float]]) -> float:
    """det(M). Non-zero is exactly the condition for a linear system to have one answer."""
    return float(sp.Matrix(matrix).det())


@tool("inverse", "inverse(matrix)", "list of lists")
def inverse(matrix: list[list[float]]) -> list[list[float]]:
    """M⁻¹, refused if M is singular: an inverse that does not exist must not be approximated."""
    try:
        inverted = sp.Matrix(matrix).inv()
    except Exception as exc:
        raise ValueError(f"inverse: the matrix is singular: {exc}") from exc
    return [[float(inverted[i, j]) for j in range(inverted.cols)] for i in range(inverted.rows)]


# --------------------------------------------------------------------------- numerics


@tool("quadrature", "quadrature(expr, var, a, b, steps=10000)", "float", dimension_aware=False)
def quadrature(expr: str | sp.Expr, var: str, a: float, b: float, steps: int = 10000) -> float:
    """Numerical definite integral by the trapezoidal rule, for the expressions with no closed form.

    Works on plain numbers, not dimensions: the caller divides by SI on the way
    in and tags the result on the way out.
    """
    parsed = expr if isinstance(expr, sp.Expr) else parse(expr)
    f = sp.lambdify(sp.Symbol(var), parsed, "math")
    if steps < 2:
        raise ValueError("steps must be at least 2")
    h = (b - a) / steps
    total = 0.5 * (f(a) + f(b))
    for i in range(1, steps):
        total += f(a + i * h)
    return float(total * h)


@tool("numeric_derivative", "numeric_derivative(expr, var, point, h=1e-7)", "float", dimension_aware=False)
def numeric_derivative(expr: str | sp.Expr, var: str, point: float, h: float = 1e-7) -> float:
    """Central-difference derivative at a point, for when the symbolic form is unavailable."""
    parsed = expr if isinstance(expr, sp.Expr) else parse(expr)
    f = sp.lambdify(sp.Symbol(var), parsed, "math")
    return float((f(point + h) - f(point - h)) / (2 * h))


@tool("integrate_ode", "integrate_ode(problem)", "Trajectory (Engine C)")
def integrate_ode(problem) -> Any:
    """Integrate a declared first-order system — Engine C, exposed as a tool."""
    from .engine_ode import ODEEngine

    return ODEEngine().integrate(problem)

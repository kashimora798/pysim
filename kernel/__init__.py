"""FieldForge kernel — public surface.

Three engines over one knowledge base, and the mathematical toolkit they call:

* :mod:`kernel.engine_chain`  — Engine A, backward chaining over algebraic chains;
* :mod:`kernel.engine_system` — Engine B, acausal assembly of simultaneous systems;
* :mod:`kernel.engine_ode`    — Engine C, time evolution by explicit integration;
* :mod:`kernel.math_tools`    — calculus, linear algebra and solvers, called by name.
"""

from .engine_chain import Derivation, Failure, Resolver  # Engine A
from .engine_ode import ODEEngine, ODEProblem, ODEVariable, Trajectory  # Engine C
from .engine_system import Block, Plan, SystemEngine, SystemError, SystemSolution  # Engine B
from .math_tools import TOOLS, SymbolicResult, call as call_tool, describe as describe_tools
from .math_tools import (
    curl,
    determinant,
    differentiate,
    divergence,
    gradient,
    integrate,
    integrate_definite,
    inverse,
    laplacian,
    limit,
    numeric_derivative,
    quadrature,
    rearrange,
    series,
    solve_linear,
    solve_system,
)
from .solve import SolveResult, solve_problem

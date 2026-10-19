"""``ff`` — the kernel's command line.

Four things you can do: audit the knowledge base, browse it, solve a problem, and measure
coverage. No command here touches the network or consults a model.
"""

from __future__ import annotations

import sys
from pathlib import Path

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from .engine_chain import Derivation
from .engine_system import SystemEngine
from .kb import KnowledgeBase, load_kb
from .scene import Ref, load_problem
from .solve import solve_problem
from .trace import build_simspec
from .units import format_quantity
from .validate import CORPUS_DIR, audit

# Windows consoles default to cp1252, which cannot render the superscripts in a dimension vector.
# Force UTF-8 rather than degrade the physics notation.
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:  # pragma: no cover - a console that refuses is not worth failing over
        pass

app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help="FieldForge kernel: problem in, lawful trace out.",
)
console = Console()

_SEVERITY_STYLE = {"error": "bold red", "warning": "yellow", "info": "dim"}


def _load() -> KnowledgeBase:
    try:
        return load_kb()
    except Exception as exc:
        console.print(f"[bold red]knowledge base failed to load:[/] {exc}")
        raise typer.Exit(code=2) from exc


# --------------------------------------------------------------------------- audit


@app.command("audit")
def audit_cmd(
    coverage: bool = typer.Option(True, "--coverage/--no-coverage", help="Also run the corpus."),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Show info-level findings too."),
) -> None:
    """Run the six validators over the knowledge base."""
    kb = _load()
    report, rows = audit(kb, with_coverage=coverage)

    s = report.stats
    console.print(
        Panel(
            f"[bold]{s['properties']}[/] properties   "
            f"[bold]{s['constants']}[/] constants   "
            f"[bold]{s['components']}[/] components   "
            f"[bold]{s['formulas']}[/] formulas   "
            f"[bold]{s['laws']}[/] laws",
            title="knowledge base",
            border_style="cyan",
        )
    )

    checks = ["refs", "dims", "rank", "units", "orphans", "coverage"]
    table = Table(show_header=True, header_style="bold", box=None, pad_edge=False)
    table.add_column("check")
    table.add_column("errors", justify="right")
    table.add_column("warnings", justify="right")
    table.add_column("notes", justify="right")
    grouped = report.by_check()
    for check in checks:
        found = grouped.get(check, [])
        errors = sum(1 for f in found if f.severity == "error")
        warnings = sum(1 for f in found if f.severity == "warning")
        infos = sum(1 for f in found if f.severity == "info")
        table.add_row(
            check,
            Text(str(errors), style="bold red" if errors else "green"),
            Text(str(warnings), style="yellow" if warnings else "dim"),
            Text(str(infos), style="dim"),
        )
    console.print(table)

    shown = [f for f in report.findings if verbose or f.severity != "info"]
    if shown:
        console.print()
        for f in sorted(shown, key=lambda f: (f.severity != "error", f.check, f.where)):
            style = _SEVERITY_STYLE[f.severity]
            console.print(f"[{style}]{f.severity:7}[/] [cyan]{f.check:9}[/] {f.where}")
            console.print(f"          {f.message}")

    if coverage and rows:
        console.print()
        _print_coverage(rows)

    console.print()
    if report.ok:
        console.print("[bold green]audit clean[/] — no structural errors")
    else:
        console.print(f"[bold red]audit failed[/] — {len(report.errors)} error(s)")
        raise typer.Exit(code=1)


def _print_coverage(rows) -> None:
    table = Table(title="corpus coverage", box=None, header_style="bold", title_justify="left")
    table.add_column("problem")
    table.add_column("engine")
    table.add_column("paths", justify="right")
    table.add_column("resolved")
    table.add_column("expected")
    table.add_column("")
    for r in rows:
        if not r.resolved:
            mark, style = "unresolved", "bold red"
        elif r.agrees is None:
            mark, style = "no expectation", "yellow"
        elif r.agrees:
            mark, style = "agrees", "green"
        else:
            mark, style = "DISAGREES", "bold red"
        engine_style = "magenta" if r.engine == "system" else "cyan"
        table.add_row(
            r.problem.id,
            Text(r.engine, style=engine_style),
            str(r.paths),
            r.value,
            r.expected,
            Text(mark, style=style),
        )
    console.print(table)

    total = len(rows)
    good = sum(1 for r in rows if r.agrees)
    multi = sum(1 for r in rows if r.paths > 1)
    by_system = sum(1 for r in rows if r.engine == "system")
    checked = sum(1 for r in rows if r.cross_check)
    pct = 100.0 * good / total if total else 0.0
    console.print(
        f"coverage [bold]{good}/{total}[/] ([bold]{pct:.0f}%[/])   "
        f"{multi} problem(s) resolved by more than one path"
    )
    console.print(
        f"[dim]engines: {by_system} problem(s) needed Engine B (simultaneous assembly); "
        f"{checked} cross-checked against Engine A[/]"
    )


# --------------------------------------------------------------------------- solve


@app.command()
def solve(
    problem_path: Path = typer.Argument(..., help="A corpus problem YAML file."),
    all_paths: bool = typer.Option(False, "--all-paths", "-a", help="Show every derivation."),
    spec_out: Path | None = typer.Option(None, "--spec", help="Write the SimSpec JSON here."),
) -> None:
    """Derive a problem's target and print the cited trace."""
    kb = _load()
    try:
        problem = load_problem(problem_path, kb)
    except Exception as exc:
        console.print(f"[bold red]cannot read problem:[/] {exc}")
        raise typer.Exit(code=2) from exc

    console.print(Panel(problem.text or problem.title, title=problem.id, border_style="cyan"))

    solved = solve_problem(kb, problem)
    derivations = solved.derivations

    if not derivations:
        console.print("[bold red]unresolved by either engine[/]")
        for note in solved.notes:
            console.print(f"  [dim]{note}[/]")
        raise typer.Exit(code=1)

    if solved.engine == "system":
        console.print(
            "[magenta]Engine A cannot reach this target; solved by Engine B, which assembles "
            "the local laws and solves them together.[/]"
        )
        for note in solved.notes:
            console.print(f"  [dim]{note}[/]")
    elif solved.cross_check:
        console.print(
            f"[dim]cross-check: Engine A and Engine B agree to "
            f"{solved.cross_check['rel_error']:.1e} relative[/]"
        )

    for index, derivation in enumerate(derivations if all_paths else derivations[:1]):
        label = f"path {index + 1} of {len(derivations)}"
        console.print()
        console.print(
            f"[bold]{label}[/]  cost {derivation.cost}  "
            f"laws: {', '.join(sorted(derivation.laws)) or '—'}"
        )
        _print_derivation(derivation, kb)

    console.print()
    console.print(
        f"[bold green]{problem.target}[/] = [bold]{format_quantity(derivations[0].value)}[/]"
    )
    if problem.expect:
        from .units import parse_quantity

        want = parse_quantity(f"{problem.expect.value} {problem.expect.unit}")
        console.print(f"expected {format_quantity(want)}")

    if len(derivations) > 1:
        console.print(
            f"[dim]{len(derivations)} distinct paths found; "
            f"re-run with --all-paths to see the alternatives[/]"
        )

    if spec_out:
        spec = build_simspec(problem, derivations, kb)
        spec_out.write_text(spec.to_json(), encoding="utf-8")
        console.print(f"[dim]SimSpec -> {spec_out}  ({len(spec.beats)} beats)[/]")


def _print_derivation(derivation: Derivation, kb: KnowledgeBase) -> None:
    for number, step in enumerate(derivation.steps, start=1):
        head = f"  [dim]{number:2}[/] [bold]{step.ref}[/] = {format_quantity(step.quantity)}"
        console.print(head)
        if step.is_given:
            console.print("       [dim]given by the problem[/]")
            continue
        formula = step.formula
        assert formula is not None
        console.print(f"       [cyan]{formula.key}[/]   {formula.expr_text}")
        console.print(f"       [dim]= {step.substituted()}[/]")
        law = kb.laws.get(formula.law or "")
        if law:
            console.print(f"       [magenta]{law.label}[/]")
        if formula.assumes:
            console.print(f"       [dim]assumes {', '.join(formula.assumes)}[/]")
        if formula.cite:
            console.print(f"       [dim]{formula.cite}[/]")


# --------------------------------------------------------------------------- coverage


@app.command()
def coverage(
    corpus: Path = typer.Option(CORPUS_DIR, "--corpus", help="Directory of problem YAML files."),
) -> None:
    """Resolve every corpus problem and report the percentage that reaches its known answer."""
    kb = _load()
    from .validate import Report, check_coverage

    report = Report()
    rows = check_coverage(kb, report, corpus)
    _print_coverage(rows)
    for f in report.errors:
        console.print(f"[bold red]error[/] {f.where}: {f.message}")
    if report.errors:
        raise typer.Exit(code=1)


@app.command("trajectories")
def trajectories_cmd(
    corpus: Path = typer.Option(None, "--corpus", help="Directory of trajectory YAML files."),
    json_out: Path | None = typer.Option(None, "--json", help="Write a sampled trajectory here."),
) -> None:
    """Integrate every trajectory in the corpus and hold it to its closed form (Engine C)."""
    from .engine_ode import ODEEngine
    from .trajectories import check as check_trajectory
    from .trajectories import load_trajectory_corpus

    entries = load_trajectory_corpus(corpus)
    if not entries:
        console.print("[yellow]no trajectory corpus found[/]")
        return

    engine = ODEEngine()
    table = Table(title="trajectory corpus", box=None, header_style="bold", title_justify="left")
    table.add_column("trajectory")
    table.add_column("method")
    table.add_column("steps", justify="right")
    table.add_column("sampled")
    table.add_column("closed form")
    table.add_column("")
    bad = 0
    for entry in entries:
        trajectory = engine.integrate(entry.problem)
        ok, detail = check_trajectory(entry, trajectory)
        bad += 0 if ok else 1
        table.add_row(
            entry.id,
            trajectory.method,
            str(trajectory.steps),
            detail.split(",")[0].replace("got ", ""),
            (detail.split(",")[1].replace(" want ", "") if "," in detail else "—"),
            Text("agrees" if ok else "DISAGREES", style="green" if ok else "bold red"),
        )
        if json_out and entry.id == entries[0].id:
            import json

            json_out.write_text(json.dumps(trajectory.to_json(), indent=1), encoding="utf-8")
    console.print(table)
    console.print(
        f"trajectories [bold]{len(entries) - bad}/{len(entries)}[/] reach the value the "
        "closed form requires"
    )
    if bad:
        raise typer.Exit(code=1)


# --------------------------------------------------------------------------- browse


@app.command()
def props(domain: str | None = typer.Argument(None, help="Filter to one domain.")) -> None:
    """List the property registry."""
    kb = _load()
    table = Table(box=None, header_style="bold")
    for column in ("property", "sym", "dimension", "rank", "kind", "unit", "solvers"):
        table.add_column(column)
    for group, items in sorted(kb.ontology.by_domain().items()):
        if domain and domain != group:
            continue
        for p in items:
            count = len(kb.solvers_for(p.key))
            table.add_row(
                p.key,
                p.symbol,
                str(p.dim),
                p.rank,
                p.kind,
                p.si_unit,
                Text(str(count), style="green" if count else "yellow"),
            )
    console.print(table)


@app.command()
def components(tag: str | None = typer.Argument(None, help="Filter by tag.")) -> None:
    """List the component shop."""
    kb = _load()
    table = Table(box=None, header_style="bold")
    for column in ("component", "tags", "settable", "observable"):
        table.add_column(column)
    for c in sorted(kb.components.values(), key=lambda c: c.key):
        if tag and tag not in c.tags:
            continue
        settable = sum(1 for s in c.slots.values() if s.role in ("settable", "intrinsic"))
        observable = sum(1 for s in c.slots.values() if s.role == "observable")
        table.add_row(c.key, ", ".join(c.tags), str(settable), str(observable))
    console.print(table)


@app.command()
def formulas(prop: str | None = typer.Argument(None, help="Only formulas solving this property.")) -> None:
    """List formulas, optionally those producing one property."""
    kb = _load()
    table = Table(box=None, header_style="bold")
    for column in ("formula", "solves", "scope", "expression", "law"):
        table.add_column(column)
    for f in sorted(kb.formulas.values(), key=lambda f: (f.solves_for, f.key)):
        if prop and f.solves_for != prop:
            continue
        table.add_row(f.key, f.solves_for, f.scope, f.expr_text, f.law or "—")
    console.print(table)


@app.command("export")
def export_cmd(
    out: Path | None = typer.Option(None, "--out", help="Output directory (default web/public/physics)."),
    strict: bool = typer.Option(False, "--strict", help="Refuse to export on warnings too."),
) -> None:
    """Compile the verified knowledge base to static JSON for the browser app."""
    from .export import ExportError, export

    try:
        result = export(out, allow_warnings=not strict)
    except ExportError as exc:
        console.print(f"[bold red]export refused[/]\n{exc}")
        raise typer.Exit(code=1) from exc

    console.print(
        Panel(
            f"kb.json        [bold]{result.kb_bytes / 1024:.1f} KiB[/]\n"
            f"specs          [bold]{len(result.problems)}[/] problems, "
            f"{result.spec_bytes / 1024:.1f} KiB\n"
            f"content hash   [bold]{result.content_hash}[/]\n"
            f"warnings       {result.warnings}",
            title=f"exported -> {result.out_dir}",
            border_style="green",
        )
    )
    console.print("[dim]every validator passed; only verified physics was written[/]")


# --------------------------------------------------------------------------- Engine B: system


@app.command("system")
def system_cmd(
    problem_path: Path = typer.Argument(..., help="A corpus problem YAML file."),
    target_prop: str | None = typer.Option(None, "--target", "-t", help="Property to solve for."),
    target_instance: str | None = typer.Option(None, "--instance", "-i", help="Instance to solve for."),
) -> None:
    """Assemble the scene's laws and solve them together (Engine B)."""
    kb = _load()
    try:
        problem = load_problem(problem_path, kb)
    except Exception as exc:
        console.print(f"[bold red]cannot read problem:[/] {exc}")
        raise typer.Exit(code=2) from exc

    target = problem.target
    if target_prop:
        target = Ref(target_instance or target.instance, target_prop, None)

    console.print(
        Panel(problem.text or problem.title, title=f"{problem.id} — Engine B", border_style="magenta")
    )
    engine = SystemEngine(kb, problem.scene)
    try:
        solution = engine.solve(target)
    except Exception as exc:
        console.print(f"[bold red]Engine B could not solve it:[/] {exc}")
        raise typer.Exit(code=1) from exc

    console.print(
        f"[bold]causalisation:[/] {solution.plan} — "
        f"{solution.simultaneous_blocks} simultaneous block(s), method {solution.method}"
    )
    for index, rows in sorted(solution.block_equations.items()):
        kind = "simultaneous" if index in solution.system_blocks else "chain step"
        console.print(f"\n[bold]block {index}[/] ({kind}) — {len(rows)} equation(s)")
        for line in engine.equations_text(solution.solved_equations.get(index, rows)):
            console.print(f"  [cyan]{line}[/]")

    console.print()
    for ref, quantity in solution.values.items():
        marker = "★" if ref == target else " "
        console.print(f" {marker} [bold]{ref}[/] = {format_quantity(quantity)}")
    console.print(f"\n[dim]residual over every assembled equation: {solution.residual:.2e}[/]")

    check = engine.cross_check(target)
    if "rel_error" in check:
        style = "green" if check["agree"] else "bold red"
        console.print(
            f"[{style}]cross-check with Engine A: relative difference "
            f"{check['rel_error']:.2e}[/]"
        )
    else:
        console.print(
            f"[dim]{check.get('note', 'Engine A cannot reach this target')}[/]"
        )


# --------------------------------------------------------------------------- Engine C: ODE


@app.command("ode")
def ode_cmd(
    example: str = typer.Argument("projectile", help="projectile | rc | gravity"),
    dt: float = typer.Option(0.001, "--dt", help="Time step"),
    t1: float = typer.Option(1.0, "--t1", help="End time"),
    method: str = typer.Option("rk4", "--method", help="euler | rk4 | rk45"),
    spec_out: Path | None = typer.Option(None, "--json", help="Write the trajectory JSON here."),
) -> None:
    """Integrate a problem whose answer is a function of time (Engine C)."""
    from .engine_ode import (
        ODEEngine,
        constant_acceleration,
        projectile_in_gravity,
        rc_charging,
        rc_closed_form,
    )

    console.print(
        Panel(f"Engine C — {example}, {method}, dt={dt}, t=[0, {t1}]", border_style="green")
    )
    engine = ODEEngine()
    check: str | None = None
    if example == "projectile":
        position, velocity = Ref("p", "geometry.position"), Ref("p", "kinematics.velocity")
        problem = constant_acceleration(position, velocity, 2.0, t_span=(0, t1), dt=dt, method=method)
        trajectory = engine.integrate(problem)
        a, t_end = 2.0, trajectory.t[-1]
        check = (
            f"algebraic kinematics: v = a*t = {a * t_end:.9g}, "
            f"s = a*t^2/2 = {a * t_end**2 / 2:.9g}"
        )
    elif example == "rc":
        voltage = Ref("c1", "em.potential_difference")
        problem = rc_charging(voltage, 5.0, 10_000.0, 100e-6, t_span=(0, t1), dt=dt, method=method)
        trajectory = engine.integrate(problem)
        check = (
            f"closed form V(t) = Vs(1 - e^-t/RC) = "
            f"{rc_closed_form(5.0, 0.0, 10_000.0, 100e-6, trajectory.t[-1]):.9g} V"
        )
    elif example == "gravity":
        position, velocity = Ref("ball", "geometry.position"), Ref("ball", "kinematics.velocity")
        problem = projectile_in_gravity(position, velocity, t_span=(0, t1), dt=dt, method=method)
        trajectory = engine.integrate(problem)
    else:
        console.print(f"[red]unknown example {example!r}; try projectile, rc or gravity[/]")
        raise typer.Exit(code=2)

    console.print(
        f"[bold]{trajectory.steps} steps[/] over t = [{trajectory.t[0]:.6g}, "
        f"{trajectory.t[-1]:.6g}] s, method {trajectory.method}"
    )
    for variable in trajectory.problem.variables:
        series = trajectory.y[variable.ref]
        final = series[-1]
        shown = (
            "[" + ", ".join(f"{c:.6g}" for c in final) + "]" if isinstance(final, tuple) else f"{final:.6g}"
        )
        console.print(f"  [bold]{variable.ref}[/] : {shown} {_unit_of(variable.dim)}")
    if check:
        console.print(f"[dim]cross-check against algebra: {check}[/]")

    if spec_out:
        import json

        spec_out.write_text(json.dumps(trajectory.to_json(), indent=1), encoding="utf-8")
        console.print(f"[dim]trajectory -> {spec_out}[/]")


def _coerce(text: str):
    """Read a command-line argument as a number or a list where it clearly is one.

    The toolkit is a Python API first; the command line is a convenience for
    looking at it, so arguments are read leniently and errors are reported with
    the signature rather than as a traceback.
    """
    import json

    if text.startswith(("[", "{")):
        try:
            return json.loads(text)
        except ValueError:
            return text
    for cast in (int, float):
        try:
            return cast(text)
        except ValueError:
            continue
    return text


def _unit_of(dim) -> str:
    from .units import display_unit

    return display_unit(dim)


# --------------------------------------------------------------------------- math toolkit


@app.command("math")
def math_cmd(
    name: str = typer.Argument(None, help="Tool name, or 'list' to see them all."),
    args: list[str] = typer.Argument(None, help="Positional arguments for the tool."),
) -> None:
    """Call a mathematical tool by name: differentiate, integrate, solve_system, ..."""
    from .math_tools import TOOLS, call as call_tool, describe as describe_tools

    if name in (None, "list", "tools"):
        table = Table(title="mathematical toolkit", box=None, header_style="bold", title_justify="left")
        table.add_column("tool")
        table.add_column("signature")
        table.add_column("dims", justify="center")
        for entry in describe_tools():
            table.add_row(
                f"[cyan]{entry['name']}[/]", entry["signature"],
                "yes" if entry["dimension_aware"] == "True" else "no",
            )
        console.print(table)
        console.print(
            "[dim]call one with: ff math <tool> <positional args...> — the toolkit is "
            "also importable from kernel.math_tools by any engine[/]"
        )
        return

    if name not in TOOLS:
        console.print(f"[red]unknown tool {name!r}[/]; available: {', '.join(sorted(TOOLS))}")
        raise typer.Exit(code=2)

    entry = TOOLS[name]
    positional = [_coerce(arg) for arg in (args or [])]
    try:
        result = call_tool(name, *positional)
    except TypeError as exc:
        console.print(f"[yellow]{name}: {exc}[/]\n[dim]signature: {entry.signature}[/]")
        raise typer.Exit(code=2) from exc
    except Exception as exc:
        console.print(f"[red]{name} failed:[/] {exc}")
        raise typer.Exit(code=1) from exc

    console.print(f"[bold cyan]{name}[/]  [dim]{entry.signature}[/]")
    if isinstance(result, tuple):
        for item in result:
            console.print(f"  {item}")
    elif hasattr(result, "expression"):
        console.print(f"  [bold]{result.expression}[/]   [{result.dim}]")
    else:
        console.print(f"  {result}")


if __name__ == "__main__":
    app()

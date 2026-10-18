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

from .engine_chain import Derivation, Resolver
from .kb import KnowledgeBase, load_kb
from .scene import Problem, Ref, load_corpus, load_problem
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
        table.add_row(r.problem.id, str(r.paths), r.value, r.expected, Text(mark, style=style))
    console.print(table)

    total = len(rows)
    good = sum(1 for r in rows if r.agrees)
    multi = sum(1 for r in rows if r.paths > 1)
    pct = 100.0 * good / total if total else 0.0
    console.print(
        f"coverage [bold]{good}/{total}[/] ([bold]{pct:.0f}%[/])   "
        f"{multi} problem(s) resolved by more than one path"
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

    resolver = Resolver(kb, problem.scene)
    derivations = resolver.resolve(problem.target)

    if not derivations:
        console.print(f"[bold red]unresolved[/]\n{resolver.failure(problem.target)}")
        raise typer.Exit(code=1)

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


if __name__ == "__main__":
    app()

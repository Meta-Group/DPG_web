"""Copy the DPG-CF counterfactual core into static/sandbox/counterfactuals/dpg_cf/.

The Counterfactuals page runs DPG-CF in the browser with Pyodide. DPG-CF is not on PyPI
yet, so the page ships a copy of the modules it needs. This script refreshes that copy
from a checkout of the counterfactual code (DPG_research, or the DPG repository's
`using-new-constraints-for-cf-generation` branch):

    python scripts/vendor_dpg_cf.py ../DPG_research/counterfactual

It rewrites the repository-specific imports (`from DPG_research.counterfactual.x import`
or the top-level `from utils.x import` of the DPG branch) into package-relative ones,
keeps only the `constants` section of configs/config.yaml, and writes MANIFEST.json (the
file list the web worker fetches) and SOURCE.md (where the copy came from).
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

import yaml

MODULES = [
    "boundary_analyzer.py",
    "constraint_parser.py",
    "constraint_validator.py",
    "counterfactual_metrics.py",
    "counterfactual_model.py",
    "fitness_calculator.py",
    "heuristic_runner.py",
    "sample_generator.py",
    "utils/config_manager.py",
    "utils/feature_utils.py",
]
# top-level module names the copied files import each other by
LOCAL = {Path(m).parts[0].removesuffix(".py") for m in MODULES}

INIT = '''"""DPG-CF: counterfactual explanations guided by Decision Predicate Graphs.

Vendored copy for the DPG website; see SOURCE.md. Do not edit by hand: run
scripts/vendor_dpg_cf.py instead.
"""

from .constraint_parser import ConstraintParser
from .counterfactual_model import CounterFactualModel

__all__ = ["ConstraintParser", "CounterFactualModel"]
'''


def rewrite_imports(text: str) -> str:
    """Turn absolute imports of sibling modules into package-relative ones."""
    text = re.sub(r"\bfrom DPG_research\.counterfactual\.", "from .", text)

    def top_level(match: re.Match) -> str:
        indent, module = match.group(1), match.group(2)
        if module.split(".")[0] not in LOCAL:
            return match.group(0)
        return f"{indent}from .{module} import"

    return re.sub(r"^(\s*)from ([A-Za-z_][\w.]*) import", top_level, text, flags=re.M)


def git_describe(path: Path) -> str:
    try:
        out = subprocess.run(
            ["git", "-C", str(path), "log", "-1", "--format=%H %cs"],
            check=True, capture_output=True, text=True,
        )
        remote = subprocess.run(
            ["git", "-C", str(path), "remote", "get-url", "origin"],
            capture_output=True, text=True,
        ).stdout.strip()
        commit, date = out.stdout.split()
        return f"{remote or 'local repository'} @ {commit} ({date})"
    except (subprocess.CalledProcessError, FileNotFoundError, ValueError):
        return "unknown (not a git checkout)"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path, help="the counterfactual/ directory to copy from")
    parser.add_argument("--dest", type=Path,
                        default=Path(__file__).resolve().parent.parent / "static" / "sandbox" / "counterfactuals" / "dpg_cf")
    args = parser.parse_args()
    src, dest = args.source.resolve(), args.dest.resolve()

    files = []
    for rel in MODULES:
        text = (src / rel).read_text()
        out = dest / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(rewrite_imports(text))
        files.append(rel)

    (dest / "__init__.py").write_text(INIT)
    (dest / "utils" / "__init__.py").write_text("")
    files += ["__init__.py", "utils/__init__.py"]

    constants = yaml.safe_load((src / "configs" / "config.yaml").read_text())["constants"]
    (dest / "configs").mkdir(exist_ok=True)
    (dest / "configs" / "config.yaml").write_text(
        "# The `constants` section of DPG-CF's configs/config.yaml (read by utils/config_manager.py).\n"
        + yaml.safe_dump({"constants": constants}, sort_keys=False)
    )
    files.append("configs/config.yaml")

    (dest / "MANIFEST.json").write_text(json.dumps(sorted(files), indent=2) + "\n")
    (dest / "SOURCE.md").write_text(
        "# Vendored DPG-CF\n\n"
        f"Copied by `scripts/vendor_dpg_cf.py` from `{src.name}/` of {git_describe(src)}.\n\n"
        "Only the imports were changed (made package-relative). Refresh with\n"
        "`python scripts/vendor_dpg_cf.py <path to counterfactual/>`.\n"
    )
    print(f"Copied {len(files)} files to {dest}")


if __name__ == "__main__":
    main()

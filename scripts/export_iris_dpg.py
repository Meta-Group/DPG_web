"""Export the landing page's example DPG to static/assets/iris-dpg.json.

Builds the same graph as the quickstart snippet on the landing page (a 5-tree random
forest on Iris, with communities) and writes a compact JSON the interactive graph reads.
The JSON layout comes from graph_data() in static/sandbox/dpg_sandbox.py, which the
Sandbox uses too.

Run:  .venv/bin/pip install dpg && .venv/bin/python scripts/export_iris_dpg.py
"""

from __future__ import annotations

import json
import sys
from importlib.metadata import version
from pathlib import Path

from sklearn.datasets import load_iris
from sklearn.ensemble import RandomForestClassifier

from dpg import DPGExplainer

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "static" / "sandbox"))
from dpg_sandbox import graph_data  # noqa: E402  (shared with the Sandbox)

OUT = ROOT / "static" / "assets" / "iris-dpg.json"
N_ESTIMATORS = 5
RANDOM_STATE = 42


def main() -> None:
    iris = load_iris(as_frame=True)
    X, y = iris.data, iris.target
    model = RandomForestClassifier(n_estimators=N_ESTIMATORS, random_state=RANDOM_STATE).fit(X, y)
    explainer = DPGExplainer(
        model=model,
        feature_names=X.columns.tolist(),
        target_names=[n.capitalize() for n in iris.target_names],  # Setosa, Versicolor, Virginica
    )
    explanation = explainer.explain_global(X.values, communities=True)

    payload = {
        "meta": {
            "dataset": "iris",
            "model": f"RandomForestClassifier(n_estimators={N_ESTIMATORS}, random_state={RANDOM_STATE})",
            "dpg_version": version("dpg"),
        },
        **graph_data(explanation),
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    print(f"wrote {OUT} ({len(payload['nodes'])} nodes, {len(payload['edges'])} edges)")


if __name__ == "__main__":
    main()

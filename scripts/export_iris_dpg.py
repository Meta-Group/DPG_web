"""Export the landing page's example DPG to static/assets/iris-dpg.json.

Builds the same graph as the quickstart snippet on the landing page (a 5-tree random
forest on Iris, with communities) and writes a compact JSON the interactive graph reads.

Run:  .venv/bin/pip install dpg && .venv/bin/python scripts/export_iris_dpg.py
"""

from __future__ import annotations

import json
from importlib.metadata import version
from pathlib import Path

import numpy as np
from sklearn.datasets import load_iris
from sklearn.ensemble import RandomForestClassifier

from dpg import DPGExplainer

OUT = Path(__file__).resolve().parent.parent / "static" / "assets" / "iris-dpg.json"
N_ESTIMATORS = 5
RANDOM_STATE = 42


def main() -> None:
    X, y = load_iris(return_X_y=True, as_frame=True)
    model = RandomForestClassifier(n_estimators=N_ESTIMATORS, random_state=RANDOM_STATE).fit(X, y)
    explainer = DPGExplainer(
        model=model,
        feature_names=X.columns.tolist(),
        target_names=np.unique(y).astype(str).tolist(),
    )
    explanation = explainer.explain_global(X.values, communities=True)

    clusters = explanation.communities["Clusters"]
    probs = explanation.communities["Probability"]
    community_of = {label: name for name, members in clusters.items() for label in members}
    metrics = explanation.node_metrics.set_index("Node")

    # The graph's node ids are long hashes; renumber them to keep the JSON small.
    ids = {node: f"n{i}" for i, node in enumerate(explanation.graph.nodes)}
    nodes = []
    for node, data in explanation.graph.nodes(data=True):
        label = data["predicate"]
        m = metrics.loc[node]
        nodes.append({
            "id": ids[node],
            "label": label,
            "isClass": label.startswith("Class "),
            "community": community_of.get(label),
            "betweenness": round(float(m["Betweenness centrality"]), 4),
            "lrc": round(float(m["Local reaching centrality"]), 4),
            "probs": {k: round(float(v), 3) for k, v in probs.get(label, {}).items()},
        })
    edges = [
        {"source": ids[u], "target": ids[v], "weight": int(d["weight"]) if float(d["weight"]).is_integer() else d["weight"]}
        for u, v, d in explanation.graph.edges(data=True)
    ]

    payload = {
        "meta": {
            "dataset": "iris",
            "model": f"RandomForestClassifier(n_estimators={N_ESTIMATORS}, random_state={RANDOM_STATE})",
            "dpg_version": version("dpg"),
        },
        "communities": [name for name, members in clusters.items() if members],
        "nodes": nodes,
        "edges": edges,
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    print(f"wrote {OUT} ({len(nodes)} nodes, {len(edges)} edges)")


if __name__ == "__main__":
    main()

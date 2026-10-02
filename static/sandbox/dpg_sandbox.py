"""Display helpers for the DPG Sandbox notebook.

Inside the Sandbox (Pyodide in a web worker) the helpers send structured results to the
page, which renders them as tables, score tiles and the interactive graph. Anywhere else,
e.g. a downloaded copy of the notebook in Jupyter, they fall back to IPython's display.

graph_data() is also used by scripts/export_iris_dpg.py to build the landing page's graph.
"""

from __future__ import annotations

import io
import json
import math
import os
import time
import traceback

import numpy as np
import pandas as pd

try:  # only present inside the Sandbox worker
    from sandbox_bridge import emit as _bridge_emit
except ImportError:
    _bridge_emit = None

IN_SANDBOX = _bridge_emit is not None
MAX_TABLE_ROWS = 500

__all__ = [
    "display", "ensure_iris", "graph_data", "show_boundaries", "show_dataset", "show_graph", "show_scores",
]


# ---------------------------------------------------------------------------
# data conversion
# ---------------------------------------------------------------------------


def _plain(value):
    """Make numpy/pandas scalars JSON-friendly (NaN/inf -> None)."""
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        value = float(value)
        return None if math.isnan(value) or math.isinf(value) else value
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if value is None or isinstance(value, (int, str, bool)):
        return value
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    return str(value)


def _table(df: pd.DataFrame, caption: str | None = None, max_rows: int = MAX_TABLE_ROWS) -> dict:
    shown = df.head(max_rows)
    # a sorted or filtered frame keeps its old integer row numbers; show the index only when it means something
    keep_index = df.index.name is not None or not pd.api.types.is_integer_dtype(df.index)
    if keep_index:
        shown = shown.reset_index()
    return {
        "kind": "table",
        "caption": caption,
        "columns": [str(c) for c in shown.columns],
        "rows": [[_plain(v) for v in row] for row in shown.itertuples(index=False, name=None)],
        "total": int(len(df)),
    }


def _bare(name: str) -> str:
    """DPG names class nodes and class communities 'Class setosa'; show just 'setosa'."""
    return name[len("Class "):] if name.startswith("Class ") else name


def graph_data(explanation) -> dict:
    """Compact JSON for the interactive graph (assets/graph.js) from a DPGExplanation."""
    communities = explanation.communities or {}
    clusters = communities.get("Clusters", {}) or {}
    probs = communities.get("Probability", {}) or {}
    community_of = {label: name for name, members in clusters.items() for label in members}
    metrics = explanation.node_metrics.set_index("Node") if explanation.node_metrics is not None else None

    # The graph's node ids are long hashes; renumber them to keep the JSON small.
    ids = {node: f"n{i}" for i, node in enumerate(explanation.graph.nodes)}
    nodes = []
    for node, data in explanation.graph.nodes(data=True):
        label = str(data.get("predicate", node))
        m = metrics.loc[node] if metrics is not None and node in metrics.index else None
        nodes.append({
            "id": ids[node],
            "label": _bare(label),
            "isClass": label.startswith("Class "),
            "community": _bare(community_of[label]) if label in community_of else None,
            "betweenness": round(float(m["Betweenness centrality"]), 4) if m is not None else 0.0,
            "lrc": round(float(m["Local reaching centrality"]), 4) if m is not None else 0.0,
            "probs": {_bare(str(k)): round(float(v), 3) for k, v in (probs.get(label) or {}).items()},
        })
    edges = []
    for u, v, d in explanation.graph.edges(data=True):
        w = float(d.get("weight", 1))
        edges.append({"source": ids[u], "target": ids[v], "weight": int(w) if w.is_integer() else round(w, 4)})
    return {
        "communities": [_bare(name) for name, members in clusters.items() if members],
        "nodes": nodes,
        "edges": edges,
    }


def _class_bounds(explanation) -> dict:
    bounds = explanation.class_boundaries or {}
    bounds = bounds.get("Class Bounds", bounds)
    if isinstance(bounds, str):  # older dpg versions return the repr of a dict
        import ast
        try:
            bounds = ast.literal_eval(bounds)
        except (ValueError, SyntaxError):
            return {"(unparsed)": [bounds]}
    return {str(k): [str(c) for c in v] for k, v in bounds.items()}


# ---------------------------------------------------------------------------
# public helpers
# ---------------------------------------------------------------------------


def _emit(payload: dict) -> None:
    _bridge_emit(json.dumps(payload, default=_plain, allow_nan=False))


def _is_explanation(obj) -> bool:
    return type(obj).__name__ == "DPGExplanation" and hasattr(obj, "graph")


def display(*objs) -> None:
    """Show objects in the cell output: DataFrames as tables, DPG explanations as graphs."""
    if not IN_SANDBOX:
        from IPython.display import display as ipy_display
        for obj in objs:
            ipy_display(obj.dot if _is_explanation(obj) else obj)
        return
    for obj in objs:
        if obj is None:
            continue
        if _is_explanation(obj):
            show_graph(obj)
        elif isinstance(obj, pd.DataFrame):
            _emit(_table(obj))
        elif isinstance(obj, pd.Series):
            _emit(_table(obj.to_frame()))
        elif _is_figure(obj):
            _emit_figure(obj)
        else:
            _emit({"kind": "text", "text": repr(obj)})


def ensure_iris(path: str = "iris.csv") -> str:
    """Write the Iris dataset (scikit-learn's bundled copy) to ``path`` if it is missing."""
    if not os.path.exists(path):
        from sklearn.datasets import load_iris
        iris = load_iris(as_frame=True)
        frame = iris.frame
        frame["target"] = frame["target"].map(dict(enumerate(n.capitalize() for n in iris.target_names)))  # Setosa, ...
        frame.to_csv(path, index=False)
    return path


def show_dataset(df: pd.DataFrame, target: str) -> None:
    """Summarise a dataset: size, features, class balance and the first rows."""
    counts = df[target].value_counts().sort_index()
    if not IN_SANDBOX:
        print(f"{len(df)} rows, {df.shape[1] - 1} features, target '{target}' with {len(counts)} classes")
        display(counts.to_frame("rows"), df.head(8))
        return
    _emit({
        "kind": "dataset",
        "rows": int(len(df)),
        "features": [str(c) for c in df.columns if c != target],
        "target": str(target),
        "classes": {str(k): int(v) for k, v in counts.items()},
        "head": _table(df, max_rows=8),
    })


def show_scores(scores: dict) -> None:
    """Show per-fold scores ({metric: [fold values]}) as mean ± std tiles plus a fold table."""
    if not IN_SANDBOX:
        frame = pd.DataFrame(scores)
        frame.index = [f"fold {i + 1}" for i in range(len(frame))]
        display(frame.agg(["mean", "std"]), frame)
        return
    _emit({"kind": "scores", "metrics": {str(k): [float(x) for x in v] for k, v in scores.items()}})


def show_graph(explanation) -> None:
    """Render a DPGExplanation as the interactive graph."""
    if not IN_SANDBOX:
        display(explanation)
        return
    _emit({"kind": "graph", "data": graph_data(explanation)})


def show_boundaries(explanation) -> None:
    """List the class boundaries (feature intervals per class) of a DPGExplanation."""
    bounds = _class_bounds(explanation)
    if not IN_SANDBOX:
        for cls, constraints in bounds.items():
            print(f"{cls}: " + "; ".join(constraints))
        return
    _emit({"kind": "boundaries", "classes": bounds})


# ---------------------------------------------------------------------------
# matplotlib: show figures inline, like Jupyter's inline backend
# ---------------------------------------------------------------------------


def _is_figure(obj) -> bool:
    return type(obj).__name__ == "Figure" and hasattr(obj, "savefig")


def _emit_figure(fig) -> None:
    import base64
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=110, bbox_inches="tight")
    _emit({"kind": "image", "png": base64.b64encode(buf.getvalue()).decode("ascii")})


def _flush_figures() -> None:
    import sys
    if "matplotlib.pyplot" not in sys.modules:
        return
    import matplotlib.pyplot as plt
    for num in plt.get_fignums():
        _emit_figure(plt.figure(num))
    plt.close("all")


# ---------------------------------------------------------------------------
# cell execution (Sandbox only; called by worker.js)
# ---------------------------------------------------------------------------


class _Stream(io.TextIOBase):
    """stdout/stderr that forwards text to the page, batched so progress bars stay cheap."""

    def __init__(self, name: str):
        self.name, self._buf, self._last = name, [], 0.0

    def writable(self) -> bool:
        return True

    def write(self, text: str) -> int:
        self._buf.append(text)
        if time.monotonic() - self._last > 0.1:
            self.flush()
        return len(text)

    def flush(self) -> None:
        if self._buf:
            _emit({"kind": "stream", "name": self.name, "text": "".join(self._buf)})
            self._buf = []
        self._last = time.monotonic()


_namespace: dict = {"__name__": "__main__"}


def _setup() -> None:
    import matplotlib
    matplotlib.use("agg")
    import matplotlib.pyplot as plt
    plt.show = lambda *args, **kwargs: _flush_figures()


async def run_cell(code: str, count: int) -> bool:
    """Run one notebook cell; the value of a trailing expression is displayed, as in Jupyter."""
    import contextlib
    from pyodide.code import eval_code_async

    import linecache

    filename = f"<cell {count}>"
    linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)  # source lines in tracebacks
    out, err = _Stream("stdout"), _Stream("stderr")
    ok = True
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            result = await eval_code_async(code, globals=_namespace, return_mode="last_expr", filename=filename)
            out.flush(); err.flush()
            if result is not None:
                display(result)
            _flush_figures()
        except BaseException as exc:  # noqa: BLE001 - report everything, like Jupyter
            ok = False
            out.flush(); err.flush()
            frames = traceback.extract_tb(exc.__traceback__)
            # drop the frames of this runner and of Pyodide's eval machinery
            start = next((i for i, f in enumerate(frames) if f.filename.startswith("<cell")), 0)
            lines = traceback.format_list(frames[start:]) if frames else []
            _emit({
                "kind": "error",
                "ename": type(exc).__name__,
                "evalue": str(exc),
                "traceback": "".join(lines),
            })
    out.flush(); err.flush()
    return ok

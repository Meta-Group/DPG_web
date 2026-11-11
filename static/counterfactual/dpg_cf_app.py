"""Python side of the Counterfactuals page.

The page (cf.js) calls these functions through the web worker (worker.js) with JSON
arguments and gets JSON back. They keep the loaded dataset, the trained model and the
DPG constraints in module state between calls:

    load_dataset  -> pick a preset or an uploaded CSV
    train         -> fit a random forest, build its DPG, extract per-class constraints
    generate      -> run DPG-CF for one test instance and score the counterfactuals

The counterfactual search itself is the vendored DPG-CF package in dpg_cf/; this module
only prepares its inputs and summarises its outputs. It also runs under plain CPython,
which is how it is tested (see README.md).
"""

from __future__ import annotations

import contextlib
import copy
import io
import json
import math
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split

from dpg_cf import ConstraintParser, CounterFactualModel
from dpg_cf.counterfactual_metrics import continuous_distance, continuous_diversity, plausibility

HERE = Path(__file__).resolve().parent
RULES = ("free", "non_decreasing", "non_increasing", "no_change")

# DPG-CF settings of the paper's experiments (DPG_research counterfactual/configs/config.yaml,
# methods._default merged with methods.dpg).
CF_DEFAULTS = {
    "diversity_weight": 0.8,
    "repulsion_weight": 4.0,
    "boundary_weight": 15.0,
    "distance_factor": 100.0,
    "sparsity_factor": 1.0,
    "constraints_factor": 3.0,
    "original_escape_weight": 2.0,
    "escape_pressure": 0.5,
    "prioritize_non_overlapping": True,
    "overgeneration_factor": 10,
    "diversity_lambda": 0.9,
    "min_probability_margin": 0.001,
}
DPG_DEFAULTS = {"perc_var": 1e-7, "decimal_threshold": 3}

# Model settings and actionability rules from each dataset's experiment config.
PRESETS = {
    "diabetes": {
        "label": "Diabetes (Pima)",
        "file": "datasets/diabetes.csv",
        "target": "Outcome",
        "classes": {0: "Non-diabetic", 1: "Diabetic"},
        "drop_zero_rows": True,
        "model": {"n_estimators": 12, "max_depth": 5, "max_features": None, "min_impurity_decrease": 0.01},
        "actionability": {
            "Age": "non_decreasing",
            "Pregnancies": "non_decreasing",
            "DiabetesPedigreeFunction": "no_change",
        },
        "note": "The paper's worked example. As in the experiments, rows with a zero in any feature "
                "(zeros encode missing values here) are dropped.",
    },
    "iris": {
        "label": "Iris",
        "file": None,
        "target": "species",
        "classes": None,
        "drop_zero_rows": False,
        "model": {"n_estimators": 7, "max_depth": 4, "max_features": 0.5, "min_impurity_decrease": 0.1},
        "actionability": {},
        "note": "Three classes and no actionability rules: every feature may move freely.",
    },
}

_state: dict = {}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _num(value):
    """JSON-friendly float (NaN/inf -> None)."""
    if value is None:
        return None
    value = float(value)
    return None if math.isnan(value) or math.isinf(value) else value


def _dumps(obj) -> str:
    return json.dumps(obj, default=lambda o: o.item() if hasattr(o, "item") else str(o))


def _quiet(fn, *args, **kwargs):
    """Run fn with stdout/stderr captured (DPG prints progress bars); return (result, log)."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        result = fn(*args, **kwargs)
    return result, buf.getvalue()


def _need(*keys):
    missing = [k for k in keys if k not in _state]
    if missing:
        raise RuntimeError("Train a model first." if "model" in missing else "Load a dataset first.")


def _iris() -> pd.DataFrame:
    from sklearn.datasets import load_iris

    data = load_iris(as_frame=True)
    df = data.frame.rename(columns={"target": "species"})
    df["species"] = [str(data.target_names[i]).capitalize() for i in df["species"]]
    return df


def _prepare(df: pd.DataFrame, target: str, class_names=None):
    """Numeric feature matrix, integer labels 0..K-1 and their display names."""
    if target not in df.columns:
        raise ValueError(f"Column '{target}' is not in the file.")
    df = df.dropna(subset=[target])
    features = df.drop(columns=[target])
    bools = features.select_dtypes(include="bool").columns
    features[bools] = features[bools].astype(int)
    numeric = features.select_dtypes(include="number")
    dropped = [str(c) for c in features.columns if c not in numeric.columns]
    if numeric.shape[1] == 0:
        raise ValueError("The file has no numeric feature columns.")
    numeric = numeric.astype(float)
    numeric = numeric.fillna(numeric.median())
    numeric.columns = [str(c) for c in numeric.columns]

    codes, uniques = pd.factorize(df[target], sort=True)
    if len(uniques) < 2:
        raise ValueError(f"Column '{target}' has a single value; counterfactuals need at least two classes.")
    if len(uniques) > 20:
        raise ValueError(f"Column '{target}' has {len(uniques)} distinct values; pick a categorical target.")
    names = [str(u) for u in uniques]
    if class_names:
        names = [class_names.get(u, str(u)) for u in uniques]
    return numeric.reset_index(drop=True), pd.Series(codes, name="target"), names, dropped


# ---------------------------------------------------------------------------
# API called from the page
# ---------------------------------------------------------------------------


def presets() -> str:
    return _dumps({
        key: {"label": p["label"], "model": p["model"], "note": p["note"]} for key, p in PRESETS.items()
    } | {"_cf_defaults": CF_DEFAULTS, "_dpg_defaults": DPG_DEFAULTS})


def load_dataset(spec_json: str) -> str:
    """spec: {"preset": "diabetes"} or {"csv": "<file name in the worker FS>", "target": "<column or ''>"}."""
    spec = json.loads(spec_json)
    _state.clear()
    notes = []
    if spec.get("preset"):
        preset = PRESETS[spec["preset"]]
        df = pd.read_csv(HERE / preset["file"]) if preset["file"] else _iris()
        target = preset["target"]
        if preset["drop_zero_rows"]:
            before = len(df)
            df = df[~(df.drop(columns=[target]) == 0).any(axis=1)]
            notes.append(f"Dropped {before - len(df)} of {before} rows with a zero in some feature.")
        X, y, names, dropped = _prepare(df, target, preset["classes"])
        actionability = dict(preset["actionability"])
        model_params = dict(preset["model"])
    else:
        df = pd.read_csv(spec["csv"])
        target = spec.get("target") or df.columns[-1]
        X, y, names, dropped = _prepare(df, target)
        actionability = {}
        model_params = {"n_estimators": 10, "max_depth": 5, "max_features": "sqrt", "min_impurity_decrease": 0.0}
    if dropped:
        notes.append("Ignored non-numeric columns: " + ", ".join(dropped) + ".")

    _state.update(X=X, y=y, class_names=names, target=str(target))
    counts = np.bincount(y, minlength=len(names))
    return _dumps({
        "rows": int(len(X)),
        "features": list(X.columns),
        "target": str(target),
        "classes": [{"id": i, "name": n, "count": int(c)} for i, (n, c) in enumerate(zip(names, counts))],
        "actionability": {f: actionability.get(f, "free") for f in X.columns},
        "model": model_params,
        "columns": [str(c) for c in df.columns],
        "notes": notes,
    })


def train(params_json: str) -> str:
    """Fit the random forest, build its DPG and extract the per-class constraints."""
    _need("X")
    p = json.loads(params_json)
    X, y = _state["X"], _state["y"]
    t0 = time.perf_counter()
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=float(p.get("test_size", 0.2)), random_state=42,
    )
    max_features = p.get("max_features")
    model = RandomForestClassifier(
        n_estimators=int(p.get("n_estimators", 10)),
        max_depth=int(p["max_depth"]) if p.get("max_depth") else None,
        max_features=max_features,
        min_impurity_decrease=float(p.get("min_impurity_decrease", 0.0)),
        random_state=int(p.get("random_state", 42)),
    )
    model.fit(X_train, y_train)
    fit_time = time.perf_counter() - t0

    dpg_config = {"dpg": {"default": {
        "perc_var": float(p.get("perc_var", DPG_DEFAULTS["perc_var"])),
        "decimal_threshold": int(p.get("decimal_threshold", DPG_DEFAULTS["decimal_threshold"])),
        "n_jobs": 1,
    }}}
    t1 = time.perf_counter()
    result, log = _quiet(
        ConstraintParser.extract_constraints_from_dataset,
        model, X_train.values, y_train.values, list(X.columns), dpg_config=dpg_config,
    )
    dpg_time = time.perf_counter() - t1
    raw = result["constraints"]
    if not raw:
        raise RuntimeError("DPG found no class constraints for this model. Try more trees or a deeper forest.")

    pred_test = model.predict(X_test)
    proba_test = model.predict_proba(X_test)
    _state.update(model=model, X_train=X_train, X_test=X_test.reset_index(drop=True),
                  y_test=y_test.reset_index(drop=True), pred_test=pred_test, constraints=raw)

    names = _state["class_names"]
    normalized = ConstraintParser.normalize_constraints(raw)
    constraints = {}
    for key, feats in normalized.items():
        cid = key[len("Class "):]
        constraints[cid] = {f: {"min": _num(b["min"]), "max": _num(b["max"])} for f, b in feats.items()}

    test_rows = []
    for i in range(min(len(X_test), 500)):
        test_rows.append({
            "i": i,
            "values": [_num(v) for v in X_test.iloc[i].values],
            "true": int(y_test.iloc[i]),
            "pred": int(pred_test[i]),
            "conf": _num(proba_test[i].max()),
        })

    return _dumps({
        "train_accuracy": _num(model.score(X_train, y_train)),
        "test_accuracy": _num(model.score(X_test, y_test)),
        "n_train": int(len(X_train)),
        "n_test": int(len(X_test)),
        "fit_time": fit_time,
        "dpg_time": dpg_time,
        "constraints": constraints,
        "ranges": {f: {"min": _num(X_train[f].min()), "max": _num(X_train[f].max())} for f in X.columns},
        "test": test_rows,
        "class_names": names,
        "log": log[-4000:],
    })


def _close_open_intervals(raw: dict, X_train: pd.DataFrame) -> dict:
    """Replace missing DPG bounds (e.g. only 'Glucose <= 159') with the observed feature range."""
    closed = copy.deepcopy(raw)
    lo, hi = X_train.min(), X_train.max()
    for entries in closed.values():
        for e in entries:
            if e["feature"] in lo.index:
                if e.get("min") is None:
                    e["min"] = float(lo[e["feature"]])
                if e.get("max") is None:
                    e["max"] = float(hi[e["feature"]])
    return closed


STAGES = {
    "_binary_search_feature": (1, "per-feature binary search"),
    "_asymmetric_depth_search": (2, "asymmetric depth search"),
    "_progressive_depth_search": (3, "progressive depth search"),
    "_random_sample_search": (4, "random sampling in the constraint space"),
}


def _trace_base_stage(generator) -> dict:
    """Record which search stage the first get_valid_sample call (the base CF) reaches.

    Wraps the SampleGenerator instance's stage methods; the vendored code is unchanged.
    """
    trace = {"active": False, "done": False, "stage": 0, "base": None}

    for name in STAGES:
        method = getattr(generator, name)

        def wrapped(*args, _method=method, _name=name, **kwargs):
            if trace["active"]:
                trace["stage"] = max(trace["stage"], STAGES[_name][0])
            return _method(*args, **kwargs)

        setattr(generator, name, wrapped)

    get_valid = generator.get_valid_sample

    def traced(*args, **kwargs):
        first = not trace["done"]
        trace["active"] = first
        try:
            out = get_valid(*args, **kwargs)
        finally:
            trace["active"] = False
            trace["done"] = True
        if first:
            trace["base"] = dict(out)
        return out

    generator.get_valid_sample = traced
    return trace


def generate(params_json: str) -> str:
    """Run DPG-CF for one test instance.

    params: index (row of the test set), target (class id), actionability {feature: rule},
    k, close_intervals, seed and optionally any CF_DEFAULTS key.
    """
    _need("model")
    p = json.loads(params_json)
    model, X_train, X_test = _state["model"], _state["X_train"], _state["X_test"]
    names = _state["class_names"]
    features = list(X_train.columns)
    idx, target, k = int(p["index"]), int(p["target"]), int(p.get("k", 5))
    sample = {f: float(v) for f, v in X_test.iloc[idx].items()}
    original_class = int(model.predict(pd.DataFrame([sample]))[0])
    if original_class == target:
        raise ValueError("Pick a target class different from the predicted one.")

    rules = {f: r for f, r in (p.get("actionability") or {}).items() if r in RULES and r != "free"}
    raw = _state["constraints"]
    constraints = _close_open_intervals(raw, X_train) if p.get("close_intervals", True) else raw
    settings = {key: p.get(key, default) for key, default in CF_DEFAULTS.items()}
    settings["overgeneration_factor"] = int(settings["overgeneration_factor"])

    np.random.seed(int(p.get("seed", 0)))
    cf_model = CounterFactualModel(model, constraints, dict_non_actionable=rules or None,
                                   requested_counterfactuals=k, **settings)
    trace = _trace_base_stage(cf_model.sample_generator)
    t0 = time.perf_counter()
    cfs, log = _quiet(cf_model.generate_counterfactual, sample, target)
    runtime = time.perf_counter() - t0
    cfs = [{f: float(cf[f]) for f in features} for cf in (cfs or [])]

    rows = []
    cf_array = np.array([[cf[f] for f in features] for cf in cfs]) if cfs else np.empty((0, len(features)))
    if cfs:
        preds = model.predict(pd.DataFrame(cfs, columns=features))
        probas = model.predict_proba(pd.DataFrame(cfs, columns=features))
    for j, cf in enumerate(cfs):
        changed = [f for f in features if not math.isclose(cf[f], sample[f], rel_tol=1e-9, abs_tol=1e-9)]
        rows.append({
            "values": cf,
            "pred": int(preds[j]),
            "proba": [_num(v) for v in probas[j]],
            "valid": bool(preds[j] == target),
            "actionable": bool(cf_model.is_actionable_change(cf, sample)),
            "changed": changed,
        })

    metrics = {"requested": k, "returned": len(cfs), "runtime": runtime}
    x = np.array([sample[f] for f in features])
    allf = list(range(len(features)))
    if cfs:
        n_valid = sum(r["valid"] for r in rows)
        metrics.update(
            validity=n_valid / k,
            actionability=sum(r["actionable"] for r in rows) / k,
            sparsity=float(np.mean([len(r["changed"]) / len(features) for r in rows])),
            changed=float(np.mean([len(r["changed"]) for r in rows])),
            distance=_num(continuous_distance(x, cf_array, allf, metric="mad", X=X_train.values)),
            diversity=_num(continuous_diversity(cf_array, allf, metric="mad", X=X_train.values)) if len(cfs) > 1 else None,
        )
        valid_cfs = cf_array[[r["valid"] for r in rows]]
        if len(valid_cfs):
            total = plausibility(x, model, valid_cfs, X_test.values, _state["pred_test"],
                                 allf, [], X_train.values, 1.0)
            metrics["implausibility"] = _num(total / len(valid_cfs))

    base = trace["base"]
    stage_no = trace["stage"]
    stage = {
        "number": stage_no,
        "name": STAGES_BY_NO.get(stage_no, "direct move into the target-class intervals"),
        "changed": [f for f in features if base and not math.isclose(base[f], sample[f], abs_tol=1e-9)],
    }

    def class_bounds(cid):
        out = {}
        for e in constraints.get(f"Class {cid}", []):
            out[e["feature"]] = {"min": _num(e.get("min")), "max": _num(e.get("max"))}
        return out

    return _dumps({
        "features": features,
        "original": sample,
        "original_class": original_class,
        "original_proba": [_num(v) for v in model.predict_proba(pd.DataFrame([sample]))[0]],
        "target": target,
        "class_names": names,
        "counterfactuals": rows,
        "metrics": metrics,
        "stage": stage,
        "bounds": {"target": class_bounds(target), "original": class_bounds(original_class)},
        "ranges": {f: {"min": _num(X_train[f].min()), "max": _num(X_train[f].max())} for f in features},
        "rules": {f: rules.get(f, "free") for f in features},
        "log": log[-4000:],
    })


STAGES_BY_NO = {no: name for no, name in STAGES.values()}

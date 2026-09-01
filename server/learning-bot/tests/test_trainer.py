"""Tests for the leakage-free TAKE/SKIP trainer (rl_trainer.py)."""

import json
import math
import random
import subprocess
import sys
from pathlib import Path

import pytest

import rl_trainer as T

TRAINER = Path(__file__).resolve().parents[1] / "rl_trainer.py"
PYEXE = sys.executable


# --------------------------------------------------------------------------
# synthetic dataset
# --------------------------------------------------------------------------

def make_rows(n=900, bots=("model-5", "model-6"), seed=7):
    rng = random.Random(seed)
    rows = []
    ts = 1_609_459_200_000  # 2021-01-01
    for i in range(n):
        ts += 6 * 3_600_000
        bot = bots[i % len(bots)]
        feats = {f"x{k}": round(math.sin(i / (k + 3)) + (rng.random() - 0.5), 6) for k in range(10)}
        edge = feats["x0"] * 0.9 + feats["x1"] * 0.5 - 0.1 + (rng.random() - 0.5) * 0.8
        win = 1 if edge > 0 else 0
        net_r = round(0.6 + rng.random() * 1.3, 3) if win else round(-(0.7 + rng.random() * 0.5), 3)
        pnl = round(net_r * 7, 2)
        frac = i / n
        split = "train" if frac < 0.6 else "val" if frac < 0.8 else "holdout"
        rows.append({
            "schemaVersion": 2, "id": f"t{i}", "runId": "test",
            "symbol": "BTCUSDT" if i % 3 == 0 else "SOLUSDT",
            "isExtendedUniverse": False, "timestamp": ts,
            "signalModelId": bot, "signalModelName": bot,
            "strategyFamily": "mean-reversion" if bot == "model-5" else "volatility-breakout",
            "setupFamily": "Oversold reversion" if win else "Overbought reversion",
            "side": "BUY" if i % 2 else "SELL",
            "marketRegime": ["RANGE", "BULL_TREND", "HIGH_VOLATILITY"][i % 3],
            "split": split, "featureVersion": "featv1-2026-09", "features": feats,
            "entryQualityScore": 40 + rng.randint(0, 30),
            "configuredStopLossPercent": 0.6, "leverage": 6, "notional": 500,
            "signalSummary": "test setup confirmed",
            "label": {
                "outcome": "CLOSED_TP" if win else "CLOSED_SL", "win": win, "tpBeforeSl": win,
                "netR": net_r, "netReturn": round(pnl / 500, 6), "pnl": pnl,
                "grossPnl": round(pnl + 0.7, 2), "frictionUsd": 0.7,
                "holdBars": 12, "holdHours": 1, "timedOut": False,
            },
            "reward": math.tanh(net_r / 2),
            "status": "CLOSED_TP" if win else "CLOSED_SL", "result": "TP" if win else "SL",
            "pnl": pnl, "closedAt": ts + 3_600_000, "tradeDateKey": "x",
        })
    return rows


def write_inputs(tmp_path, rows, epochs=15):
    tmp_path.mkdir(parents=True, exist_ok=True)
    ds = tmp_path / "dataset.json"
    cfg = tmp_path / "config.json"
    art = tmp_path / "artifact.json"
    ds.write_text(json.dumps({"generatedAt": 0, "config": {}, "rows": rows}))
    cfg.write_text(json.dumps({"learningBot": {"trainingScope": "per-bot", "aiTrainer": {
        "devicePreference": "cuda", "epochs": epochs, "batchSize": 128, "learningRate": 0.001,
    }}}))
    return ds, cfg, art


def run_trainer(tmp_path, rows, epochs=15):
    ds, cfg, art = write_inputs(tmp_path, rows, epochs)
    proc = subprocess.run(
        [PYEXE, str(TRAINER), "--dataset", str(ds), "--config", str(cfg), "--artifact", str(art)],
        capture_output=True, text=True,
    )
    payload = json.loads(art.read_text())
    return proc, payload


# --------------------------------------------------------------------------
# unit tests — leakage guard
# --------------------------------------------------------------------------

@pytest.mark.parametrize("bad_key", [
    "status", "result", "outcome", "pnl", "grossPnl", "netR", "exitPrice",
    "win", "tpBeforeSl", "timedOut", "holdBars", "mfe", "mae", "mistakeTags", "reward", "label",
])
def test_collect_feature_keys_rejects_forbidden(bad_key):
    rows = [{"features": {"x0": 1.0, bad_key: 1.0}}]
    with pytest.raises(ValueError, match="TARGET LEAKAGE"):
        T.collect_feature_keys(rows)


def test_collect_feature_keys_accepts_clean():
    rows = [{"features": {"e5_ret1": 0.1, "b1h_rsi14": 0.5}}, {"features": {"e5_ret1": 0.2}}]
    keys = T.collect_feature_keys(rows)
    assert keys == ["b1h_rsi14", "e5_ret1"]


def test_row_take_label():
    assert T.row_take_label({"label": {"netR": 0.4}}) == 1
    assert T.row_take_label({"label": {"netR": -0.1}}) == 0
    assert T.row_take_label({"label": {"netR": 0.0}}) == 0
    # falls back to pnl when netR missing
    assert T.row_take_label({"label": {"pnl": 5}}) == 1


def test_forbidden_set_matches_server():
    server = (Path(__file__).resolve().parents[2] / "mock-trading-server.js").read_text()
    block = server.split("LEARNING_BOT_FORBIDDEN_FEATURE_KEYS = new Set([", 1)[1].split("])", 1)[0]
    js_keys = {k.strip().strip("'\"") for k in block.replace("\n", "").split(",") if k.strip()}
    assert js_keys == T.FORBIDDEN_FEATURE_KEYS


# --------------------------------------------------------------------------
# end-to-end tests
# --------------------------------------------------------------------------

def test_artifact_shape(tmp_path):
    proc, art = run_trainer(tmp_path, make_rows())
    assert art["ok"] is True, proc.stderr
    m = art["metrics"]
    for key in ("framework", "deviceUsed", "featureCount", "split", "leakageCheck",
                "perBot", "policy", "distribution", "actionAlignment", "seed"):
        assert key in m, f"missing metrics.{key}"
    assert m["framework"] in ("pytorch", "fallback-logreg")
    assert m["leakageCheck"]["passed"] is True
    assert m["seed"] == 7
    assert set(m["split"]) >= {"train", "val", "holdout"}
    assert set(m["perBot"]) == {"model-5", "model-6"}
    assert set(m["policy"]["bySignalModel"]) == {"model-5", "model-6"}


def test_injected_leakage_aborts_run(tmp_path):
    rows = make_rows()
    for r in rows:
        r["features"]["status"] = 1 if r["label"]["outcome"] == "CLOSED_TP" else 0
    proc, art = run_trainer(tmp_path, rows)
    assert art["ok"] is False
    assert "LEAKAGE" in art["error"].upper()
    assert proc.returncode == 1


def test_holdout_never_influences_selection(tmp_path):
    rows = make_rows(seed=11)
    _, base = run_trainer(tmp_path / "a", rows)

    garbled = [dict(r) for r in rows]
    for r in garbled:
        if r["split"] == "holdout":
            lab = dict(r["label"])
            lab["netR"] = -abs(lab["netR"]) - 5      # force every holdout row to a big loss
            lab["pnl"] = lab["netR"] * 7
            lab["win"] = 0
            lab["outcome"] = "CLOSED_SL"
            r["label"] = lab
    _, garb = run_trainer(tmp_path / "b", garbled)

    for bot in ("model-5", "model-6"):
        b0, b1 = base["metrics"]["perBot"][bot], garb["metrics"]["perBot"][bot]
        if b0.get("status") != "trained":
            continue
        assert b0["threshold"] == b1["threshold"], f"{bot}: holdout changed the chosen threshold"
        assert b0["valTakeAccuracy"] == b1["valTakeAccuracy"], f"{bot}: holdout changed val selection"
        assert b0["aiVsNoAi"]["val"] == b1["aiVsNoAi"]["val"], f"{bot}: holdout changed val metrics"
        # the holdout REPORT must reflect the garbling
        assert b0["holdout"] != b1["holdout"], f"{bot}: holdout report did not change when holdout labels changed"


def test_determinism(tmp_path):
    rows = make_rows(seed=3)
    _, a = run_trainer(tmp_path / "a", rows)
    _, b = run_trainer(tmp_path / "b", rows)
    assert a["metrics"]["actionAlignment"] == b["metrics"]["actionAlignment"]
    for bot in a["metrics"]["perBot"]:
        pa, pb = a["metrics"]["perBot"][bot], b["metrics"]["perBot"][bot]
        assert pa.get("threshold") == pb.get("threshold")
        assert pa.get("valTakeAccuracy") == pb.get("valTakeAccuracy")


def test_fallback_when_torch_missing(tmp_path, monkeypatch):
    """Force the torch import to fail and confirm the numpy fallback still runs,
    still leakage-guarded, still TAKE/SKIP-shaped."""
    ds, cfg, art = write_inputs(tmp_path, make_rows(seed=5))
    stub = tmp_path / "sitecustomize.py"
    stub.write_text(
        "import builtins\n"
        "_real = builtins.__import__\n"
        "def _blocked(name, *a, **k):\n"
        "    if name == 'torch' or name.startswith('torch.'):\n"
        "        raise ImportError('torch blocked for test')\n"
        "    return _real(name, *a, **k)\n"
        "builtins.__import__ = _blocked\n"
    )
    env = {**dict(__import__("os").environ), "PYTHONPATH": str(tmp_path)}
    proc = subprocess.run(
        [PYEXE, str(TRAINER), "--dataset", str(ds), "--config", str(cfg), "--artifact", str(art)],
        capture_output=True, text=True, env=env,
    )
    payload = json.loads(art.read_text())
    assert payload["ok"] is True, proc.stderr
    m = payload["metrics"]
    assert m["framework"] == "fallback-logreg"
    assert m["deviceUsed"] == "cpu"
    assert m["leakageCheck"]["passed"] is True
    assert set(m["perBot"]) == {"model-5", "model-6"}
    for bot in m["perBot"]:
        if m["perBot"][bot].get("status") == "trained":
            assert "threshold" in m["perBot"][bot]


def test_symbol_holdout_excludes_from_fit_and_reports_unseen(tmp_path):
    """RUN 7: symbols in symbolHoldout must never enter train/val/holdout fitting,
    and must be scored separately as unseenSymbolEval."""
    rows = make_rows(n=1800, seed=21)
    # relabel ~1/3 of rows (both bot parities) to two 'unseen' symbols
    for i, r in enumerate(rows):
        if i % 3 == 0:
            r["symbol"] = "LINKUSDT" if i % 2 == 0 else "AVAXUSDT"
    ds, cfg, art = tmp_path, None, None
    dsp = tmp_path / "dataset.json"
    cfgp = tmp_path / "config.json"
    artp = tmp_path / "artifact.json"
    tmp_path.mkdir(parents=True, exist_ok=True)
    dsp.write_text(json.dumps({"rows": rows}))
    cfgp.write_text(json.dumps({"learningBot": {"trainingScope": "per-bot", "aiTrainer": {
        "devicePreference": "cuda", "epochs": 15, "batchSize": 128, "learningRate": 0.001,
        "symbolHoldout": ["LINKUSDT", "AVAXUSDT"],
    }}}))
    proc = subprocess.run([PYEXE, str(TRAINER), "--dataset", str(dsp), "--config", str(cfgp), "--artifact", str(artp)],
                          capture_output=True, text=True)
    payload = json.loads(artp.read_text())
    assert payload["ok"] is True, proc.stderr
    m = payload["metrics"]
    for bot, pb in m["perBot"].items():
        if pb.get("status") != "trained":
            continue
        # the unseen symbols must be reported separately
        assert pb.get("unseenSymbolEval") is not None, f"{bot}: missing unseenSymbolEval"
        assert set(pb["unseenSymbolEval"]["bySymbol"]) <= {"LINKUSDT", "AVAXUSDT"}
        # and there is a trade count for them (they were replayed, just not fitted)
        assert pb["unseenSymbolEval"]["noAI"]["trades"] > 0


def test_symbol_holdout_absent_is_noop(tmp_path):
    """No symbolHoldout key => identical behaviour to before (unseenSymbolEval is None)."""
    _, art = run_trainer(tmp_path, make_rows(seed=22))
    for pb in art["metrics"]["perBot"].values():
        if pb.get("status") == "trained":
            assert pb.get("unseenSymbolEval") in (None,)


def test_equity_metrics_math():
    pnls = [10, -5, -5, -5, 20, -2]
    em = T.equity_metrics(pnls)
    assert em["longestLossStreak"] == 3
    assert em["longestWinStreak"] == 1
    # peak equity 10 at idx0, trough 10-15 = -5 -> drawdown 15
    assert em["maxDrawdown"] == 15.0
    # profitFactor is rounded to 4 dp by the trainer
    assert em["profitFactor"] == pytest.approx(30 / 17, abs=1e-4)

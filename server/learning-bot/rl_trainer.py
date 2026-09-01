"""XeniosTrade Learning Bot trainer (v2).

Objective (per the 8-bot expansion brief):
  Each strategy bot proposes its own setup + direction. The AI does NOT learn to
  imitate BUY/SELL. It learns, per bot:

      TAKE vs SKIP           (binary head — "should this setup have been taken")
      P(win after costs)     (regression / prob head)
      P(TP before SL)        (regression / prob head)
      expected net R         (regression head)
      trade-quality score    (regression head, composite in [0, 1])

Hard rules enforced here:
  * Inputs come ONLY from row["features"] (entry-time, leakage-free). Every
    feature key is checked against a forbidden-outcome list at load; a hit aborts.
  * row["split"] is respected: fit on `train`, select the decision threshold on
    `val`, and NEVER let `holdout` influence anything — it is scored once at the
    end and reported separately.
  * Deterministic seed. Class weighting from data, no minority duplication.
  * CUDA when devicePreference=="cuda" and available; falls back to CPU, and to a
    numpy logistic model if torch is missing (still TAKE/SKIP-shaped, still
    leakage-guarded).

CLI + artifact keys are unchanged from v1: --dataset --config --artifact, and the
artifact is {ok, generatedAt, durationSeconds, metrics{...}} with metrics.framework,
metrics.deviceUsed, metrics.policy.{setupFamilyScores,bySignalModel} preserved.
"""

import argparse
import json
import math
import os
import random
import sys
import time
from pathlib import Path

SEED = 7

# Mirror of LEARNING_BOT_FORBIDDEN_FEATURE_KEYS in mock-trading-server.js — nothing
# known only after entry may reach the model input.
FORBIDDEN_FEATURE_KEYS = {
    "status", "result", "outcome", "pnl", "grossPnl", "netPnl", "netR", "netReturn",
    "exitPrice", "exitReason", "win", "tpBeforeSl", "timedOut", "holdBars", "holdHours",
    "mfe", "mae", "maxFavorableExcursion", "maxAdverseExcursion", "mistakeTags",
    "reward", "label", "closedAt", "closedDateKey", "tradeDuration",
}

FEE_SLIP_NOTE = "netR / netReturn in row.label already include fee + slippage."


def parse_args():
    parser = argparse.ArgumentParser(description="XeniosTrade Learning Bot trainer")
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--artifact", required=True)
    return parser.parse_args()


def read_json(path_str):
    with Path(path_str).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _sanitize(value):
    """Make a structure JSON-safe: numpy scalars -> python, non-finite -> None."""
    if isinstance(value, dict):
        return {k: _sanitize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_sanitize(v) for v in value]
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    # numpy scalar (bool_/int64/float64) — has .item()
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return _sanitize(item())
        except Exception:
            return str(value)
    return value


def write_json(path_str, value):
    path = Path(path_str)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(_sanitize(value), handle, indent=2)


# --------------------------------------------------------------------------
# data loading + leakage guard
# --------------------------------------------------------------------------

def load_v2_rows(dataset_artifact):
    rows = list(dataset_artifact.get("rows", []))
    v2 = []
    for r in rows:
        feats = r.get("features")
        if r.get("schemaVersion") == 2 and isinstance(feats, dict) and feats:
            v2.append(r)
    return v2


def collect_feature_keys(rows):
    keys = set()
    for r in rows:
        keys.update(r["features"].keys())
    forbidden_hit = sorted(k for k in keys if k in FORBIDDEN_FEATURE_KEYS)
    if forbidden_hit:
        raise ValueError(
            "TARGET LEAKAGE: forbidden outcome key(s) present in features: "
            + ", ".join(forbidden_hit)
        )
    return sorted(keys)


def row_take_label(row):
    """TAKE == 1 when the trade was net-profitable after costs."""
    label = row.get("label", {}) or {}
    net_r = label.get("netR")
    if net_r is None:
        return 1 if float(label.get("pnl", 0.0)) > 0 else 0
    return 1 if float(net_r) > 0 else 0


def row_targets(row):
    label = row.get("label", {}) or {}
    win = int(label.get("win", 1 if float(label.get("pnl", 0)) > 0 else 0))
    tp = int(label.get("tpBeforeSl", 0))
    net_r = float(label.get("netR", 0.0) or 0.0)
    net_r_clipped = max(-3.0, min(5.0, net_r))
    # composite quality in [0, 1]: blends the R outcome and whether TP came first
    quality = max(0.0, min(1.0, 0.5 + 0.12 * net_r_clipped)) * (0.7 + 0.3 * tp)
    quality = max(0.0, min(1.0, quality))
    return {
        "take": row_take_label(row),
        "win": win,
        "tp": tp,
        "r": net_r_clipped,
        "quality": quality,
    }


def build_matrix(rows, feature_keys):
    X = []
    T = {"take": [], "win": [], "tp": [], "r": [], "quality": []}
    meta = {"split": [], "bot": [], "regime": [], "symbol": [], "ts": [],
            "family": [], "netR": [], "pnl": [], "notional": []}
    for r in rows:
        feats = r["features"]
        X.append([float(feats.get(k, 0.0)) for k in feature_keys])
        tg = row_targets(r)
        for k in T:
            T[k].append(tg[k])
        label = r.get("label", {}) or {}
        meta["split"].append(r.get("split", "train"))
        meta["bot"].append(r.get("signalModelId", "unknown"))
        meta["regime"].append(r.get("marketRegime", "UNKNOWN"))
        meta["symbol"].append(r.get("symbol", "?"))
        meta["ts"].append(int(r.get("timestamp", 0) or 0))
        meta["family"].append(r.get("strategyFamily", "legacy"))
        meta["netR"].append(float(label.get("netR", 0.0) or 0.0))
        meta["pnl"].append(float(label.get("pnl", r.get("pnl", 0.0)) or 0.0))
        meta["notional"].append(float(r.get("notional", 0.0) or 0.0))
    return X, T, meta


# --------------------------------------------------------------------------
# metric helpers (no future data — operate on already-labelled rows)
# --------------------------------------------------------------------------

def equity_metrics(pnls):
    """Given a time-ordered list of per-trade net pnl, return dd / streaks / PF."""
    if not pnls:
        return {"maxDrawdown": 0.0, "longestWinStreak": 0, "longestLossStreak": 0,
                "profitFactor": 0.0, "sharpe": 0.0, "sortino": 0.0}
    equity = 0.0
    peak = 0.0
    max_dd = 0.0
    win_streak = loss_streak = best_win = best_loss = 0
    gross_win = gross_loss = 0.0
    for p in pnls:
        equity += p
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)
        if p > 0:
            win_streak += 1
            loss_streak = 0
            gross_win += p
        elif p < 0:
            loss_streak += 1
            win_streak = 0
            gross_loss += -p
        best_win = max(best_win, win_streak)
        best_loss = max(best_loss, loss_streak)
    mean_p = sum(pnls) / len(pnls)
    var = sum((p - mean_p) ** 2 for p in pnls) / len(pnls)
    std = math.sqrt(var) if var > 0 else 0.0
    downside = [p for p in pnls if p < 0]
    dstd = math.sqrt(sum(p * p for p in downside) / len(downside)) if downside else 0.0
    return {
        "maxDrawdown": round(max_dd, 4),
        "longestWinStreak": best_win,
        "longestLossStreak": best_loss,
        "profitFactor": round(gross_win / gross_loss, 4) if gross_loss > 0 else (float("inf") if gross_win > 0 else 0.0),
        "sharpe": round(mean_p / std * math.sqrt(len(pnls)), 4) if std > 0 else 0.0,
        "sortino": round(mean_p / dstd * math.sqrt(len(pnls)), 4) if dstd > 0 else 0.0,
    }


def strategy_metrics(idx, meta):
    """Aggregate outcome metrics over a set of row indices (already ordered)."""
    order = sorted(idx, key=lambda i: meta["ts"][i])
    pnls = [meta["pnl"][i] for i in order]
    rs = [meta["netR"][i] for i in order]
    n = len(order)
    wins = sum(1 for p in pnls if p > 0)
    eq = equity_metrics(pnls)
    rs_sorted = sorted(rs)
    return {
        "trades": n,
        "winRate": round(wins / n * 100, 2) if n else 0.0,
        "netPnl": round(sum(pnls), 2),
        "expectancy": round(sum(pnls) / n, 4) if n else 0.0,
        "avgR": round(sum(rs) / n, 4) if n else 0.0,
        "medianR": round(rs_sorted[n // 2], 4) if n else 0.0,
        **eq,
    }


# --------------------------------------------------------------------------
# torch model
# --------------------------------------------------------------------------

def train_with_torch(feature_keys, X, T, meta, trainer_config):
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    import torch
    from torch import nn

    random.seed(SEED)
    torch.manual_seed(SEED)
    try:
        torch.use_deterministic_algorithms(True, warn_only=True)
    except Exception:
        pass

    device_pref = trainer_config.get("devicePreference", "cuda")
    use_cuda = device_pref == "cuda" and torch.cuda.is_available()
    device = torch.device("cuda" if use_cuda else "cpu")
    device_name = torch.cuda.get_device_name(0) if use_cuda else "cpu"

    epochs = int(trainer_config.get("epochs", 60))
    lr = float(trainer_config.get("learningRate", 0.0008))
    batch = int(trainer_config.get("batchSize", 256))

    import numpy as np
    Xa = np.asarray(X, dtype=np.float64)
    take = np.asarray(T["take"], dtype=np.float64)
    win = np.asarray(T["win"], dtype=np.float64)
    tp = np.asarray(T["tp"], dtype=np.float64)
    rr = np.asarray(T["r"], dtype=np.float64)
    qq = np.asarray(T["quality"], dtype=np.float64)
    split = np.asarray(meta["split"])
    bot = np.asarray(meta["bot"])
    sym = np.asarray(meta["symbol"])

    # RUN 7 — true unseen-symbol generalization. These symbols are excluded from
    # ALL fitting / threshold / model selection, then scored separately.
    symbol_holdout = set(str(s).upper() for s in trainer_config.get("symbolHoldout", []) or [])
    fit_ok = ~np.isin(sym, list(symbol_holdout)) if symbol_holdout else np.ones(len(sym), dtype=bool)

    bots = sorted(set(meta["bot"]))
    per_bot = {}
    global_val_acc = []
    ai_vs_noai_holdout = {}
    artifact_dir = Path(trainer_config.get("_artifactDir", ".")) / "models"

    for b in bots:
        b_mask = bot == b
        tr = np.where(b_mask & fit_ok & (split == "train"))[0]
        va = np.where(b_mask & fit_ok & (split == "val"))[0]
        ho = np.where(b_mask & fit_ok & (split == "holdout"))[0]
        if len(tr) < 60 or len(va) < 15:
            per_bot[b] = {"status": "insufficient-data",
                          "counts": {"train": int(len(tr)), "val": int(len(va)), "holdout": int(len(ho))}}
            continue

        mean = Xa[tr].mean(axis=0)
        std = Xa[tr].std(axis=0)
        std[std < 1e-8] = 1.0

        def norm(ix):
            return torch.tensor((Xa[ix] - mean) / std, dtype=torch.float32, device=device)

        Xtr, Xva, Xho = norm(tr), norm(va), (norm(ho) if len(ho) else None)
        take_tr = torch.tensor(take[tr], dtype=torch.float32, device=device)
        take_va = torch.tensor(take[va], dtype=torch.float32, device=device)

        pos = float(take[tr].sum())
        neg = float(len(tr) - pos)
        pos_weight = torch.tensor([neg / pos if pos > 0 else 1.0], device=device).clamp(0.2, 5.0)

        d = Xtr.shape[1]
        trunk = nn.Sequential(
            nn.Linear(d, 96), nn.ReLU(), nn.Dropout(0.10),
            nn.Linear(96, 64), nn.ReLU(),
        ).to(device)
        head_take = nn.Linear(64, 1).to(device)
        head_win = nn.Linear(64, 1).to(device)
        head_tp = nn.Linear(64, 1).to(device)
        head_r = nn.Linear(64, 1).to(device)
        head_q = nn.Linear(64, 1).to(device)
        params = list(trunk.parameters())
        for h in (head_take, head_win, head_tp, head_r, head_q):
            params += list(h.parameters())
        opt = torch.optim.Adam(params, lr=lr, weight_decay=1e-5)
        bce = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
        bce_plain = nn.BCEWithLogitsLoss()
        mse = nn.MSELoss()

        y_win = torch.tensor(win[tr], dtype=torch.float32, device=device)
        y_tp = torch.tensor(tp[tr], dtype=torch.float32, device=device)
        y_r = torch.tensor(rr[tr], dtype=torch.float32, device=device)
        y_q = torch.tensor(qq[tr], dtype=torch.float32, device=device)

        n = Xtr.shape[0]
        best_val = float("inf")
        best_state = None
        patience = 12
        since_best = 0
        for epoch in range(epochs):
            trunk.train()
            perm = torch.randperm(n, device=device)
            for s in range(0, n, batch):
                bi = perm[s:s + batch]
                z = trunk(Xtr[bi])
                loss = (
                    bce(head_take(z).squeeze(1), take_tr[bi])
                    + 0.6 * bce_plain(head_win(z).squeeze(1), y_win[bi])
                    + 0.6 * bce_plain(head_tp(z).squeeze(1), y_tp[bi])
                    + 0.3 * mse(head_r(z).squeeze(1), y_r[bi])
                    + 0.3 * mse(head_q(z).squeeze(1), y_q[bi])
                )
                opt.zero_grad()
                loss.backward()
                opt.step()
            trunk.eval()
            with torch.no_grad():
                zv = trunk(Xva)
                vloss = bce_plain(head_take(zv).squeeze(1), take_va).item()
            if vloss < best_val - 1e-4:
                best_val = vloss
                best_state = {
                    "trunk": {k: v.detach().cpu().clone() for k, v in trunk.state_dict().items()},
                    "take": {k: v.detach().cpu().clone() for k, v in head_take.state_dict().items()},
                    "win": {k: v.detach().cpu().clone() for k, v in head_win.state_dict().items()},
                    "tp": {k: v.detach().cpu().clone() for k, v in head_tp.state_dict().items()},
                    "r": {k: v.detach().cpu().clone() for k, v in head_r.state_dict().items()},
                    "q": {k: v.detach().cpu().clone() for k, v in head_q.state_dict().items()},
                }
                since_best = 0
            else:
                since_best += 1
                if since_best >= patience:
                    break

        if best_state is not None:
            trunk.load_state_dict(best_state["trunk"])
            head_take.load_state_dict(best_state["take"])
            head_win.load_state_dict(best_state["win"])
            head_tp.load_state_dict(best_state["tp"])
            head_r.load_state_dict(best_state["r"])
            head_q.load_state_dict(best_state["q"])

        trunk.eval()
        with torch.no_grad():
            p_va = torch.sigmoid(head_take(trunk(Xva)).squeeze(1)).cpu().numpy()
            p_ho = (torch.sigmoid(head_take(trunk(Xho)).squeeze(1)).cpu().numpy()
                    if Xho is not None else np.array([]))

        # --- choose the TAKE threshold on VAL only ---
        thresholds = [round(0.30 + 0.05 * k, 2) for k in range(10)]
        no_ai_val = strategy_metrics(list(va), meta)
        best_thr = 0.0
        best_obj = no_ai_val["expectancy"]
        best_ai_val = no_ai_val
        for thr in thresholds:
            keep = va[p_va >= thr]
            if len(keep) < max(10, int(0.35 * len(va))):
                continue
            m = strategy_metrics(list(keep), meta)
            obj = m["expectancy"]
            if obj > best_obj and m["profitFactor"] >= no_ai_val["profitFactor"]:
                best_obj = obj
                best_thr = float(thr)
                best_ai_val = m
        val_acc = float(((p_va >= max(best_thr, 0.5)).astype(float) == take[va]).mean() * 100)
        global_val_acc.append(val_acc)

        # --- holdout: score once with the val-chosen threshold, never tune on it ---
        no_ai_ho = strategy_metrics(list(ho), meta) if len(ho) else {}
        ai_ho = {}
        if len(ho):
            keep_ho = ho[p_ho >= best_thr] if best_thr > 0 else ho
            ai_ho = strategy_metrics(list(keep_ho), meta)
        ai_vs_noai_holdout[b] = {"noAI": no_ai_ho, "withAI": ai_ho, "threshold": best_thr}

        # persist the model (gitignored dir)
        model_path = None
        try:
            artifact_dir.mkdir(parents=True, exist_ok=True)
            model_path = str(artifact_dir / f"{b}.pt")
            torch.save({
                "feature_keys": feature_keys,
                "mean": mean.tolist(),
                "std": std.tolist(),
                "threshold": best_thr,
                "trunk": trunk.state_dict(),
                "head_take": head_take.state_dict(),
                "head_win": head_win.state_dict(),
                "head_tp": head_tp.state_dict(),
                "head_r": head_r.state_dict(),
                "head_q": head_q.state_dict(),
            }, model_path)
        except Exception as exc:  # pragma: no cover
            model_path = f"save-failed: {exc}"

        # --- unseen-symbol evaluation (RUN 7): score on the held-out symbols only ---
        unseen_eval = None
        if symbol_holdout:
            un = np.where(b_mask & np.isin(sym, list(symbol_holdout)))[0]
            if len(un):
                with torch.no_grad():
                    p_un = torch.sigmoid(head_take(trunk(norm(un))).squeeze(1)).cpu().numpy()
                no_ai_un = strategy_metrics(list(un), meta)
                keep_un = un[p_un >= best_thr] if best_thr > 0 else un
                ai_un = strategy_metrics(list(keep_un), meta)
                by_symbol = {}
                for s in sorted(symbol_holdout):
                    si = np.where(b_mask & (sym == s))[0]
                    if len(si):
                        p_si = p_un[np.searchsorted(un, si)]  # si is a subset of the sorted `un`
                        keep_si = si[p_si >= best_thr] if best_thr > 0 else si
                        by_symbol[s] = {
                            "noAI": strategy_metrics(list(si), meta),
                            "withAI": strategy_metrics(list(keep_si), meta),
                        }
                unseen_eval = {"noAI": no_ai_un, "withAI": ai_un, "threshold": best_thr, "bySymbol": by_symbol}

        per_bot[b] = {
            "status": "trained",
            "counts": {"train": int(len(tr)), "val": int(len(va)), "holdout": int(len(ho))},
            "valTakeBCE": round(best_val, 5),
            "valTakeAccuracy": round(val_acc, 2),
            "threshold": best_thr,
            "aiUseful": best_thr > 0.0,
            "aiVsNoAi": {"val": {"noAI": no_ai_val, "withAI": best_ai_val}},
            "holdout": {"noAI": no_ai_ho, "withAI": ai_ho},
            "unseenSymbolEval": unseen_eval,
            "modelPath": model_path,
            "device": device_name,
        }

    return {
        "framework": "pytorch",
        "deviceUsed": ("cuda:" + device_name) if use_cuda else "cpu",
        "device": device_name,
        "epochs": epochs,
        "batchSize": batch,
        "learningRate": lr,
        "actionAlignment": round(sum(global_val_acc) / len(global_val_acc), 2) if global_val_acc else 0.0,
        "perBot": per_bot,
        "aiVsNoAiHoldout": ai_vs_noai_holdout,
    }


# --------------------------------------------------------------------------
# numpy fallback (no torch) — logistic TAKE head only, same eval harness
# --------------------------------------------------------------------------

def train_fallback(feature_keys, X, T, meta, trainer_config):
    import numpy as np

    rng = np.random.default_rng(SEED)
    Xa = np.asarray(X, dtype=np.float64)
    take = np.asarray(T["take"], dtype=np.float64)
    split = np.asarray(meta["split"])
    bot = np.asarray(meta["bot"])
    sym = np.asarray(meta["symbol"])
    symbol_holdout = set(str(s).upper() for s in trainer_config.get("symbolHoldout", []) or [])
    fit_ok = ~np.isin(sym, list(symbol_holdout)) if symbol_holdout else np.ones(len(sym), dtype=bool)
    bots = sorted(set(meta["bot"]))
    per_bot = {}
    accs = []

    for b in bots:
        m = bot == b
        tr = np.where(m & fit_ok & (split == "train"))[0]
        va = np.where(m & fit_ok & (split == "val"))[0]
        ho = np.where(m & fit_ok & (split == "holdout"))[0]
        if len(tr) < 60 or len(va) < 15:
            per_bot[b] = {"status": "insufficient-data",
                          "counts": {"train": int(len(tr)), "val": int(len(va)), "holdout": int(len(ho))}}
            continue
        mean = Xa[tr].mean(axis=0)
        std = Xa[tr].std(axis=0)
        std[std < 1e-8] = 1.0
        Xtr = (Xa[tr] - mean) / std
        Xva = (Xa[va] - mean) / std
        w = np.zeros(Xtr.shape[1])
        b0 = 0.0
        lr = 0.05
        ytr = take[tr]
        for _ in range(400):
            z = Xtr @ w + b0
            p = 1.0 / (1.0 + np.exp(-z))
            g = p - ytr
            w -= lr * (Xtr.T @ g / len(tr) + 1e-4 * w)
            b0 -= lr * g.mean()
        pva = 1.0 / (1.0 + np.exp(-(Xva @ w + b0)))
        thresholds = [round(0.30 + 0.05 * k, 2) for k in range(10)]
        no_ai = strategy_metrics(list(va), meta)
        best_thr, best_obj, best_ai = 0.0, no_ai["expectancy"], no_ai
        for thr in thresholds:
            keep = va[pva >= thr]
            if len(keep) < max(10, int(0.35 * len(va))):
                continue
            mm = strategy_metrics(list(keep), meta)
            if mm["expectancy"] > best_obj and mm["profitFactor"] >= no_ai["profitFactor"]:
                best_obj, best_thr, best_ai = mm["expectancy"], float(thr), mm
        acc = float(((pva >= max(best_thr, 0.5)).astype(float) == take[va]).mean() * 100)
        accs.append(acc)
        per_bot[b] = {
            "status": "trained",
            "counts": {"train": int(len(tr)), "val": int(len(va)), "holdout": int(len(ho))},
            "valTakeAccuracy": round(acc, 2),
            "threshold": best_thr,
            "aiUseful": best_thr > 0.0,
            "aiVsNoAi": {"val": {"noAI": no_ai, "withAI": best_ai}},
        }

    return {
        "framework": "fallback-logreg",
        "deviceUsed": "cpu",
        "actionAlignment": round(sum(accs) / len(accs), 2) if accs else 0.0,
        "perBot": per_bot,
        "note": "PyTorch unavailable — numpy logistic TAKE/SKIP model per bot (still leakage-guarded).",
    }


# --------------------------------------------------------------------------
# backward-compatible policy (leakage-safe: train+val only, never holdout)
# --------------------------------------------------------------------------

def build_policy(rows):
    def bucket():
        return {"count": 0, "rewardTotal": 0.0, "qualityTotal": 0.0, "wins": 0}

    overall = {}
    by_model = {}
    for r in rows:
        if r.get("split") == "holdout":
            continue
        fam = r.get("setupFamily", "Unclassified")
        model_id = r.get("signalModelId", "unknown")
        label = r.get("label", {}) or {}
        reward = float(label.get("netR", r.get("reward", 0.0)) or 0.0)
        quality = float(r.get("entryQualityScore", 0.0) or 0.0)
        win = 1 if float(label.get("pnl", r.get("pnl", 0.0)) or 0.0) > 0 else 0

        for target in (overall, by_model.setdefault(model_id, {})):
            e = target.setdefault(fam, bucket())
            e["count"] += 1
            e["rewardTotal"] += reward
            e["qualityTotal"] += quality
            e["wins"] += win

    def render(b):
        return {
            fam: {
                "count": v["count"],
                "avgReward": round(v["rewardTotal"] / v["count"], 4),
                "avgEntryQuality": round(v["qualityTotal"] / v["count"], 2),
                "winRate": round(v["wins"] / v["count"] * 100, 2),
            }
            for fam, v in b.items()
        }

    return {
        "setupFamilyScores": render(overall),
        "bySignalModel": {mid: {"setupFamilyScores": render(b)} for mid, b in by_model.items()},
    }


def distribution_report(rows):
    by_bot, by_symbol, by_regime, by_split, by_family = {}, {}, {}, {}, {}
    for r in rows:
        by_bot[r.get("signalModelId", "?")] = by_bot.get(r.get("signalModelId", "?"), 0) + 1
        by_symbol[r.get("symbol", "?")] = by_symbol.get(r.get("symbol", "?"), 0) + 1
        by_regime[r.get("marketRegime", "?")] = by_regime.get(r.get("marketRegime", "?"), 0) + 1
        by_split[r.get("split", "?")] = by_split.get(r.get("split", "?"), 0) + 1
        by_family[r.get("strategyFamily", "?")] = by_family.get(r.get("strategyFamily", "?"), 0) + 1
    return {"byBot": by_bot, "bySymbol": by_symbol, "byRegime": by_regime,
            "bySplit": by_split, "byFamily": by_family}


# --------------------------------------------------------------------------

def main():
    args = parse_args()
    started = time.time()
    try:
        dataset_artifact = read_json(args.dataset)
        config_artifact = read_json(args.config)
        learning_bot = dict(config_artifact.get("learningBot", {}))
        trainer_config = dict(learning_bot.get("aiTrainer", {}))
        trainer_config["_artifactDir"] = str(Path(args.artifact).parent)

        rows = load_v2_rows(dataset_artifact)
        legacy_count = len(dataset_artifact.get("rows", [])) - len(rows)
        if len(rows) < 50:
            raise ValueError(
                f"Only {len(rows)} v2 (feature-vector) rows — need >= 50. "
                f"({legacy_count} legacy rows without features were skipped.)"
            )

        feature_keys = collect_feature_keys(rows)  # raises on leakage
        X, T, meta = build_matrix(rows, feature_keys)

        try:
            core = train_with_torch(feature_keys, X, T, meta, trainer_config)
        except ImportError:
            core = train_fallback(feature_keys, X, T, meta, trainer_config)
        except Exception as exc:
            core = train_fallback(feature_keys, X, T, meta, trainer_config)
            core["torchError"] = str(exc)

        split_counts = {"train": 0, "val": 0, "holdout": 0}
        for s in meta["split"]:
            split_counts[s] = split_counts.get(s, 0) + 1

        metrics = {
            **core,
            "algorithm": "take-skip-mlp",
            "trainingScope": learning_bot.get("trainingScope", "per-bot"),
            "seed": SEED,
            "rows": len(rows),
            "legacyRowsSkipped": legacy_count,
            "featureCount": len(feature_keys),
            "featureVersion": rows[0].get("featureVersion", "unknown"),
            "split": split_counts,
            "leakageCheck": {
                "forbiddenKeyList": sorted(FORBIDDEN_FEATURE_KEYS),
                "featureKeysChecked": len(feature_keys),
                "passed": True,
                "note": FEE_SLIP_NOTE,
            },
            "distribution": distribution_report(rows),
            "policy": build_policy(rows),
        }

        artifact = {
            "ok": True,
            "generatedAt": int(time.time() * 1000),
            "durationSeconds": round(time.time() - started, 3),
            "metrics": metrics,
        }
        write_json(args.artifact, artifact)
        sys.stdout.write(json.dumps({"ok": True, "framework": metrics.get("framework"),
                                     "deviceUsed": metrics.get("deviceUsed"),
                                     "rows": len(rows), "featureCount": len(feature_keys)}))
        return 0
    except Exception as error:
        artifact = {
            "ok": False,
            "generatedAt": int(time.time() * 1000),
            "durationSeconds": round(time.time() - started, 3),
            "error": str(error),
        }
        write_json(args.artifact, artifact)
        sys.stderr.write(str(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

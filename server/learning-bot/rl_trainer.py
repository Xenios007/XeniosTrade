import argparse
import json
import math
import random
import sys
import time
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="XeniosTrade Learning Bot trainer")
    parser.add_argument("--dataset", required=True, help="Path to the exported dataset JSON file")
    parser.add_argument("--config", required=True, help="Path to the trainer config JSON file")
    parser.add_argument("--artifact", required=True, help="Path where training artifacts should be written")
    return parser.parse_args()


def read_json(path_str):
    path = Path(path_str)
    with path.open("r", encoding="utf-8") as handle:
      return json.load(handle)


def write_json(path_str, value):
    path = Path(path_str)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
      json.dump(value, handle, indent=2)


def build_state_vector(row):
    return [
        float(1.0 if row.get("side") == "BUY" else 0.0),
        float(row.get("entryQualityScore", 0)) / 100.0,
        float(row.get("configuredStopLossPercent", 0)) / 10.0,
        float(row.get("leverage", 0)) / 25.0,
        float(len(row.get("mistakeTags", []))) / 10.0,
        float(1.0 if row.get("status") == "CLOSED_TP" else 0.0),
        float(1.0 if row.get("status") == "CLOSED_SL" else 0.0),
    ]


def build_reward(row, reward_mode):
    pnl = float(row.get("pnl", 0.0))
    risk_penalty = abs(float(row.get("configuredStopLossPercent", 0.0))) * 0.25
    quality_bonus = float(row.get("entryQualityScore", 0.0)) * 0.01

    if reward_mode == "pnl-only":
        return pnl

    return pnl - risk_penalty + quality_bonus


def simple_fallback_training(rows, trainer_config):
    reward_mode = trainer_config.get("rewardMode", "pnl-risk")
    rewards = [build_reward(row, reward_mode) for row in rows]
    avg_reward = sum(rewards) / len(rewards) if rewards else 0.0
    win_count = sum(1 for row in rows if float(row.get("pnl", 0)) > 0)
    loss_count = sum(1 for row in rows if float(row.get("pnl", 0)) < 0)

    setup_family_scores = {}
    by_signal_model = {}
    for row in rows:
        family = row.get("setupFamily", "Unclassified")
        reward = build_reward(row, reward_mode)
        model_id = row.get("signalModelId", "unknown")

        def update_bucket(bucket):
            entry = bucket.setdefault(family, {
                "count": 0,
                "rewardTotal": 0.0,
                "qualityTotal": 0.0,
                "wins": 0,
            })
            entry["count"] += 1
            entry["rewardTotal"] += reward
            entry["qualityTotal"] += float(row.get("entryQualityScore", 0.0))
            if float(row.get("pnl", 0.0)) > 0:
                entry["wins"] += 1

        update_bucket(setup_family_scores)
        update_bucket(by_signal_model.setdefault(model_id, {}))

    policy = {
        "setupFamilyScores": {
            family: {
                "count": values["count"],
                "avgReward": round(values["rewardTotal"] / values["count"], 4),
                "avgEntryQuality": round(values["qualityTotal"] / values["count"], 2),
                "winRate": round((values["wins"] / values["count"]) * 100.0, 2),
            }
            for family, values in setup_family_scores.items()
        },
        "bySignalModel": {
            model_id: {
                "setupFamilyScores": {
                    family: {
                        "count": values["count"],
                        "avgReward": round(values["rewardTotal"] / values["count"], 4),
                        "avgEntryQuality": round(values["qualityTotal"] / values["count"], 2),
                        "winRate": round((values["wins"] / values["count"]) * 100.0, 2),
                    }
                    for family, values in family_scores.items()
                }
            }
            for model_id, family_scores in by_signal_model.items()
        },
    }

    return {
        "framework": "fallback",
        "algorithm": trainer_config.get("algorithm", "dqn"),
        "epochs": int(trainer_config.get("epochs", 0)),
        "batchSize": int(trainer_config.get("batchSize", 0)),
        "deviceUsed": "cpu",
        "rewardMean": round(avg_reward, 4),
        "rewardStd": round(
            math.sqrt(sum((reward - avg_reward) ** 2 for reward in rewards) / len(rewards)),
            4,
        ) if rewards else 0.0,
        "winRate": round((win_count / len(rows)) * 100, 2) if rows else 0.0,
        "lossRate": round((loss_count / len(rows)) * 100, 2) if rows else 0.0,
        "rows": len(rows),
        "note": "PyTorch was not available, so the trainer produced a dataset-level baseline summary instead of a neural-policy run.",
        "policy": policy,
    }


def train_with_pytorch(rows, trainer_config):
    import torch
    from torch import nn

    random.seed(7)
    torch.manual_seed(7)

    states = torch.tensor([build_state_vector(row) for row in rows], dtype=torch.float32)
    rewards = torch.tensor(
        [build_reward(row, trainer_config.get("rewardMode", "pnl-risk")) for row in rows],
        dtype=torch.float32,
    ).unsqueeze(1)
    actions = torch.tensor(
        [0 if row.get("side") == "BUY" else 1 for row in rows],
        dtype=torch.long,
    )

    device_preference = trainer_config.get("devicePreference", "cuda")
    use_cuda = device_preference == "cuda" and torch.cuda.is_available()
    device = torch.device("cuda" if use_cuda else "cpu")
    states = states.to(device)
    rewards = rewards.to(device)
    actions = actions.to(device)

    model = nn.Sequential(
        nn.Linear(states.shape[1], 64),
        nn.ReLU(),
        nn.Linear(64, 64),
        nn.ReLU(),
        nn.Linear(64, 2),
    ).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=float(trainer_config.get("learningRate", 0.0005)))

    epochs = int(trainer_config.get("epochs", 20))
    last_loss = None

    for _ in range(epochs):
        logits = model(states)
        selected_action_values = logits.gather(1, actions.unsqueeze(1))
        loss = torch.mean((selected_action_values - rewards) ** 2)
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
        last_loss = float(loss.detach().cpu().item())

    with torch.no_grad():
        logits = model(states)
        predicted_actions = torch.argmax(logits, dim=1)
        action_alignment = float((predicted_actions == actions).float().mean().cpu().item()) * 100.0

    setup_family_scores = {}
    by_signal_model = {}
    for row, reward in zip(rows, [build_reward(row, trainer_config.get("rewardMode", "pnl-risk")) for row in rows]):
        family = row.get("setupFamily", "Unclassified")
        model_id = row.get("signalModelId", "unknown")

        def update_bucket(bucket):
            entry = bucket.setdefault(family, {
                "count": 0,
                "rewardTotal": 0.0,
                "qualityTotal": 0.0,
                "wins": 0,
            })
            entry["count"] += 1
            entry["rewardTotal"] += reward
            entry["qualityTotal"] += float(row.get("entryQualityScore", 0.0))
            if float(row.get("pnl", 0.0)) > 0:
                entry["wins"] += 1

        update_bucket(setup_family_scores)
        update_bucket(by_signal_model.setdefault(model_id, {}))

    policy = {
        "setupFamilyScores": {
            family: {
                "count": values["count"],
                "avgReward": round(values["rewardTotal"] / values["count"], 4),
                "avgEntryQuality": round(values["qualityTotal"] / values["count"], 2),
                "winRate": round((values["wins"] / values["count"]) * 100.0, 2),
            }
            for family, values in setup_family_scores.items()
        },
        "bySignalModel": {
            model_id: {
                "setupFamilyScores": {
                    family: {
                        "count": values["count"],
                        "avgReward": round(values["rewardTotal"] / values["count"], 4),
                        "avgEntryQuality": round(values["qualityTotal"] / values["count"], 2),
                        "winRate": round((values["wins"] / values["count"]) * 100.0, 2),
                    }
                    for family, values in family_scores.items()
                }
            }
            for model_id, family_scores in by_signal_model.items()
        },
    }

    return {
        "framework": "pytorch",
        "algorithm": trainer_config.get("algorithm", "dqn"),
        "epochs": epochs,
        "batchSize": int(trainer_config.get("batchSize", 64)),
        "deviceUsed": str(device),
        "finalLoss": round(last_loss or 0.0, 6),
        "actionAlignment": round(action_alignment, 2),
        "rows": len(rows),
        "policy": policy,
    }


def main():
    args = parse_args()
    started_at = time.time()

    try:
        dataset_artifact = read_json(args.dataset)
        config_artifact = read_json(args.config)
        rows = list(dataset_artifact.get("rows", []))
        learning_bot = dict(config_artifact.get("learningBot", {}))
        trainer_config = dict(learning_bot.get("aiTrainer", {}))

        if not rows:
            raise ValueError("Training dataset is empty.")

        try:
            metrics = train_with_pytorch(rows, trainer_config)
        except Exception as error:
            metrics = simple_fallback_training(rows, trainer_config)
            metrics["fallbackReason"] = str(error)

        artifact = {
            "ok": True,
            "generatedAt": int(time.time() * 1000),
            "durationSeconds": round(time.time() - started_at, 3),
            "metrics": metrics,
        }
        write_json(args.artifact, artifact)
        sys.stdout.write(json.dumps(artifact))
        return 0
    except Exception as error:
        artifact = {
            "ok": False,
            "generatedAt": int(time.time() * 1000),
            "durationSeconds": round(time.time() - started_at, 3),
            "error": str(error),
        }
        write_json(args.artifact, artifact)
        sys.stderr.write(str(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

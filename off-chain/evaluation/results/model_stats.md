# Model statistics

`python -m evaluation.model_stats`

```json
{
  "test_rows": 9921,
  "test_accounts": 294,
  "test_positive_rate": 0.0722,
  "deployed_model": {
    "roc_auc": 0.921,
    "avg_precision": 0.493,
    "precision": 0.416,
    "recall": 0.661,
    "ci95": {
      "roc_auc": [
        0.896,
        0.943
      ],
      "avg_precision": [
        0.395,
        0.594
      ],
      "precision": [
        0.323,
        0.504
      ],
      "recall": [
        0.571,
        0.747
      ]
    }
  },
  "baseline_utilization": {
    "roc_auc": 0.912,
    "avg_precision": 0.418,
    "precision": 0.453,
    "recall": 0.453
  },
  "baseline_logistic": {
    "roc_auc": 0.92,
    "avg_precision": 0.49,
    "precision": 0.39,
    "recall": 0.665
  },
  "cuts": {
    "0.5": {
      "precision": 0.416,
      "recall": 0.661
    },
    "0.6": {
      "precision": 0.474,
      "recall": 0.501
    },
    "0.7": {
      "precision": 0.582,
      "recall": 0.334
    },
    "0.8": {
      "precision": 0.725,
      "recall": 0.191
    },
    "0.9": {
      "precision": 0.8,
      "recall": 0.017
    }
  },
  "temporal": {
    "split_date": "2022-06-28",
    "train_rows": 30488,
    "test_rows": 9563,
    "test_accounts": 284,
    "test_positive_rate": 0.0527,
    "roc_auc": 0.867,
    "avg_precision": 0.3,
    "precision": 0.207,
    "recall": 0.837,
    "ci95": {
      "roc_auc": [
        0.816,
        0.907
      ],
      "avg_precision": [
        0.208,
        0.398
      ],
      "precision": [
        0.157,
        0.263
      ],
      "recall": [
        0.758,
        0.905
      ]
    },
    "baseline_utilization_auc": 0.89
  }
}
```

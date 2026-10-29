// The risk model, run in the browser: the same 5-8-1 MLP the Tier-2 circuit
// is compiled from (weights exported by off-chain/scripts/export_model_js.py,
// checked against ONNX by off-chain/tests/test_export_model.py).
import W from "./model.json";

export const MODEL_HASH = W.model_hash;
export const MODEL_VERSION = W.model_version;

/** P(high risk) for the quantized on-chain features q (integers in [0, 1024]). */
export function pHigh(q) {
  const x = q.map((v) => v / 1024);
  let z = W.b2;
  for (let j = 0; j < W.b1.length; j++) {
    let h = W.b1[j];
    for (let i = 0; i < 5; i++) h += x[i] * W.W1[i][j];
    if (h > 0) z += h * W.W2[j];
  }
  z = Math.max(-W.logit_clip, Math.min(W.logit_clip, z));
  return 1 / (1 + Math.exp(-z));
}

export function predict(q) {
  const p = pHigh(q);
  return { label: p > 0.5 ? 1 : 0, probs: [1 - p, p] };
}

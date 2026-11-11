# One-command reproduction of every result in the paper.
#
#   make reproduce        install, rebuild the proving key, run all tests and
#                         static analysis, re-measure gas, regenerate every
#                         evaluation, and report whether the regenerated
#                         results match the committed ones
#   make test | analyze | gas | results | results-proving | paper | demo
#
# Or, with nothing but Docker installed:
#   docker build -t trusttier . && docker run --rm trusttier
#
# Compiles with the solc npm package (no compiler download), so it also works
# offline once dependencies are installed.

SHELL := /bin/bash
PYTHON ?= python3
VENV ?= .venv
PY = $(abspath $(VENV))/bin/python
# Slither needs web3 7 while the router pins web3 6: analysis tools get their own venv.
TOOLS ?= .venv-tools
export HARDHAT_LOCAL_SOLC ?= 1

# Results that depend only on code and data (timing-based ones are excluded
# from the comparison: prover_pool, liquidator_race, concurrency traces).
DETERMINISTIC := gas_measurements.json evaluation_report.json hf_baseline.json bond_economics.json \
                 band_sensitivity.json outcome_labels.json

.PHONY: reproduce install keys test analyze gas results results-proving compare paper demo clean

reproduce: install keys test analyze gas results compare

install:
	npm ci --no-audit --no-fund
	test -d $(VENV) || $(PYTHON) -m venv $(VENV)
	$(PY) -m pip install -q --upgrade pip
	$(PY) -m pip install -q -r off-chain/requirements.txt -r circuits/requirements.txt pytest
	test -d $(TOOLS) || $(PYTHON) -m venv $(TOOLS)
	$(abspath $(TOOLS))/bin/python -m pip install -q slither-analyzer==0.11.6

keys:
	test -f circuits/pk.key || (cd circuits && $(PY) make_proving_key.py)

test:
	npx hardhat test
	cd off-chain && TRUSTTIER_INDEXER=0 TRUSTTIER_DB=:memory: $(PY) -m pytest tests -q

analyze:
	npx hardhat compile
	$(abspath $(TOOLS))/bin/slither .
	@if command -v echidna >/dev/null; then \
	  PATH="$(abspath $(TOOLS))/bin:$$PATH" echidna . --contract EngineInvariants --config echidna.yaml --test-limit 50000 --format text | tail -12; \
	else echo "echidna not installed: skipping fuzzing (the Docker image has it)"; fi

gas:
	@mkdir -p .reproduce
	npx hardhat run scripts/measure_gas.js | grep -v "injected env" > .reproduce/gas_measurements.json
	cp .reproduce/gas_measurements.json off-chain/evaluation/results/gas_measurements.json

results:
	cd off-chain && for m in evaluate hf_baseline bond_economics band_sensitivity outcome_labels concurrency_sim concurrency_ablation; do \
	  echo "== evaluation.$$m"; $(PY) -m evaluation.$$m > /dev/null || exit 1; done
	cp off-chain/evaluation/results/band_sensitivity.tex docs/paper/figures/band_sensitivity.tex

# Real EZKL proofs: several minutes and ~2 GB of RAM per worker.
results-proving: keys
	cd off-chain && $(PY) -m evaluation.prover_pool --proofs 12

compare:
	@echo "== regenerated results vs the committed ones"
	@status=0; for f in $(DETERMINISTIC); do \
	  if git diff --quiet -- off-chain/evaluation/results/$$f 2>/dev/null; then echo "  same      $$f"; \
	  else echo "  CHANGED   $$f"; status=1; fi; done; \
	if [ $$status = 0 ]; then echo "All deterministic results reproduce exactly."; \
	else echo "Some results differ: see git diff off-chain/evaluation/results"; fi

paper:
	cd docs/paper && latexmk -pdf -interaction=nonstopmode main.tex

# Local demo: chain + contracts + router + DApp (Ctrl-C to stop).
demo:
	npx hardhat node & sleep 6; \
	VERIFIER_MODE=real npx hardhat run scripts/deploy.js --network localhost; \
	(cd off-chain && $(PY) -m uvicorn main:app --port 8000) & \
	(cd frontend && npm ci --no-audit --no-fund && npm run dev); wait

clean:
	rm -rf .reproduce artifacts cache echidna-corpus crytic-export

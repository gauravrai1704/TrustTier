"""Run Slither with a deeper recursion limit.

slither's own main() caps recursion at 1,500 frames; the EZKL verifier with a
Poseidon-hashed weights instance has dominator chains deep enough to exceed
that while building SSA. Same arguments as `slither`:

    python scripts/slither_run.py .
"""
import sys
import threading

from slither.__main__ import get_detectors_and_printers, main_impl


def run():
    sys.setrecursionlimit(100_000)
    detectors, printers = get_detectors_and_printers()
    try:
        main_impl(all_detector_classes=detectors, all_printer_classes=printers)
    except SystemExit as e:  # propagate slither's exit code (non-zero on findings)
        run.code = e.code


run.code = 0
threading.stack_size(1024 * 1024 * 1024)  # deep recursion needs a large thread stack
t = threading.Thread(target=run)
t.start()
t.join()
sys.exit(run.code)

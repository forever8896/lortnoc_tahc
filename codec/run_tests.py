#!/usr/bin/env python3
"""
Codec test runner — stdlib only (pytest is not a dependency of this service, and the codec
is deliberately dependency-free apart from torch/transformers).

Collects BOTH styles present in this directory:

  * unittest.TestCase classes          (test_auth.py, test_server.py)
  * bare top-level `test_*` functions  (test_coder.py, test_codec.py)

The second style is the reason this file exists. Those two files predate the others and use
plain functions with asserts, which `python3 -m unittest discover` silently collects ZERO
tests from — so the coder's reversibility proof, arguably the single most important test in
the repo, was not running under any automated command. It ran only if someone remembered to
invoke `python3 test_coder.py` by hand.

Usage:
    ./run_tests.py                 # everything, wordmap backend (fast, no torch needed)
    CODEC_BACKEND=gpt2 ./run_tests.py   # exercise the real model (slow; needs torch)
    ./run_tests.py -v              # verbose
"""
import inspect
import os
import sys
import unittest

# Default to the dependency-free backend so the suite runs anywhere. The real model is
# exercised by the integration tier (test/integration) against a live service.
os.environ.setdefault("CODEC_BACKEND", "wordmap")
# Keep enforcement off at import time; the tests that need it flip auth.ENFORCE directly.
os.environ.pop("CODEC_ENFORCE", None)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

MODULES = ["test_coder", "test_codec", "test_auth", "test_server"]


def _wrap_function_tests(module_name):
    """Build a TestCase from a module's bare top-level `test_*` functions."""
    module = __import__(module_name)
    fns = [
        (name, obj)
        for name, obj in vars(module).items()
        if name.startswith("test_") and inspect.isfunction(obj) and obj.__module__ == module_name
    ]
    if not fns:
        return None

    ns = {}
    for name, fn in fns:
        # Bind via default arg so the loop variable is not captured by reference.
        def make(f=fn):
            def method(self):
                f()

            return method

        ns[name] = make()
    ns["__doc__"] = f"function-style tests collected from {module_name}.py"
    return type(f"{module_name}_functions", (unittest.TestCase,), ns)


def build_suite():
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    for name in MODULES:
        module = __import__(name)
        suite.addTests(loader.loadTestsFromModule(module))
        wrapper = _wrap_function_tests(name)
        if wrapper is not None:
            suite.addTests(loader.loadTestsFromTestCase(wrapper))
    return suite


if __name__ == "__main__":
    verbosity = 2 if "-v" in sys.argv else 1
    result = unittest.TextTestRunner(verbosity=verbosity).run(build_suite())
    sys.exit(0 if result.wasSuccessful() else 1)

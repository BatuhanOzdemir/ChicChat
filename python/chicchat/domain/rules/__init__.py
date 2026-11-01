"""The rule engine (SPEC.md §3) — pure, framework-free condition evaluation and
the `within_return_window` computed-field helper.
"""

from chicchat.domain.rules.evaluate import evaluate, evaluate_condition, evaluate_rules
from chicchat.domain.rules.types import Condition, Rule, RuleAction, RuleContext
from chicchat.domain.rules.validate import is_condition
from chicchat.domain.rules.window import is_within_return_window

__all__ = [
    "Condition",
    "Rule",
    "RuleAction",
    "RuleContext",
    "evaluate",
    "evaluate_condition",
    "evaluate_rules",
    "is_condition",
    "is_within_return_window",
]

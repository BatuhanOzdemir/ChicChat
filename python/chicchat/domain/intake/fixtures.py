"""A small intake config mirroring the seeded taxonomy — port of
intake/fixtures.ts. Used by the intake tests and as a worked example of the
config shape. Not imported by the app.
"""

from __future__ import annotations

from chicchat.domain.intake.types import IntakeConfig

DEMO_INTAKE_CONFIG: IntakeConfig = {
    "orderIdRegex": "^[A-Z0-9]{4,}$",
    "categories": [
        {
            "key": "return",
            "label": "Return request",
            "subcategories": [
                {"key": "changed_mind", "label": "Changed my mind"},
                {"key": "doesnt_fit", "label": "Doesn't fit"},
                {"key": "not_as_described", "label": "Not as described"},
            ],
            "fields": [
                {
                    "key": "order_number",
                    "type": "string",
                    "required": True,
                    "normalizeRule": "order_number",
                },
                {"key": "item_ref", "type": "ref", "required": True},
                {
                    "key": "reason",
                    "type": "enum",
                    "required": True,
                    "enumValues": [
                        "wrong_size",
                        "poor_quality",
                        "looks_different",
                        "changed_mind",
                        "arrived_late",
                        "other",
                    ],
                },
                {
                    "key": "condition",
                    "type": "enum",
                    "required": True,
                    "enumValues": ["unworn_tags_on", "worn_tags_removed"],
                },
            ],
        },
        {
            "key": "wrong_damaged_missing",
            "label": "Wrong / damaged / missing item",
            "subcategories": [
                {"key": "damaged", "label": "Damaged"},
                {"key": "defective", "label": "Defective"},
                {"key": "item_missing", "label": "Item missing from order"},
            ],
            "fields": [
                {
                    "key": "order_number",
                    "type": "string",
                    "required": True,
                    "normalizeRule": "order_number",
                },
                {"key": "item_ref", "type": "ref", "required": True},
                {"key": "photo", "type": "media", "required": True},
                {"key": "description", "type": "string", "required": True},
            ],
        },
        {
            "key": "other",
            "label": "Other / talk to a human",
            "subcategories": [],
            "fields": [
                {"key": "description", "type": "string", "required": True},
                {
                    "key": "order_number",
                    "type": "string",
                    "required": False,
                    "normalizeRule": "order_number",
                },
            ],
        },
    ],
}

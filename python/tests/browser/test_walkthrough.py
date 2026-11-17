"""The Port Step 5 browser walkthrough: every scenario the gate names, clicked
through a real browser. Run: `uv run pytest -m browser` (needs the `_test` DB)."""

from __future__ import annotations

import random
import uuid

from playwright.sync_api import Page


def fresh_phone() -> str:
    """A fake number nobody used before, so reruns never resume old state."""
    return f"90555{random.randint(10_000_00, 99_999_99)}"


def inspector_has(page: Page, text: str) -> None:
    page.wait_for_function(
        "t => document.querySelector('#inspector').textContent.includes(t)", arg=text
    )


def run_preset(page: Page, preset_id: str, phone: str) -> str:
    page.goto("/simulator")
    page.fill("#phone", phone)
    page.click(f'[data-preset="{preset_id}"]')
    page.wait_for_function("() => !document.querySelector('#reset').disabled")
    return page.text_content("#inspector") or ""


def say(page: Page, text: str, then: str) -> None:
    page.fill("#draft", text)
    page.click("#composer button")
    inspector_has(page, then)


def test_presets_complete_three_categories_and_replay_once(page: Page) -> None:
    assert '"order_number": "TR100432"' in run_preset(
        page, "messy_order_number", fresh_phone()
    )
    assert "media.sim.torn-seam" in run_preset(page, "photo_flow", fresh_phone())
    assert "Chino Trousers — Beige / 32" in run_preset(
        page, "flow_submission", fresh_phone()
    )
    run_preset(page, "duplicate_replay", fresh_phone())
    assert "duplicate delivery skipped" in (page.text_content("#transcript") or "")


def test_the_photo_preset_shows_its_private_evidence_on_the_case_page(
    page: Page,
) -> None:
    run_preset(page, "photo_flow", fresh_phone())
    console_link = page.get_attribute('#inspector a[href^="/console/"]', "href")
    assert console_link
    page.goto(console_link.replace("/console/", "/cases/"))
    width = page.eval_on_selector(
        'img[alt="Customer evidence"]',
        "i => new Promise(r => i.complete ? r(i.naturalWidth) : (i.onload = () => r(i.naturalWidth)))",
    )
    assert width > 0


def test_a_failed_delivery_can_be_retried(page: Page) -> None:
    page.goto("/simulator")
    page.fill("#phone", fresh_phone())
    page.select_option("#inject", "delivery_failure")
    say(page, "hello", "delivery is pending")
    page.click("#retry-delivery")
    inspector_has(page, "Retried delivery: 1 sent")
    assert "How can we help?" in (page.text_content("#transcript") or "")


def test_aging_nudges_once_keeps_choices_tappable_then_abandons(page: Page) -> None:
    page.goto("/simulator")
    page.fill("#phone", fresh_phone())

    def options() -> list[str]:
        found: list[str] = page.eval_on_selector_all(
            "#options button", "b => b.map(x => x.textContent)"
        )
        return found

    say(page, "hi", "selecting_category")
    say(page, "return", "selecting_subcategory")
    say(page, "doesnt_fit", "order_number")
    say(page, "TR100432", "item_ref")
    assert options() == []  # a text question replaces the old choices
    say(page, "blue shirt", "reason")
    page.click('[data-age="5"]')
    inspector_has(page, "nudged 1")
    assert "Still there?" in (page.text_content("#transcript") or "")
    assert "Wrong size" in options()  # the nudge does not hide the open question
    page.click('[data-age="1440"]')
    inspector_has(page, "abandoned 1")
    assert '"status": "abandoned"' in (page.text_content("#inspector") or "")
    assert options() == []  # stale choices go once the session ends


def _delete_walkthrough_categories() -> None:
    """Browser saves commit, so the test removes what it created: WhatsApp lists
    show at most 10 categories, and leftovers would push new ones off the menu."""
    from tests.db.conftest import connect

    with connect() as conn:
        conn.execute("delete from categories where label like 'Walk Şikâyet %'")


def test_a_custom_category_with_a_choice_field_works_and_drafts_survive(
    page: Page,
) -> None:
    _delete_walkthrough_categories()
    try:
        _custom_category_walkthrough(page)
    finally:
        _delete_walkthrough_categories()


def _custom_category_walkthrough(page: Page) -> None:
    # Under 24 characters: WhatsApp list rows cut longer titles (as in TypeScript).
    label = f"Walk Şikâyet {uuid.uuid4().hex[:6]}"
    page.goto("/config")
    policy = 'form[data-form-key="policy"] input[name="return_window_days"]'
    page.fill(policy, "47")  # an unsaved draft elsewhere on the page
    page.fill('form[data-form-key="add-category"] input[name="label"]', label)
    page.click('form[data-form-key="add-category"] button[type="submit"]')
    page.wait_for_selector(f"summary:has-text('{label}')")
    assert page.input_value(policy) == "47"
    details = page.locator("details", has_text=label)
    details.locator("summary").click()
    details.locator('form[data-form-key^="add-sub-"] input[name="label"]').fill(
        "Geç teslim"
    )
    details.locator('form[data-form-key^="add-sub-"] button').click()
    details = page.locator("details", has_text=label)
    details.locator("code", has_text="gec_teslim").wait_for()
    add_field = details.locator('form[data-form-key^="add-field-"]')
    add_field.locator('input[name="label"]').fill("Damage type")
    add_field.locator('select[name="type"]').select_option("enum")
    add_field.locator('textarea[name="enum_values"]').fill(
        "Torn seam\nStain\nBroken zip"
    )
    add_field.locator("button").click()
    details = page.locator("details", has_text=label)
    details.locator("button", has_text="Delete damage_type").wait_for()
    assert page.input_value(policy) == "47"

    page.goto("/simulator")
    page.fill("#phone", fresh_phone())
    say(page, "merhaba", "selecting_category")
    page.click(f'#options button:has-text("{label}")')
    inspector_has(page, "selecting_subcategory")
    page.click('#options button:has-text("Geç teslim")')
    inspector_has(page, "damage_type")
    page.click('#options button:has-text("Stain")')
    inspector_has(page, '"damage_type": "stain"')


def test_filters_and_console_status_changes(page: Page) -> None:
    run_preset(page, "photo_flow", fresh_phone())
    own_case = page.get_attribute('#inspector a[href^="/console/"]', "href")
    assert own_case
    page.goto("/cases?order_number=%23tr-100%20432")
    assert own_case.removeprefix("/console/") in (page.content() or "")
    page.goto("/console")
    assert own_case in page.content()
    page.goto(own_case)
    page.fill('form[action$="/status"] input[name="note"]', "walkthrough note")
    page.click('form[action$="/status"] button[value="in_progress"]')
    page.wait_for_load_state()
    history = page.text_content("main") or ""
    assert "walkthrough note" in history and "in_progress" in history

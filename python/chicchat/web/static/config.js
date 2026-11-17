// In-place saves for the configuration editor (port of config-form.tsx).
//
// Each <form class="config-form"> is sent in the background, so saving one
// section never throws away what the merchant typed elsewhere. After a save
// the page content is re-fetched, and every form the merchant had edited but
// not yet saved keeps its typed values in the fresh page (matched by its
// data-form-key). Without JavaScript, the same forms still work as ordinary
// posts that reload the page.
"use strict";

(function () {
  const dirty = new Set(); // data-form-key of forms with unsaved edits

  function csrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)chicchat_csrf=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function setStatus(form, text, isError) {
    const status = form.querySelector(".config-form-status");
    if (!status) return;
    status.hidden = !text;
    status.textContent = text || "";
    status.setAttribute("role", isError ? "alert" : "status");
  }

  // Copy the values the merchant typed into the same form in the new page.
  function copyValues(from, to) {
    for (const field of from.elements) {
      if (!field.name || field.type === "hidden") continue;
      const target = to.elements.namedItem(field.name);
      if (!target || target instanceof RadioNodeList) continue;
      if (field.type === "checkbox") target.checked = field.checked;
      else target.value = field.value;
    }
  }

  async function refresh(savedKey, resetSaved) {
    const response = await fetch(window.location.pathname + window.location.search, {
      headers: { Accept: "text/html" },
    });
    const html = await response.text();
    const fresh = new DOMParser().parseFromString(html, "text/html").getElementById("config-main");
    const current = document.getElementById("config-main");
    if (!fresh || !current) return;
    for (const form of current.querySelectorAll("form.config-form")) {
      const key = form.dataset.formKey;
      const replacement = fresh.querySelector(`form.config-form[data-form-key="${CSS.escape(key)}"]`);
      if (!replacement) continue; // the item was deleted
      const keepDraft = dirty.has(key) && !(key === savedKey && resetSaved);
      if (keepDraft && key !== savedKey) {
        copyValues(form, replacement);
        const status = replacement.querySelector(".config-form-status");
        if (status) {
          status.hidden = false;
          status.textContent = "Unsaved changes in this section.";
        }
      }
    }
    // Keep each category's open/closed state.
    for (const details of current.querySelectorAll("details[data-details-key]")) {
      const twin = fresh.querySelector(`details[data-details-key="${CSS.escape(details.dataset.detailsKey)}"]`);
      if (twin) twin.open = details.open;
    }
    current.replaceWith(fresh);
    dirty.delete(savedKey);
    bind(fresh);
    return fresh;
  }

  async function save(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.dataset.pending) return;
    form.dataset.pending = "1";
    // Collect the values first: disabled fields are left out of FormData.
    const body = new FormData(form);
    const fieldset = Array.from(form.elements);
    fieldset.forEach((el) => (el.disabled = true));
    setStatus(form, "Saving…", false);
    const key = form.dataset.formKey;
    const reset = form.hasAttribute("data-reset-on-success");
    try {
      const response = await fetch(form.action, {
        method: "POST",
        body,
        headers: { Accept: "application/json", "X-CSRF-Token": csrfToken() },
      });
      const result = await response.json();
      if (result.error) {
        delete form.dataset.pending;
        fieldset.forEach((el) => (el.disabled = false));
        setStatus(form, result.error, true);
        return;
      }
      const page = await refresh(key, reset);
      const saved = page && page.querySelector(`form.config-form[data-form-key="${CSS.escape(key)}"]`);
      if (saved) setStatus(saved, "Saved.", false);
    } catch (err) {
      delete form.dataset.pending;
      fieldset.forEach((el) => (el.disabled = false));
      setStatus(form, "Could not save. Your edits are still here; please try again.", true);
    }
  }

  function bind(root) {
    for (const form of root.querySelectorAll("form.config-form")) {
      form.addEventListener("submit", save);
      form.addEventListener("input", () => {
        dirty.add(form.dataset.formKey);
        setStatus(form, "Unsaved changes in this section.", false);
      });
      form.addEventListener("change", () => dirty.add(form.dataset.formKey));
    }
  }

  bind(document);
})();

/**
 * Turn an intake `Prompt` (Step 5) into a WhatsApp outbound message (SPEC §6).
 * Category/subcategory prompts become static interactive **List Messages** (the
 * "Listeyi Gör" pattern); field prompts become text; completion becomes a
 * summary. Respects WhatsApp's field-length caps.
 */
import type { Prompt } from "../intake";
import type { InboundMessage, ListRow, OutboundMessage } from "./types";

// WhatsApp caps: row title <= 24, description <= 72, button <= 20, header <= 60.
const TITLE_MAX = 24;
const DESC_MAX = 72;
const BUTTON = "View options";

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function humanize(key: string): string {
  return key.replace(/_/g, " ");
}

function toRows(options: { key: string; label: string }[]): ListRow[] {
  // Cap at 10 rows (WhatsApp limit); the taxonomy fits comfortably.
  return options.slice(0, 10).map((o) => {
    const row: ListRow = { id: o.key, title: truncate(o.label, TITLE_MAX) };
    if (o.label.length > TITLE_MAX)
      row.description = truncate(o.label, DESC_MAX);
    return row;
  });
}

function list(
  to: string,
  header: string,
  body: string,
  sectionTitle: string,
  options: { key: string; label: string }[],
): OutboundMessage {
  return {
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: truncate(header, 60) },
      body: { text: body },
      action: {
        button: BUTTON,
        sections: [
          { title: truncate(sectionTitle, TITLE_MAX), rows: toRows(options) },
        ],
      },
    },
  };
}

function text(to: string, body: string): OutboundMessage {
  return { to, type: "text", text: { body } };
}

/**
 * The single gentle resume prompt sent after `nudge_after_minutes` of silence
 * (SPEC §11). The spec's Turkish example reads "Devam etmek ister misiniz?
 * Kaldığınız yerden sürdürebiliriz."; copy here stays in the same language as
 * the rest of the bot's messages until localization is a first-class concern.
 */
export function nudgeMessage(to: string): OutboundMessage {
  return text(
    to,
    "Still there? We can pick up right where you left off — your answers are saved.",
  );
}

/**
 * Generic customer-facing failure message (SPEC §13): never leaks diagnostics,
 * and promises a human follow-up because the case may be incomplete.
 */
export function genericErrorMessage(to: string): OutboundMessage {
  return text(
    to,
    "Sorry — something went wrong on our side. An agent will follow up with you shortly.",
  );
}

/**
 * Render a message as the one line an agent reads in the transcript (SPEC §9).
 * A List Message becomes its question plus the options offered, because "which
 * choices did the customer actually see?" is the question agents ask most.
 */
export function outboundSummary(message: OutboundMessage): string {
  if (message.type === "text") return message.text.body;

  const { body, action } = message.interactive;
  const options = action.sections
    .flatMap((section) => section.rows.map((row) => row.title))
    .join(" · ");
  return options === "" ? body.text : `${body.text}\n[${options}]`;
}

/** The same, for what the customer sent. */
export function inboundSummary(message: InboundMessage): string {
  switch (message.kind) {
    case "interactive":
      return `tapped "${message.reply}"`;
    case "image":
      return `sent a photo (${message.mediaId ?? message.reply})`;
    case "flow":
      return `submitted a form: ${message.reply}`;
    default:
      return message.reply;
  }
}

export function promptToMessage(prompt: Prompt, to: string): OutboundMessage {
  switch (prompt.kind) {
    case "select_category":
      return list(
        to,
        "How can we help?",
        prompt.retry
          ? "Sorry, I didn't catch that. Please pick a topic:"
          : "Please pick a topic:",
        "Topics",
        prompt.options,
      );

    case "select_subcategory":
      return list(
        to,
        "A bit more detail",
        prompt.retry
          ? "Sorry, I didn't catch that. Please choose one:"
          : "Which best describes it?",
        "Options",
        prompt.options,
      );

    case "select_field": {
      // Enum fields are always tappable (SPEC §5) — the customer never guesses.
      const label = humanize(prompt.field.key);
      return list(
        to,
        label,
        prompt.retry
          ? `Please choose one of the options for ${label}:`
          : `Please choose your ${label}:`,
        "Options",
        prompt.options,
      );
    }

    case "request_field": {
      const prefix = prompt.retry ? "Sorry, that didn't look right. " : "";
      const body =
        prompt.field.type === "media"
          ? `${prefix}Please send a photo of the item.`
          : `${prefix}Please share your ${humanize(prompt.field.key)}.`;
      return text(to, body);
    }

    case "complete": {
      const c = prompt.case;
      const lines = [
        "✅ Thanks! We've logged your request:",
        `• Category: ${c.category}${c.subcategory ? ` / ${c.subcategory}` : ""}`,
        ...c.fields.map((f) => `• ${humanize(f.key)}: ${f.normalized ?? "—"}`),
        "",
        "An agent will follow up shortly.",
      ];
      return text(to, lines.join("\n"));
    }
  }
}

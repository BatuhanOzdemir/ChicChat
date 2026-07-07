/**
 * Local message simulator (CLAUDE.md Step 5) — drives the intake machine
 * without WhatsApp. Given a script (which category/subcategory to pick and an
 * answer per field key), it replays the conversation, recording every prompt
 * and which fields the machine actually asked for.
 */
import { advance, startIntake } from "./machine";
import type { IntakeCase, IntakeConfig, IntakeState, Prompt } from "./types";

export interface SimulationScript {
  /** Category selection message (key, label, or 1-based index). */
  category: string;
  /** Subcategory selection message (omit for categories with none). */
  subcategory?: string;
  /** Answer for each field key the machine may ask for. */
  fields: Record<string, string>;
  /** Fields a classifier already extracted (folded in, never asked). */
  initialFields?: Record<string, string>;
}

export interface SimulationResult {
  prompts: Prompt[];
  /** Field keys the machine requested (in order). */
  asked: string[];
  state: IntakeState;
  case?: IntakeCase;
}

const MAX_STEPS = 50;

export function simulateIntake(
  config: IntakeConfig,
  script: SimulationScript,
): SimulationResult {
  let session = startIntake(config, script.initialFields ?? {});
  const prompts: Prompt[] = [session.prompt];
  const asked: string[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const prompt = session.prompt;

    if (prompt.kind === "complete") {
      return { prompts, asked, state: session.state, case: prompt.case };
    }

    let message: string;
    if (prompt.kind === "select_category") {
      message = script.category;
    } else if (prompt.kind === "select_subcategory") {
      message = script.subcategory ?? "";
    } else {
      // request_field
      asked.push(prompt.field.key);
      if (!(prompt.field.key in script.fields)) break; // no scripted answer -> stop
      message = script.fields[prompt.field.key];
    }

    session = advance(config, session.state, message);
    prompts.push(session.prompt);
  }

  const last = session.prompt;
  return {
    prompts,
    asked,
    state: session.state,
    case: last.kind === "complete" ? last.case : undefined,
  };
}

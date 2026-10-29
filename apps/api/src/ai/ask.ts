import { can, effectiveScope, type Action, type Module } from '@worko/domain';
import type { z } from 'zod';
import type { RequestActor } from '../auth/context.js';

/**
 * "Ask with tools over permitted data" — the contract Phase 11's NL query builds on (D152). Not wired to any route yet.
 *
 * - A tool is a typed, read-only function the model may request; it runs AS THE ASKING USER, so it can only return rows
 *   that user could see through the normal API (each tool reuses the owning service's scoped list/report method).
 * - The model never sees the database: it proposes `{tool, input}`; the server validates the input with the tool's zod
 *   schema, runs it, redacts the result through `AiService.runModel`'s pipeline and feeds it back inside a <data> block.
 * - The final answer is a SUGGESTION (sources = every tool call + row ids it used). A report definition produced from it
 *   (Phase 11) is saved only when a human accepts it.
 */
export type AiTool<I = unknown, O = unknown> = {
  name: string;
  description: string;
  input: z.ZodType<I>;
  /** The permission the tool's data needs; tools the asker lacks are not offered to the model at all. */
  requires: { module: Module; action: Action };
  run(actor: RequestActor, input: I): Promise<{ rows: O[]; sourceIds: string[] }>;
};
export type AskRequest = { question: string; tools: AiTool[]; maxSteps?: number };
export type AskResult = { suggestionId: string; answer: string; toolCalls: Array<{ tool: string; input: unknown; rows: number }>; sources: string[] };

/** Only tools the actor may use (at any scope — row-level scope is the tool's own service query). */
export function permittedTools(actor: RequestActor, tools: AiTool[]): AiTool[] {
  return tools.filter((t) => actor.superAdmin || (effectiveScope(actor, t.requires.module, t.requires.action)?.scope ?? 'none') !== 'none' || can(actor, t.requires.module, t.requires.action));
}

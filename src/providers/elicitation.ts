/**
 * MCP form elicitation ↔ Exo's ask card: a `requestedSchema` becomes the
 * normalized questions the card renders, and the card's answers become the
 * typed `content` the schema asks for. Shared by the CLI adapters.
 */
import type { UserQuestion } from "./types";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function enumOptions(schema: Record<string, unknown>): { label: string }[] {
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.flatMap((value, index) => typeof value === "string"
      ? [{ label: typeof names[index] === "string" ? String(names[index]) : value }]
      : []);
  }
  const variants = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(record(schema.items).anyOf) ? record(schema.items).anyOf as unknown[] : [];
  return variants.flatMap((value) => {
    const option = record(value);
    return typeof option.const === "string"
      ? [{ label: typeof option.title === "string" ? option.title : option.const }]
      : [];
  });
}

export function elicitationQuestions(params: Record<string, unknown>): UserQuestion[] {
  const schema = record(params.requestedSchema);
  const properties = record(schema.properties);
  return Object.entries(properties).map(([id, raw]) => {
    const property = record(raw);
    const type = String(property.type ?? "string");
    const options = type === "boolean" ? [{ label: "Yes" }, { label: "No" }] : enumOptions(property);
    return {
      id,
      header: typeof property.title === "string" ? property.title : id,
      question: typeof property.description === "string"
        ? property.description
        : typeof params.message === "string" ? params.message : id,
      options,
      multiSelect: type === "array",
    };
  });
}

export function elicitationContent(
  params: Record<string, unknown>,
  answers: Record<string, string>,
): Record<string, unknown> {
  const properties = record(record(params.requestedSchema).properties);
  return Object.fromEntries(Object.entries(answers).map(([id, answer]): [string, unknown] => {
    const schema = record(properties[id]);
    const type = String(schema.type ?? "string");
    if (type === "boolean") return [id, answer === "Yes"];
    if (type === "number" || type === "integer") {
      const value = Number(answer);
      return [id, Number.isFinite(value) ? value : answer];
    }
    if (type === "array") return [id, answer.split(",").map((value) => value.trim()).filter(Boolean)];
    return [id, answer];
  }));
}

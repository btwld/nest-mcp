import type { Prompt } from "./control-plane-api";

export const MAX_PROMPT_ARGUMENTS = 64;
export const MAX_PROMPT_ARGUMENT_CHARACTERS = 16 * 1_024;
export const MAX_PROMPT_ARGUMENT_JSON_BYTES = 64 * 1_024;
export const PROMPT_ARGUMENT_ROOT_ERROR = "$";

export type PromptArgumentErrors = Readonly<Record<string, string>>;

export type PromptArgumentParseResult =
  | { readonly success: true; readonly data: Record<string, string> | undefined }
  | { readonly success: false; readonly errors: PromptArgumentErrors };

type PromptArgumentDefinition = NonNullable<Prompt["arguments"]>[number];

export function promptArgumentValueName(index: number): string {
  return `prompt-argument-${String(index)}-value`;
}

export function promptArgumentIncludedName(index: number): string {
  return `prompt-argument-${String(index)}-included`;
}

export function parsePromptArguments(
  prompt: { readonly arguments?: readonly PromptArgumentDefinition[] },
  formData: FormData,
): PromptArgumentParseResult {
  const definitions = prompt.arguments ?? [];
  if (definitions.length > MAX_PROMPT_ARGUMENTS) {
    return {
      success: false,
      errors: {
        [PROMPT_ARGUMENT_ROOT_ERROR]: `This prompt advertises more than ${String(MAX_PROMPT_ARGUMENTS)} arguments, so the bounded workbench cannot run it.`,
      },
    };
  }

  const errors: Record<string, string> = {};
  const output: Record<string, string> = Object.create(null) as Record<string, string>;
  const seenNames = new Set<string>();

  definitions.forEach((definition, index) => {
    const fieldKey = String(index);
    if (seenNames.has(definition.name)) {
      errors[fieldKey] = "The upstream prompt advertises this argument name more than once.";
      return;
    }
    seenNames.add(definition.name);

    const included =
      definition.required === true || formData.get(promptArgumentIncludedName(index)) === "true";
    if (!included) return;

    const rawValue = formData.get(promptArgumentValueName(index));
    if (typeof rawValue !== "string") {
      errors[fieldKey] =
        definition.required === true ? "This argument is required." : "Enter a text value.";
      return;
    }
    if (definition.required === true && rawValue.length === 0) {
      errors[fieldKey] = "This argument is required.";
      return;
    }
    if (rawValue.length > MAX_PROMPT_ARGUMENT_CHARACTERS) {
      errors[fieldKey] = "Use 16 KiB or fewer for this argument.";
      return;
    }
    Object.defineProperty(output, definition.name, {
      configurable: true,
      enumerable: true,
      value: rawValue,
      writable: true,
    });
  });

  if (Object.keys(errors).length > 0) return { success: false, errors };

  const data = Object.keys(output).length === 0 ? undefined : output;
  if (
    new TextEncoder().encode(JSON.stringify(data ?? {})).byteLength > MAX_PROMPT_ARGUMENT_JSON_BYTES
  ) {
    return {
      success: false,
      errors: {
        [PROMPT_ARGUMENT_ROOT_ERROR]: "Prompt arguments must fit within a 64 KiB request payload.",
      },
    };
  }

  return { success: true, data };
}

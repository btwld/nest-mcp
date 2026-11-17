import { describe, expect, it } from "vitest";

import {
  MAX_PROMPT_ARGUMENTS,
  MAX_PROMPT_ARGUMENT_CHARACTERS,
  PROMPT_ARGUMENT_ROOT_ERROR,
  parsePromptArguments,
  promptArgumentIncludedName,
  promptArgumentValueName,
} from "../lib/prompt-arguments";

const prompt = {
  arguments: [
    { name: "topic", required: true },
    { name: "audience", description: "Optional audience" },
  ],
} as const;

describe("parsePromptArguments", () => {
  it("preserves required and explicitly included optional text", () => {
    const formData = new FormData();
    formData.set(promptArgumentValueName(0), "MCP\nvalidation");
    formData.set(promptArgumentIncludedName(1), "true");
    formData.set(promptArgumentValueName(1), "library authors");

    expect(parsePromptArguments(prompt, formData)).toEqual({
      success: true,
      data: { topic: "MCP\nvalidation", audience: "library authors" },
    });
  });

  it("omits unchecked optional arguments and returns undefined for an empty prompt", () => {
    const formData = new FormData();
    formData.set(promptArgumentValueName(0), "MCP");
    formData.set(promptArgumentValueName(1), "ignored");

    expect(parsePromptArguments(prompt, formData)).toEqual({
      success: true,
      data: { topic: "MCP" },
    });
    expect(parsePromptArguments({}, new FormData())).toEqual({
      success: true,
      data: undefined,
    });
  });

  it("rejects missing required values, duplicate names, and oversized fields", () => {
    expect(parsePromptArguments(prompt, new FormData())).toEqual({
      success: false,
      errors: { "0": "This argument is required." },
    });

    const duplicateData = new FormData();
    duplicateData.set(promptArgumentValueName(0), "one");
    duplicateData.set(promptArgumentValueName(1), "two");
    expect(
      parsePromptArguments(
        {
          arguments: [
            { name: "same", required: true },
            { name: "same", required: true },
          ],
        },
        duplicateData,
      ),
    ).toEqual({
      success: false,
      errors: { "1": "The upstream prompt advertises this argument name more than once." },
    });

    const oversizedData = new FormData();
    oversizedData.set(promptArgumentValueName(0), "x".repeat(MAX_PROMPT_ARGUMENT_CHARACTERS + 1));
    expect(parsePromptArguments(prompt, oversizedData)).toEqual({
      success: false,
      errors: { "0": "Use 16 KiB or fewer for this argument." },
    });
  });

  it("bounds the number of rendered arguments and treats prototype names as data", () => {
    const excessive = {
      arguments: Array.from({ length: MAX_PROMPT_ARGUMENTS + 1 }, (_, index) => ({
        name: `argument-${String(index)}`,
      })),
    };
    expect(parsePromptArguments(excessive, new FormData())).toEqual({
      success: false,
      errors: {
        [PROMPT_ARGUMENT_ROOT_ERROR]: expect.stringContaining(String(MAX_PROMPT_ARGUMENTS)),
      },
    });

    const prototypeData = new FormData();
    prototypeData.set(promptArgumentValueName(0), "safe");
    const parsed = parsePromptArguments(
      { arguments: [{ name: "__proto__", required: true }] },
      prototypeData,
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data === undefined) return;
    expect(Object.hasOwn(parsed.data, "__proto__")).toBe(true);
    expect(parsed.data.__proto__).toBe("safe");
  });
});

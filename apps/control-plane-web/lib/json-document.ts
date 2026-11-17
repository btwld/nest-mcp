export type JsonFormatResult =
  | {
      readonly success: true;
      readonly value: string;
    }
  | {
      readonly success: false;
      readonly message: string;
    };

export function formatJsonDocument(value: string): JsonFormatResult {
  try {
    return {
      success: true,
      value: JSON.stringify(JSON.parse(value), null, 2),
    };
  } catch {
    return {
      success: false,
      message: "Fix the JSON syntax before formatting.",
    };
  }
}

export function stringifyJsonDocument(value: unknown, fallback: string): string {
  try {
    return JSON.stringify(value, null, 2) ?? fallback;
  } catch {
    return fallback;
  }
}

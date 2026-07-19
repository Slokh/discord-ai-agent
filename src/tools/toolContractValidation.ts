import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { toolByName, toolRegistry, type ToolName, type ToolRegistryEntry } from "./registry.js";
import type { AgentResponse } from "./types.js";
import type { AppConfig } from "../config/env.js";
import { toolForDeployment } from "./toolDeployment.js";

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const validators = new Map<ToolName, ValidateFunction>();
const deploymentValidators = new Map<string, ValidateFunction>();

export type ToolArgumentValidationResult =
  | { ok: true }
  | { ok: false; message: string; errors: ErrorObject[] };

export function validateToolCallArguments(input: {
  name: ToolName;
  arguments?: Record<string, unknown>;
  argumentsText: string;
  config?: AppConfig;
}): ToolArgumentValidationResult {
  if (!isJsonObject(input.argumentsText)) {
    return { ok: false, message: "arguments must be a valid JSON object", errors: [] };
  }
  const tool = toolByName(input.name);
  if (!tool) return { ok: false, message: `unknown tool ${input.name}`, errors: [] };
  const validator = input.config ? deploymentValidatorFor(tool, input.config) : validatorFor(tool);
  if (validator(input.arguments ?? {})) return { ok: true };
  const errors = validator.errors ? [...validator.errors] : [];
  return { ok: false, message: formatValidationErrors(errors), errors };
}

export function invalidToolCallResponse(input: {
  name: ToolName;
  arguments?: Record<string, unknown>;
  argumentsText: string;
  config?: AppConfig;
}): AgentResponse | null {
  const validation = validateToolCallArguments(input);
  if (validation.ok) return null;
  const example = validArgumentExample(input.name, input.config);
  return {
    content: [
      `Invalid arguments for ${input.name}: ${validation.message}.`,
      "Retry with arguments matching the advertised tool schema.",
      example ? `Canonical valid example: ${JSON.stringify(example)}` : "",
    ].filter(Boolean).join(" "),
    status: "error",
    errorCode: "invalid_tool_arguments",
    retryable: true,
  };
}

function deploymentValidatorFor(tool: ToolRegistryEntry, config: AppConfig): ValidateFunction {
  const key = `${tool.name}|wallet:${Boolean(config.payments?.userWalletsEnabled)}|premium:${(config.discord?.premiumSkuIds ?? []).join(",")}`;
  const existing = deploymentValidators.get(key);
  if (existing) return existing;
  const validator = ajv.compile(toolForDeployment(tool, config).parameters as object);
  deploymentValidators.set(key, validator);
  return validator;
}

/** Compile every contract eagerly in verification/tests so invalid schemas fail before a model call. */
export function assertToolRegistryContractsValid(): void {
  for (const tool of toolRegistry) {
    const validator = validatorFor(tool);
    for (const example of tool.argumentExamples) {
      if (!validator(example)) {
        throw new Error(`Invalid argument example for ${tool.name}: ${formatValidationErrors(validator.errors ? [...validator.errors] : [])}`);
      }
    }
  }
}

function validatorFor(tool: ToolRegistryEntry): ValidateFunction {
  const existing = validators.get(tool.name);
  if (existing) return existing;
  const validator = ajv.compile(tool.parameters as object);
  validators.set(tool.name, validator);
  return validator;
}

function validArgumentExample(name: ToolName, config?: AppConfig): Record<string, unknown> | undefined {
  const tool = toolByName(name);
  if (!tool) return undefined;
  const validator = config ? deploymentValidatorFor(tool, config) : validatorFor(tool);
  return tool.argumentExamples.find((example) => validator(example));
}

function isJsonObject(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

function formatValidationErrors(errors: ErrorObject[]): string {
  if (!errors.length) return "arguments do not match the tool contract";
  return errors.slice(0, 5).map((error) => {
    const path = error.instancePath || "/";
    return `${path} ${error.message ?? "is invalid"}`;
  }).join("; ");
}

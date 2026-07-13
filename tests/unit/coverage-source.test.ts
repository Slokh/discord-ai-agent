import { describe, expect, it } from "vitest";
import { isTypeOnlyTypescriptSource } from "../../scripts/coverageSource.js";

describe("isTypeOnlyTypescriptSource", () => {
  it("recognizes modules erased by TypeScript", () => {
    expect(
      isTypeOnlyTypescriptSource(`
        import type { AppConfig } from "./config.js";
        import { type Client, type Message } from "./api.js";
        export type Context = { config: AppConfig; client: Client };
        export interface Envelope { message: Message }
        export type { OtherContext };
        declare const compileTimeOnly: unique symbol;
      `)
    ).toBe(true);
  });

  it("keeps modules with executable values subject to coverage", () => {
    expect(isTypeOnlyTypescriptSource("export const limit = 20;")).toBe(false);
    expect(isTypeOnlyTypescriptSource('import "./register.js"; export type Value = string;')).toBe(false);
    expect(isTypeOnlyTypescriptSource('export { runtimeValue } from "./runtime.js";')).toBe(false);
  });
});

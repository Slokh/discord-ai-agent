import { describe, expect, it } from "vitest";
import { githubHeadingSlug } from "../../scripts/checkDocs.js";

describe("documentation checker", () => {
  it("matches GitHub-style heading anchors", () => {
    expect(githubHeadingSlug("Feature Recipes"))
      .toBe("feature-recipes");
    expect(githubHeadingSlug("Model-Led, Code-Governed"))
      .toBe("model-led-code-governed");
  });

  it("removes nested HTML-like tag text without recreating a tag", () => {
    expect(githubHeadingSlug("Use <span>Agent</span> Tools"))
      .toBe("use-agent-tools");
    expect(githubHeadingSlug("Safe <scr<script>ipt> Heading"))
      .toBe("safe-heading");
  });
});

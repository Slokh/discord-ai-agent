import { describe, expect, it } from "vitest";
import { renderTaskListPage, renderTaskTerminalPage } from "../../src/control/taskTerminalUi.js";

describe("task terminal UI", () => {
  it("renders the task list shell with the JSON endpoint", () => {
    const html = renderTaskListPage();

    expect(html).toContain("Agent Tasks");
    expect(html).toContain("/api/tasks?limit=100");
    expect(html).toContain("Needs Review");
  });

  it("renders a task page without allowing route text to break the script tag", () => {
    const html = renderTaskTerminalPage('task-1</script><script>alert("x")</script>');

    expect(html).toContain("Agent Task task-1&lt;/script&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain('window.AGENT_TASK_ID = "task-1\\u003c/script\\u003e\\u003cscript\\u003ealert(\\"x\\")\\u003c/script\\u003e"');
    expect(html).not.toContain('window.AGENT_TASK_ID = "task-1</script>');
  });
});

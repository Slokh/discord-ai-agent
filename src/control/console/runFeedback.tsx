import { useEffect, useState } from "react";
import { fetchRunFeedback, saveRunFeedback } from "./api.js";
import type { RunFeedback as Feedback } from "./types.js";

export function RunFeedback({ runId }: { runId: string }) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [rating, setRating] = useState<"good" | "bad">("good");
  const [note, setNote] = useState("");
  const [expectedBehavior, setExpectedBehavior] = useState("");
  const [failureMode, setFailureMode] = useState<Feedback["failureMode"]>(null);
  const [expectedTools, setExpectedTools] = useState("");
  const [forbiddenTools, setForbiddenTools] = useState("");
  const [mustContain, setMustContain] = useState("");
  const [mustNotContain, setMustNotContain] = useState("");
  const [captureEval, setCaptureEval] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    void fetchRunFeedback(runId).then((value) => {
      setFeedback(value);
      if (!value) return;
      setRating(value.rating);
      setNote(value.note ?? "");
      setExpectedBehavior(value.expectedBehavior ?? "");
      setFailureMode(value.failureMode);
      setExpectedTools(value.expectedTools.join("\n"));
      setForbiddenTools(value.forbiddenTools.join("\n"));
      setMustContain(value.mustContain.join("\n"));
      setMustNotContain(value.mustNotContain.join("\n"));
      setCaptureEval(value.captureEval);
    }).catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
  }, [runId]);

  async function submit() {
    setStatus("Saving…");
    try {
      const saved = await saveRunFeedback({
        runId, rating, note, expectedBehavior, failureMode, captureEval,
        expectedTools: lines(expectedTools), forbiddenTools: lines(forbiddenTools),
        mustContain: lines(mustContain), mustNotContain: lines(mustNotContain),
      });
      setFeedback(saved);
      setStatus("Saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className="panel feedback-panel" aria-label="Run feedback">
      <div className="panel-heading"><div className="panel-title"><h3>Feedback and eval capture</h3></div>{feedback && <span>updated {new Date(feedback.updatedAt).toLocaleString()}</span>}</div>
      <div className="feedback-rating">
        <button type="button" className={rating === "good" ? "active" : ""} onClick={() => setRating("good")}>Good run</button>
        <button type="button" className={rating === "bad" ? "active bad" : ""} onClick={() => setRating("bad")}>Bad run</button>
      </div>
      <label>Review note<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="What worked or failed?" /></label>
      <label>Expected behavior<textarea value={expectedBehavior} onChange={(event) => setExpectedBehavior(event.target.value)} placeholder="What should the agent have done?" /></label>
      <label>Failure mode<select value={failureMode ?? ""} onChange={(event) => setFailureMode((event.target.value || null) as Feedback["failureMode"])}><option value="">Not classified</option><option value="wrong_answer">Wrong answer</option><option value="unnecessary_refusal">Unnecessary refusal</option><option value="wrong_tool">Wrong tool</option><option value="missing_evidence">Missing evidence</option><option value="permission">Permission boundary</option><option value="delivery">Delivery</option><option value="latency">Latency</option><option value="other">Other</option></select></label>
      <div className="feedback-grid">
        <label>Expected tools (one per line)<textarea value={expectedTools} onChange={(event) => setExpectedTools(event.target.value)} /></label>
        <label>Forbidden tools (one per line)<textarea value={forbiddenTools} onChange={(event) => setForbiddenTools(event.target.value)} /></label>
        <label>Required answer phrases (one per line)<textarea value={mustContain} onChange={(event) => setMustContain(event.target.value)} /></label>
        <label>Forbidden answer phrases (one per line)<textarea value={mustNotContain} onChange={(event) => setMustNotContain(event.target.value)} /></label>
      </div>
      <label className="toggle-row"><input type="checkbox" checked={captureEval} onChange={(event) => setCaptureEval(event.target.checked)} /><span>Capture in the private eval export</span></label>
      <div className="feedback-actions"><button type="button" onClick={() => void submit()}>Save feedback</button><span>{status}</span></div>
    </section>
  );
}

function lines(value: string) {
  return [...new Set(value.split("\n").map((line) => line.trim()).filter(Boolean))];
}

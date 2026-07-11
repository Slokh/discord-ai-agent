import { useEffect, useState } from "react";
import { fetchRunFeedback, saveRunFeedback } from "./api.js";
import type { RunFeedback as Feedback } from "./types.js";

export function RunFeedback({ runId }: { runId: string }) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [rating, setRating] = useState<"good" | "bad">("good");
  const [note, setNote] = useState("");
  const [expectedBehavior, setExpectedBehavior] = useState("");
  const [captureEval, setCaptureEval] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    void fetchRunFeedback(runId).then((value) => {
      setFeedback(value);
      if (!value) return;
      setRating(value.rating);
      setNote(value.note ?? "");
      setExpectedBehavior(value.expectedBehavior ?? "");
      setCaptureEval(value.captureEval);
    }).catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
  }, [runId]);

  async function submit() {
    setStatus("Saving…");
    try {
      const saved = await saveRunFeedback({ runId, rating, note, expectedBehavior, captureEval });
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
      <label className="toggle-row"><input type="checkbox" checked={captureEval} onChange={(event) => setCaptureEval(event.target.checked)} /><span>Capture in the private eval export</span></label>
      <div className="feedback-actions"><button type="button" onClick={() => void submit()}>Save feedback</button><span>{status}</span></div>
    </section>
  );
}

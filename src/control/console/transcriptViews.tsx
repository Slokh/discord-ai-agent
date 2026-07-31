import { AlertCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchArtifact } from "./api.js";
import type { RunArtifact } from "./types.js";

export function TimelineArtifactInline({
  artifact,
}: {
  artifact: RunArtifact;
}) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    fetchArtifact(artifact.runId, artifact.artifactId)
      .then((nextContent) => {
        if (!disposed) setContent(nextContent);
      })
      .catch((loadError) => {
        if (!disposed)
          setError(
            loadError instanceof Error ? loadError.message : String(loadError),
          );
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [artifact.artifactId, artifact.runId]);

  return (
    <>
      {loading && (
        <span className="timeline-artifact-loading">
          Loading full artifact...
        </span>
      )}
      {error && (
        <div className="jump-error">
          <AlertCircle />
          <span>{error}</span>
        </div>
      )}
      <pre className="timeline-artifact-code">{content || artifact.preview}</pre>
    </>
  );
}

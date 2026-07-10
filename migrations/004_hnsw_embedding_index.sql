-- Replace the ivfflat embedding index with HNSW over halfvec (pgvector >= 0.8).
--
-- Why: ivfflat centroids are trained at index-creation time, so an index
-- created by migrations on an empty table clusters poorly forever. At ~640k
-- messages the full-precision ivfflat index was ~5 GB, could not stay cached
-- on small instances, and cold searches exceeded the vector search statement
-- timeout, silently degrading history search to keyword-only.
--
-- HNSW needs no training and handles incremental inserts well. Indexing the
-- halfvec (half-precision) cast roughly halves the index size with negligible
-- recall loss. Queries must use the same expression:
--   embedding::halfvec(1536) <=> $query::halfvec(1536)
CREATE INDEX IF NOT EXISTS message_embeddings_embedding_hnsw_idx
  ON message_embeddings
  USING hnsw ((embedding::halfvec(1536)) halfvec_cosine_ops);

DROP INDEX IF EXISTS message_embeddings_vector_idx;

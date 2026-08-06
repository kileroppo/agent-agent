import tempfile
import unittest
from pathlib import Path

from knowledge_index import KnowledgeIndex


class KnowledgeIndexTest(unittest.TestCase):
    def test_versioned_index_filters_access_scope_and_orders_cosine_similarity(self):
        with tempfile.TemporaryDirectory() as directory:
            index = KnowledgeIndex(Path(directory))
            result = index.upsert(
                name="acceptance",
                index_version="v1",
                chunk_version="paragraph-v1",
                model_revision="test-model",
                documents=[
                    {"id": "beijing", "text": "北京是中国首都", "accessScope": "local-private", "metadata": {"source": "a"}},
                    {"id": "fruit", "text": "香蕉是水果", "accessScope": "local-private", "metadata": {"source": "b"}},
                    {"id": "hidden", "text": "北京机密", "accessScope": "restricted", "metadata": {}},
                ],
                vectors=[[1.0, 0.0], [0.0, 1.0], [1.0, 0.0]],
            )
            self.assertEqual(result["documentCount"], 3)
            candidates = index.candidates(
                name="acceptance",
                index_version="v1",
                query_vector=[0.9, 0.1],
                access_scopes=["local-private"],
                top_k=5,
            )
            self.assertEqual([row["documentId"] for row in candidates], ["beijing", "fruit"])
            self.assertEqual(candidates[0]["metadata"], {"source": "a"})

    def test_rejects_version_drift_without_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            index = KnowledgeIndex(Path(directory))
            kwargs = {
                "name": "acceptance",
                "index_version": "v1",
                "chunk_version": "paragraph-v1",
                "model_revision": "test-model",
                "documents": [{"id": "one", "text": "content"}],
                "vectors": [[1.0]],
            }
            index.upsert(**kwargs)
            with self.assertRaisesRegex(ValueError, "metadata mismatch"):
                index.upsert(**{**kwargs, "index_version": "v2"})


if __name__ == "__main__":
    unittest.main()

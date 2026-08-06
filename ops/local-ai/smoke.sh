#!/bin/zsh
set -euo pipefail

readonly BASE_URL='http://127.0.0.1:18082'

jq -n '{capability:"text.generate",request_id:"ops-smoke-text",input:{prompt:"严格只输出：LOCAL_AI_OK"},options:{temperature:0,maxTokens:32}}' \
  | curl -fsS --max-time 180 -H 'content-type: application/json' -d @- "$BASE_URL/v1/invoke" \
  | jq -e '.result.text | contains("LOCAL_AI_OK")'

jq -n '{capability:"embedding.create",request_id:"ops-smoke-embedding",input:{texts:["北京是中国的首都。","中国的首都是北京。"]}}' \
  | curl -fsS --max-time 180 -H 'content-type: application/json' -d @- "$BASE_URL/v1/invoke" \
  | jq -e '.result.dimensions == 1024 and (.result.embeddings | length) == 2'

echo 'local AI smoke: ok'

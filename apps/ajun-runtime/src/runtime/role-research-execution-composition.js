import path from 'node:path';

import { RoutedPublicWebReader } from '../adapters/routed-public-web-reader.ts';
import { GithubSearch } from '../github-search.js';
import { GrokConsultMcpAdapter } from '../grok-consult-mcp-adapter.js';
import { HermesIntelResearchAdvisor } from '../hermes-intel-research-advisor.js';
import { HermesPublicComparisonAdvisor } from '../hermes-public-comparison-advisor.js';
import { HermesPublicSummaryAdvisor } from '../hermes-public-summary-advisor.js';
import { LocalGithubResearch } from '../local-github-research.js';
import { LocalIntelResearcher } from '../local-intel-researcher.js';
import { LocalPublicReport } from '../local-public-report.js';
import { PublicDynamicWebReader } from '../public-dynamic-web-reader.js';
import { PublicPdfReader } from '../public-pdf-reader.js';
import { PublicWebFetch } from '../public-web-fetch.js';
import { PublicWebSearch } from '../public-web-search.js';
import { PublicWebTransport } from '../public-web-transport.js';

export function createRoleResearchExecutionComposition({
  environment,
  hermesProfileRoot,
  taskRunEvents,
}) {
  const publicWebTransport = new PublicWebTransport();
  const publicWebStaticFetch = new PublicWebFetch({
    fetchImpl:(...args) => publicWebTransport.fetch(...args),
  });
  const publicWebSearch = new PublicWebSearch({
    fetchImpl:(...args) => publicWebTransport.fetch(...args),
  });
  const publicDynamicWebReader = new PublicDynamicWebReader();
  const publicWebFetch = new RoutedPublicWebReader({
    primary:publicWebStaticFetch,
    fallback:publicDynamicWebReader,
    eventStore:taskRunEvents,
  });
  const publicPdfReader = new PublicPdfReader({ transport:publicWebTransport });
  const githubSearch = new GithubSearch({
    fetchImpl:(...args) => publicWebTransport.fetch(...args),
  });
  const publicReport = new LocalPublicReport({
    publicWebFetch,
    publicWebSearch,
    comparisonAdvisor:new HermesPublicComparisonAdvisor(),
    refineAdvisor:new HermesPublicSummaryAdvisor(),
  });
  const githubResearch = new LocalGithubResearch({ githubSearch });
  const intelResearcher = new LocalIntelResearcher({
    publicWebFetch,
    publicWebSearch,
    githubSearch,
    publicReport,
    githubResearch,
    researchAdvisor:new HermesIntelResearchAdvisor({
      hermesHome:path.join(hermesProfileRoot, 'intel-researcher'),
    }),
    grokConsult:new GrokConsultMcpAdapter({ accessMode:environment.AGENT_ARMY_GROK_ACCESS }),
  });

  return {
    publicWebFetch,
    publicWebSearch,
    publicDynamicWebReader,
    publicPdfReader,
    githubSearch,
    publicReport,
    intelResearcher,
  };
}

import path from 'node:path';

import { RoutedPublicWebReader } from '../adapters/routed-public-web-reader.ts';
// @ts-expect-error -- transitional JS Adapter; removed with the public-source batch.
import { GithubSearch } from '../github-search.js';
// @ts-expect-error -- transitional JS Adapter; removed with the public-source batch.
import { GrokConsultMcpAdapter } from '../grok-consult-mcp-adapter.js';
// @ts-expect-error -- transitional JS Adapter; removed with the research-advisor batch.
import { HermesIntelResearchAdvisor } from '../hermes-intel-research-advisor.js';
// @ts-expect-error -- transitional JS Adapter; removed with the research-advisor batch.
import { HermesPublicComparisonAdvisor } from '../hermes-public-comparison-advisor.js';
// @ts-expect-error -- transitional JS Adapter; removed with the research-advisor batch.
import { HermesPublicSummaryAdvisor } from '../hermes-public-summary-advisor.js';
// @ts-expect-error -- transitional JS Module; removed with the research-execution batch.
import { LocalGithubResearch } from '../local-github-research.js';
// @ts-expect-error -- transitional JS Module; removed with the research-execution batch.
import { LocalIntelResearcher } from '../local-intel-researcher.js';
// @ts-expect-error -- transitional JS Module; removed with the research-execution batch.
import { LocalPublicReport } from '../local-public-report.js';
// @ts-expect-error -- transitional JS Adapter; removed with the public-source batch.
import { PublicDynamicWebReader } from '../public-dynamic-web-reader.js';
// @ts-expect-error -- transitional JS Adapter; removed with the public-source batch.
import { PublicPdfReader } from '../public-pdf-reader.js';
// @ts-expect-error -- transitional JS Adapter; removed with the public-source batch.
import { PublicWebFetch } from '../public-web-fetch.js';
// @ts-expect-error -- transitional JS Adapter; removed with the public-source batch.
import { PublicWebSearch } from '../public-web-search.js';
// @ts-expect-error -- transitional JS Adapter; removed with the public-source batch.
import { PublicWebTransport } from '../public-web-transport.js';
import type { RoleResearchExecutionCompositionInput } from './composition-contracts.ts';

export function createRoleResearchExecutionComposition({
  environment,
  hermesProfileRoot,
  taskRunEvents,
}: RoleResearchExecutionCompositionInput) {
  const publicWebTransport = new PublicWebTransport();
  const publicWebStaticFetch = new PublicWebFetch({
    fetchImpl:(...args: unknown[]) => publicWebTransport.fetch(...args),
  });
  const publicWebSearch = new PublicWebSearch({
    fetchImpl:(...args: unknown[]) => publicWebTransport.fetch(...args),
  });
  const publicDynamicWebReader = new PublicDynamicWebReader();
  const publicWebFetch = new RoutedPublicWebReader({
    primary:publicWebStaticFetch,
    fallback:publicDynamicWebReader,
    eventStore:taskRunEvents,
  });
  const publicPdfReader = new PublicPdfReader({ transport:publicWebTransport });
  const githubSearch = new GithubSearch({
    fetchImpl:(...args: unknown[]) => publicWebTransport.fetch(...args),
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

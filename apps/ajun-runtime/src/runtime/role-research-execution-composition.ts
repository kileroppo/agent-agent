import path from 'node:path';
import { RoutedPublicWebReader } from '../adapters/routed-public-web-reader.ts';
import { GithubSearch } from '../github-search.ts';
import { GrokConsultMcpAdapter } from '../grok-consult-mcp-adapter.ts';
import { HermesIntelResearchAdvisor } from '../hermes-intel-research-advisor.ts';
import { HermesPublicComparisonAdvisor } from '../hermes-public-comparison-advisor.ts';
import { HermesPublicSummaryAdvisor } from '../hermes-public-summary-advisor.ts';
import { LocalGithubResearch } from '../local-github-research.ts';
import { LocalIntelResearcher } from '../local-intel-researcher.ts';
import { LocalPublicReport } from '../local-public-report.ts';
import { PublicDynamicWebReader } from '../public-dynamic-web-reader.ts';
import { PublicPdfReader } from '../public-pdf-reader.ts';
import { PublicWebFetch } from '../public-web-fetch.ts';
import { PublicWebSearch } from '../public-web-search.ts';
import { PublicWebTransport } from '../public-web-transport.ts';
import type { RoleResearchExecutionCompositionInput } from './composition-contracts.ts';
export function createRoleResearchExecutionComposition({ environment, hermesProfileRoot, taskRunEvents, }: RoleResearchExecutionCompositionInput) {
    const publicWebTransport = new PublicWebTransport();
    const publicWebStaticFetch = new PublicWebFetch({
        fetchImpl: (...args: unknown[]) => (publicWebTransport.fetch as any)(...args),
    });
    const publicWebSearch = new PublicWebSearch({
        fetchImpl: (...args: unknown[]) => (publicWebTransport.fetch as any)(...args),
    });
    const publicDynamicWebReader = new PublicDynamicWebReader();
    const publicWebFetch = new RoutedPublicWebReader({
        primary: publicWebStaticFetch,
        fallback: publicDynamicWebReader,
        eventStore: taskRunEvents,
    });
    const publicPdfReader = new PublicPdfReader({ transport: publicWebTransport });
    const githubSearch = new GithubSearch({
        fetchImpl: (...args: unknown[]) => (publicWebTransport.fetch as any)(...args),
    });
    const publicReport = new LocalPublicReport({
        publicWebFetch,
        publicWebSearch,
        comparisonAdvisor: new HermesPublicComparisonAdvisor(),
        refineAdvisor: new HermesPublicSummaryAdvisor(),
    });
    const githubResearch = new LocalGithubResearch({ githubSearch });
    const intelResearcher = new LocalIntelResearcher({
        publicWebFetch,
        publicWebSearch,
        githubSearch,
        publicReport,
        githubResearch,
        researchAdvisor: new HermesIntelResearchAdvisor({
            hermesHome: path.join(hermesProfileRoot, 'intel-researcher'),
        }),
        grokConsult: new GrokConsultMcpAdapter({ accessMode: environment.AGENT_ARMY_GROK_ACCESS }),
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

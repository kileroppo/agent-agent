export async function createEnabledM5PaperclipSystemControl({
  governance,
  campaigns,
  publisherBindings,
  paperclipCurrentRunScope,
  paperclipHeartbeat,
}: any) {
  const [
    { HttpPaperclipAdapter },
    { PaperclipCampaignDailyHandler, PaperclipParallelWorkHandler },
    { PaperclipMetricMonitorHandler },
    { PaperclipPublisherController },
    { canonicalPaperclipHeartbeat, PaperclipPublisherRunContext },
    { PaperclipRetrospectiveHandler },
    { PaperclipLearningLifecycleHandler },
  ] = await Promise.all([
    import('@agent-army/m5-content-pipeline'),
    import('../paperclip-heartbeat.ts'),
    import('../paperclip-metric-monitor.ts'),
    import('../paperclip-publisher-controller.ts'),
    import('../paperclip-publisher-run-context.ts'),
    import('../paperclip-retrospective.ts'),
    import('../paperclip-learning-lifecycle.ts'),
  ]);
  const paperclipCampaignDaily = new PaperclipCampaignDailyHandler({
    governance,
    campaignActivator:async () => (await campaigns()).activateScheduledDay(),
  });
  const paperclipParallelWork = new PaperclipParallelWorkHandler({
    governance,
    reconcileParallelWork:async (caseId: unknown) => (await campaigns()).reconcileParallelWork(caseId),
  });
  const paperclipRunAuthenticationAdapter = {
    async authenticateRun(input: unknown) {
      const company = await governance.companyForRuntime();
      return new HttpPaperclipAdapter({
        apiBase:governance.baseUrl,
        companyId:company.id,
      }).authenticateRun(input);
    },
  };
  const paperclipPublisherRunContext = new PaperclipPublisherRunContext({
    paperclipAdapter:paperclipRunAuthenticationAdapter,
    governance,
    systemRole:'m5-publisher-controller',
  });
  const paperclipMetricRunContext = new PaperclipPublisherRunContext({
    paperclipAdapter:paperclipRunAuthenticationAdapter,
    governance,
    systemRole:'m5-metrics-controller',
  });

  return Object.freeze({
    paperclipHeartbeat,
    paperclipCampaignDaily,
    paperclipParallelWork,
    paperclipMetricRunContext,
    paperclipMetricMonitor:new PaperclipMetricMonitorHandler({
      governance,
      publisher:publisherBindings.publisher,
    }),
    paperclipCurrentRunScope,
    paperclipPublisherRunContext,
    paperclipPublisherController:new PaperclipPublisherController({
      governance,
      publisher:publisherBindings.publisher,
    }),
    paperclipRetrospective:new PaperclipRetrospectiveHandler({ governance }),
    paperclipLearningLifecycle:new PaperclipLearningLifecycleHandler({ governance }),
    canonicalPaperclipHeartbeat,
  });
}

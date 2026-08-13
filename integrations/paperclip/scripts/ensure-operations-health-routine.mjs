#!/usr/bin/env node

import { createPaperclipLoopbackClient } from './support/paperclip-loopback-client.mjs';
import { PaperclipOperationsHealthCatalog } from './support/paperclip-operations-health-catalog.mjs';

const BASE_URL = 'http://127.0.0.1:3100';
const COMPANY_NAME = 'Agent军团';

export async function ensureOperationsHealthRoutine({ fetchImpl = fetch } = {}) {
  const client = createPaperclipLoopbackClient({
    apiBase: BASE_URL,
    fetchImpl,
    operation: '本机健康巡检安排',
  });
  const catalog = new PaperclipOperationsHealthCatalog({ client, companyName:COMPANY_NAME });
  let company;
  try {
    company = await catalog.requireCompany();
  } catch (error) {
    if (error.message === `Paperclip 中未找到公司：${COMPANY_NAME}`) {
      throw new Error('Paperclip 中未找到 Agent军团。');
    }
    throw error;
  }

  const agents = await client.request('GET', `/api/companies/${company.id}/agents`);
  const controllerBody = catalog.controllerBody();
  let controller = catalog.findController(agents);
  const controllerCreated = !controller;
  controller ||= await client.request('POST', `/api/companies/${company.id}/agents`, {
    body: controllerBody,
  });
  if (controllerCreated || catalog.controllerNeedsUpdate(controller, controllerBody)) {
    controller = await client.request('PATCH', `/api/agents/${encodeURIComponent(controller.id)}`, {
      body: {
        ...(controllerCreated ? {} : controllerBody),
        status: 'idle',
      },
    });
  }

  const routines = await client.request('GET', `/api/companies/${company.id}/routines`);
  let routine = catalog.findRoutine(routines);
  const routineBody = catalog.routineBody(controller.id);
  const created = !routine;
  routine = routine
    ? await client.request('PATCH', `/api/routines/${encodeURIComponent(routine.id)}`, { body:routineBody })
    : await client.request('POST', `/api/companies/${company.id}/routines`, { body:routineBody });

  const detailed = Array.isArray(routine.triggers)
    ? routine
    : await client.request('GET', `/api/routines/${encodeURIComponent(routine.id)}`);
  let trigger = catalog.findTrigger(Array.isArray(detailed.triggers) ? detailed.triggers : []);
  const triggerBody = catalog.triggerBody();
  const triggerCreated = !trigger;
  trigger = trigger
    ? await client.request('PATCH', `/api/routine-triggers/${encodeURIComponent(trigger.id)}`, { body:triggerBody })
    : await client.request('POST', `/api/routines/${encodeURIComponent(routine.id)}/triggers`, {
      body: { kind:'schedule', ...triggerBody },
    });

  return {
    controller: {
      id: controller.id,
      created: controllerCreated,
      adapterType: 'http',
      url: controllerBody.adapterConfig.url,
    },
    created,
    triggerCreated,
    routine: {
      id: routine.id,
      title: routine.title || catalog.routine.title,
      status: routine.status || 'active',
    },
    trigger: {
      id: trigger.id,
      cronExpression: trigger.cronExpression || triggerBody.cronExpression,
      timezone: trigger.timezone || triggerBody.timezone,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureOperationsHealthRoutine()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
